// `stitch gen openapi` — turn a SELECTED set of operations from an OpenAPI document into ejected,
// ready-to-own stitch source (ADR 0013). PURE and deterministic: `planGen` reads a parsed document
// and returns the files to write; the CLI (cli.ts) handles argv, reading the spec, and writing.
//
// CLI-only: imported solely by cli.ts, never by src/index.ts — so it never enters the core or
// browser bundle. Core stays zero-dep and validator-agnostic.
//
// v1 scope (ADR 0013 resolutions): `--validator types-only` (default; emits TS types + a typed
// `stitch<T>()`, no runtime schema), `--layout dir|flat`, selection by `--tag`/`--only`/`--grep`/
// `--all`, fan-in ownership (private vs `_shared/`) computed over the transitive `$ref` closure —
// which keeps a recursive cluster together for free (every op that reaches one cycle member reaches
// all of them, so they share a fan-in). Auth/throttle/pagination gaps are emitted as `// TODO`.

// ---- OpenAPI structural subset (we read defensively; never trust the shape) ----

/** A JSON-Schema-ish node as it appears in an OpenAPI document. Intentionally loose. */
export interface SchemaNode {
    $ref?: string;
    type?: string | string[];
    format?: string;
    enum?: unknown[];
    const?: unknown;
    items?: SchemaNode;
    properties?: Record<string, SchemaNode>;
    required?: string[];
    additionalProperties?: boolean | SchemaNode;
    allOf?: SchemaNode[];
    oneOf?: SchemaNode[];
    anyOf?: SchemaNode[];
    nullable?: boolean;
    description?: string;
}

interface ParameterObject {
    name?: string;
    in?: string; // 'path' | 'query' | 'header' | 'cookie'
    required?: boolean;
    schema?: SchemaNode;
    $ref?: string;
}

interface MediaTypeObject {
    schema?: SchemaNode;
}

interface RequestBodyObject {
    required?: boolean;
    content?: Record<string, MediaTypeObject>;
}

interface ResponseObject {
    content?: Record<string, MediaTypeObject>;
}

interface OperationObject {
    operationId?: string;
    tags?: string[];
    summary?: string;
    description?: string;
    parameters?: ParameterObject[];
    requestBody?: RequestBodyObject;
    responses?: Record<string, ResponseObject>;
    security?: Record<string, unknown>[];
}

interface SecuritySchemeObject {
    type?: string; // 'http' | 'apiKey' | 'oauth2' | 'openIdConnect'
    scheme?: string; // 'bearer' | 'basic' (when type === 'http')
    in?: string; // 'header' | 'query' | 'cookie' (when type === 'apiKey')
    name?: string; // header/query name (when type === 'apiKey')
}

export interface OpenApiDoc {
    openapi?: string;
    info?: { title?: string; version?: string };
    servers?: { url?: string }[];
    paths?: Record<string, unknown>;
    components?: {
        schemas?: Record<string, SchemaNode>;
        securitySchemes?: Record<string, SecuritySchemeObject>;
    };
    security?: Record<string, unknown>[];
}

const HTTP_METHODS = [
    'get',
    'put',
    'post',
    'delete',
    'patch',
    'options',
    'head',
    'trace',
] as const;

// ---- options & result -----------------------------------------------------

export interface GenOptions {
    /** ADR 0013 Q2: default `types-only` (no runtime validation; loud notice). */
    validator?: 'types-only' | 'valibot' | 'zod';
    /** ADR 0013 Q3: default `dir`. `single` is not implemented in v1. */
    layout?: 'dir' | 'flat';
    /** Filters (ADR 0013 Decision 2). `all` overrides the others. */
    only?: string[]; // operationIds (or derived names)
    tags?: string[];
    grep?: string; // substring match on the path
    all?: boolean;
}

export interface GenFile {
    /** Path relative to the output directory. */
    path: string;
    contents: string;
}

interface SelectedOp {
    name: string; // TS identifier / export name
    method: string; // upper-case
    path: string;
    tag?: string;
    op: OperationObject;
}

export interface GenResult {
    files: GenFile[];
    /** `.stitch-gen.json` payload (ADR 0013 Decision 9). */
    manifest: unknown;
    selected: { name: string; method: string; path: string; tag?: string }[];
    warnings: string[];
    notices: string[];
}

// ---- identifier / case helpers --------------------------------------------

function words(s: string): string[] {
    return s
        .replace(/[{}]/g, ' ')
        .replace(/[^A-Za-z0-9]+/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

function toCamel(s: string): string {
    const w = words(s);
    if (w.length === 0) return 'op';
    return w
        .map((x, i) =>
            i === 0
                ? x.toLowerCase()
                : x.charAt(0).toUpperCase() + x.slice(1).toLowerCase(),
        )
        .join('');
}

function toPascal(s: string): string {
    const c = toCamel(s);
    return c.charAt(0).toUpperCase() + c.slice(1);
}

function toKebab(s: string): string {
    const w = words(s);
    return w.length ? w.map((x) => x.toLowerCase()).join('-') : 'item';
}

// ECMAScript reserved words + module keywords. Any of these emitted bare as an export name
// (`export const delete = …` / `export { delete }`) is a SyntaxError, so they get the same
// `op`+Pascal prefix as an invalid first char.
const RESERVED_WORDS = new Set<string>([
    // reserved words (ES2015+)
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'debugger',
    'default',
    'delete',
    'do',
    'else',
    'enum',
    'export',
    'extends',
    'false',
    'finally',
    'for',
    'function',
    'if',
    'import',
    'in',
    'instanceof',
    'new',
    'null',
    'return',
    'super',
    'switch',
    'this',
    'throw',
    'true',
    'try',
    'typeof',
    'var',
    'void',
    'while',
    'with',
    // strict-mode / contextual reserved
    'let',
    'static',
    'yield',
    'await',
    'implements',
    'interface',
    'package',
    'private',
    'protected',
    'public',
]);

function safeIdent(s: string): string {
    const c = toCamel(s);
    if (!/^[A-Za-z_$]/.test(c) || RESERVED_WORDS.has(c))
        return `op${toPascal(c)}`;
    return c;
}

// Operation name (ADR 0013 Q4): sanitized operationId, else camelCase(method + path).
function operationName(
    method: string,
    path: string,
    op: OperationObject,
): string {
    if (op.operationId?.trim()) return safeIdent(op.operationId);
    return safeIdent(`${method} ${path}`);
}

// ---- $ref resolution (local only; ADR 0013 Q1) ----------------------------

// Resolve a local `#/components/schemas/Name` ref to its component NAME, or null for anything else
// (external/remote refs are out of scope and surfaced as a warning by the caller).
function refName(ref: string): string | null {
    const m = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
    return m ? (m[1] as string) : null;
}

// ---- schema → TS type expression ------------------------------------------

interface TypeCtx {
    /** Component names referenced by the rendered expression (for imports). */
    used: Set<string>;
    /** External/remote refs we could not resolve (warned, rendered `unknown`). */
    unresolved: Set<string>;
}

function tsType(
    schema: SchemaNode | undefined,
    ctx: TypeCtx,
    depth = 0,
): string {
    if (!schema || depth > 30) return 'unknown';

    if (schema.$ref) {
        const name = refName(schema.$ref);
        if (name === null) {
            ctx.unresolved.add(schema.$ref);
            return 'unknown';
        }
        ctx.used.add(name);
        return toPascal(name);
    }

    const nullable = schema.nullable === true;
    const wrap = (t: string): string => (nullable ? `${t} | null` : t);

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        return wrap(schema.enum.map((v) => JSON.stringify(v)).join(' | '));
    }
    if (schema.const !== undefined) return wrap(JSON.stringify(schema.const));

    if (Array.isArray(schema.allOf) && schema.allOf.length) {
        return wrap(
            schema.allOf
                .map((s) => `(${tsType(s, ctx, depth + 1)})`)
                .join(' & '),
        );
    }
    const union = schema.oneOf ?? schema.anyOf;
    if (Array.isArray(union) && union.length) {
        return wrap(
            union.map((s) => `(${tsType(s, ctx, depth + 1)})`).join(' | '),
        );
    }

    const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
    switch (type) {
        case 'string':
            return wrap('string');
        case 'integer':
        case 'number':
            return wrap('number');
        case 'boolean':
            return wrap('boolean');
        case 'null':
            return 'null';
        case 'array':
            return wrap(`Array<${tsType(schema.items, ctx, depth + 1)}>`);
        case 'object':
        default: {
            if (schema.properties) {
                const required = new Set(schema.required ?? []);
                const props = Object.entries(schema.properties).map(
                    ([k, v]) => {
                        const opt = required.has(k) ? '' : '?';
                        return `${propKey(k)}${opt}: ${tsType(v, ctx, depth + 1)}`;
                    },
                );
                let body = `{ ${props.join('; ')} }`;
                const ap = schema.additionalProperties;
                if (ap && typeof ap === 'object') {
                    body = `${body} & Record<string, ${tsType(ap, ctx, depth + 1)}>`;
                }
                return wrap(props.length ? body : 'Record<string, unknown>');
            }
            const ap = schema.additionalProperties;
            if (ap && typeof ap === 'object')
                return wrap(`Record<string, ${tsType(ap, ctx, depth + 1)}>`);
            if (type === 'object') return wrap('Record<string, unknown>');
            return 'unknown';
        }
    }
}

function propKey(k: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
}

// Single-quoted string literal for emitted source (matches the ecosystem's prettier default).
// Spec text is UNTRUSTED: a raw newline (LF, CR, U+2028, U+2029) inside a `'...'` literal is an
// unterminated-string SyntaxError (denial-of-build), so every line terminator is escaped too.
function q(s: string): string {
    return `'${s
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(
            /[\u2028\u2029]/g,
            (m) => `\\u${m.charCodeAt(0).toString(16)}`,
        )}'`;
}

// Neutralize UNTRUSTED spec text destined for a generated `//` (or `/* */`) comment. A raw newline
// would end the comment and let the remainder of the string become top-level TS that RUNS when the
// developer compiles the generated file (build-time RCE). Collapse every line terminator (LF, CR,
// U+2028, U+2029) to a space and defang the block-comment terminator so text can't escape a comment.
function comment(s: string): string {
    return s.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\*\//g, '* /');
}

// Strip HTTP basic-auth userinfo (`user:pass@`) from a URL before it is emitted into a file the
// user commits — the README promises "the secret is never emitted". Returns the sanitized URL and
// whether credentials were removed. Falls back to a regex for non-absolute/relative server URLs
// that `URL` rejects.
function stripUserinfo(url: string): { url: string; stripped: boolean } {
    try {
        const u = new URL(url);
        if (u.username || u.password) {
            u.username = '';
            u.password = '';
            return { url: u.toString(), stripped: true };
        }
        return { url, stripped: false };
    } catch {
        // Relative / template server URLs (e.g. `/api`, `{scheme}://…`) aren't absolute URLs.
        // Match an authority userinfo (`scheme://user:pass@host`) textually and drop it.
        const m = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@]*@(.*)$/.exec(url);
        if (m) return { url: `${m[1]}${m[2]}`, stripped: true };
        return { url, stripped: false };
    }
}

// Direct component refs reachable from a schema node (one hop into the doc's component graph).
function directRefs(schema: SchemaNode | undefined, acc: Set<string>): void {
    if (!schema) return;
    if (schema.$ref) {
        const n = refName(schema.$ref);
        if (n) acc.add(n);
        return;
    }
    directRefs(schema.items, acc);
    for (const v of Object.values(schema.properties ?? {})) directRefs(v, acc);
    if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === 'object'
    )
        directRefs(schema.additionalProperties, acc);
    for (const s of schema.allOf ?? []) directRefs(s, acc);
    for (const s of schema.oneOf ?? []) directRefs(s, acc);
    for (const s of schema.anyOf ?? []) directRefs(s, acc);
}

// ---- planning -------------------------------------------------------------

export function planGen(doc: OpenApiDoc, opts: GenOptions = {}): GenResult {
    const warnings: string[] = [];
    const notices: string[] = [];
    const validator = opts.validator ?? 'types-only';
    const layout = opts.layout ?? 'dir';

    if (validator !== 'types-only') {
        warnings.push(
            `validator "${validator}" is not implemented in v1; emitting types-only`,
        );
    }
    notices.push(
        'validator: types-only — runtime validation + drift are OFF. Re-run with --validator valibot|zod once those tiers ship.',
    );

    const components = doc.components?.schemas ?? {};
    const securitySchemes = doc.components?.securitySchemes ?? {};
    // Strip any `user:pass@` from the server URL BEFORE it reaches a file the user commits or a
    // warning message — the secret is never emitted (README contract).
    const rawBaseUrl = doc.servers?.[0]?.url;
    let baseUrl = rawBaseUrl;
    if (rawBaseUrl !== undefined) {
        const s = stripUserinfo(rawBaseUrl);
        baseUrl = s.url;
        if (s.stripped)
            warnings.push(
                'stripped embedded credentials from the server URL; set client.ts auth via env() instead of committing them',
            );
    }
    if ((doc.servers?.length ?? 0) > 1)
        warnings.push(
            `spec has ${doc.servers?.length} servers; used the first (${baseUrl}). Edit client.ts to switch.`,
        );

    // 1. Enumerate every operation.
    const all: SelectedOp[] = [];
    const usedNames = new Set<string>();
    for (const [path, item] of Object.entries(doc.paths ?? {})) {
        if (typeof item !== 'object' || item === null) continue;
        const methods = item as Record<string, unknown>;
        for (const method of HTTP_METHODS) {
            const raw = methods[method];
            if (typeof raw !== 'object' || raw === null) continue;
            const op = raw as OperationObject;
            let name = operationName(method.toUpperCase(), path, op);
            // ADR 0013 Q4 collision rule: stable suffix by document order.
            if (usedNames.has(name)) {
                let n = 2;
                while (usedNames.has(`${name}_${n}`)) n++;
                warnings.push(
                    `name collision: "${name}" → "${name}_${n}" (rename it)`,
                );
                name = `${name}_${n}`;
            }
            usedNames.add(name);
            const tag = op.tags?.[0];
            all.push({
                name,
                method: method.toUpperCase(),
                path,
                ...(tag ? { tag } : {}),
                op,
            });
        }
    }

    // 2. Select.
    const selected = all.filter((o) => matches(o, opts));
    if (selected.length === 0) {
        warnings.push(
            'no operations selected — pass --all, --tag <t>, --only <id>, or --grep <substr>',
        );
        return {
            files: [],
            manifest: emptyManifest(validator, layout),
            selected: [],
            warnings,
            notices,
        };
    }

    // 3. Transitive component closure per selected op.
    const memo = new Map<string, Set<string>>();
    const closureOf = (name: string): Set<string> => {
        const cached = memo.get(name);
        if (cached) return cached;
        const out = new Set<string>();
        memo.set(name, out); // guard cycles
        const direct = new Set<string>();
        directRefs(components[name], direct);
        for (const d of direct) {
            out.add(d);
            for (const t of closureOf(d)) out.add(t);
        }
        return out;
    };

    const opUses = new Map<SelectedOp, Set<string>>();
    for (const o of selected) {
        const roots = new Set<string>();
        for (const s of opSchemas(o.op)) directRefs(s, roots);
        const full = new Set<string>(roots);
        for (const r of roots) for (const t of closureOf(r)) full.add(t);
        opUses.set(o, full);
    }

    // 4. Fan-in → ownership. opCount over the transitive closure keeps cycles together.
    const importers = new Map<string, SelectedOp[]>();
    for (const [o, uses] of opUses)
        for (const c of uses) {
            let arr = importers.get(c);
            if (!arr) {
                arr = [];
                importers.set(c, arr);
            }
            arr.push(o);
        }

    const placement = new Map<
        string,
        { shared: boolean; owner?: SelectedOp }
    >();
    for (const [c, imps] of importers) {
        if (!components[c]) {
            warnings.push(
                `referenced component "${c}" not found in components.schemas`,
            );
            continue;
        }
        const owner = imps[0];
        placement.set(
            c,
            imps.length >= 2 || !owner
                ? { shared: true }
                : { shared: false, owner },
        );
    }

    // 5. Emit.
    const files: GenFile[] = [];
    const auth = deriveAuth(doc, securitySchemes, warnings);
    files.push(emitClient(baseUrl, auth));

    const fileOfComponent = (c: string): { import: string; path: string } => {
        const p = placement.get(c);
        const kebab = toKebab(c);
        if (p?.shared)
            return { import: `_shared/${kebab}`, path: `_shared/${kebab}.ts` };
        const owner = p?.owner;
        if (!owner)
            return { import: `_shared/${kebab}`, path: `_shared/${kebab}.ts` };
        if (layout === 'flat')
            return { import: `_OWN_${owner.name}`, path: '' }; // inlined
        return {
            import: `${dirOf(owner)}/${kebab}`,
            path: `${dirOf(owner)}/${kebab}.ts`,
        };
    };

    // Component type files (shared + dir-layout private get their own file).
    const schemaManifest: {
        name: string;
        file: string;
        shared: boolean;
        importers: string[];
        refs: string[];
    }[] = [];
    for (const [c, p] of placement) {
        const schema = components[c];
        if (!schema) continue;
        const ctx: TypeCtx = { used: new Set(), unresolved: new Set() };
        const expr = tsType(schema, ctx, 0);
        ctx.used.delete(c); // self-ref handled by the named alias
        for (const u of ctx.unresolved)
            warnings.push(`unresolved $ref "${u}" in component ${c} → unknown`);
        const refs = [...ctx.used];
        const imps = (importers.get(c) ?? []).map((o) => o.name);
        const loc = fileOfComponent(c);
        const inlinedFlatPrivate = layout === 'flat' && !p.shared && !!p.owner;
        if (!inlinedFlatPrivate) {
            files.push({
                path: loc.path,
                contents: typeFileSource(
                    c,
                    expr,
                    refs,
                    fileOfComponent,
                    loc.path,
                ),
            });
        }
        schemaManifest.push({
            name: c,
            file:
                inlinedFlatPrivate && p.owner
                    ? `${dirOf(p.owner)}.ts (inlined)`
                    : loc.path,
            shared: p.shared,
            importers: imps,
            refs,
        });
    }

    // Operation files.
    for (const o of selected) {
        files.push(
            emitOperation(o, {
                layout,
                placement,
                components,
                fileOfComponent,
                warnings,
            }),
        );
    }

    // index.ts re-exports.
    files.push(emitIndex(selected, layout));

    // 6. Manifest (ADR 0013 Decision 9).
    const manifest = {
        generator: 'stitch gen openapi',
        validator,
        layout,
        operations: selected.map((o) => ({
            name: o.name,
            method: o.method,
            path: o.path,
            ...(o.tag ? { tag: o.tag } : {}),
            file:
                layout === 'flat'
                    ? `${toKebab(o.name)}.ts`
                    : `${dirOf(o)}/index.ts`,
            uses: [...(opUses.get(o) ?? [])],
        })),
        schemas: schemaManifest,
    };
    files.push({
        path: '.stitch-gen.json',
        contents: `${JSON.stringify(manifest, null, 2)}\n`,
    });

    return {
        files,
        manifest,
        selected: selected.map((o) => ({
            name: o.name,
            method: o.method,
            path: o.path,
            ...(o.tag ? { tag: o.tag } : {}),
        })),
        warnings,
        notices,
    };
}

// ---- selection ------------------------------------------------------------

function matches(o: SelectedOp, opts: GenOptions): boolean {
    if (opts.all) return true;
    const hasFilter =
        (opts.tags?.length ?? 0) > 0 ||
        (opts.only?.length ?? 0) > 0 ||
        (opts.grep?.length ?? 0) > 0;
    if (!hasFilter) return false; // selective by default: require an explicit selector
    if (opts.tags?.length && o.tag && opts.tags.includes(o.tag)) return true;
    if (opts.only?.length) {
        if (opts.only.includes(o.name)) return true;
        if (o.op.operationId && opts.only.includes(o.op.operationId))
            return true;
    }
    if (opts.grep && o.path.includes(opts.grep)) return true;
    return false;
}

// ---- per-operation schema roots -------------------------------------------

function opSchemas(op: OperationObject): SchemaNode[] {
    const out: SchemaNode[] = [];
    for (const p of op.parameters ?? []) if (p.schema) out.push(p.schema);
    const reqJson = op.requestBody?.content?.['application/json']?.schema;
    if (reqJson) out.push(reqJson);
    const rs = successResponseSchema(op);
    if (rs) out.push(rs);
    return out;
}

function successResponseSchema(op: OperationObject): SchemaNode | undefined {
    const responses = op.responses ?? {};
    const key =
        ['200', '201', '202', '2XX', 'default'].find((k) => responses[k]) ??
        Object.keys(responses)[0];
    if (!key) return undefined;
    return responses[key]?.content?.['application/json']?.schema;
}

// ---- emission -------------------------------------------------------------

function dirOf(o: SelectedOp): string {
    return toKebab(o.name);
}

// Relative import specifier FROM one generated file TO a component's module.
function relImport(fromPath: string, toModule: string): string {
    const fromDir = fromPath.includes('/')
        ? fromPath.slice(0, fromPath.lastIndexOf('/'))
        : '';
    let rel = relativePath(fromDir, toModule);
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return rel;
}

function relativePath(fromDir: string, toModule: string): string {
    const from = fromDir ? fromDir.split('/') : [];
    const to = toModule.split('/');
    let i = 0;
    while (i < from.length && i < to.length && from[i] === to[i]) i++;
    const ups = from.slice(i).map(() => '..');
    const downs = to.slice(i);
    const parts = [...ups, ...downs];
    return parts.join('/');
}

function typeFileSource(
    name: string,
    expr: string,
    refs: string[],
    fileOfComponent: (c: string) => { import: string; path: string },
    selfPath: string,
): string {
    const imports = refs
        .filter((r) => r !== name)
        .map((r) => {
            const loc = fileOfComponent(r);
            const spec = relImport(selfPath, loc.import);
            return `import type { ${toPascal(r)} } from '${spec}';`;
        });
    const head = imports.length ? `${imports.join('\n')}\n\n` : '';
    return `${head}export type ${toPascal(name)} = ${expr};\n`;
}

function emitClient(baseUrl: string | undefined, auth: DerivedAuth): GenFile {
    const named = ['seam', ...auth.imports];
    const lines: string[] = [];
    lines.push(`import { ${named.join(', ')} } from 'stitchapi';`);
    lines.push('');
    lines.push(
        '// Generated by `stitch gen openapi`. This file is yours to edit (eject model).',
    );
    lines.push('export const client = seam({');
    if (baseUrl) lines.push(`    baseUrl: ${q(baseUrl)},`);
    else lines.push(`    // TODO: set baseUrl (no \`servers\` in the spec)`);
    if (auth.expr) lines.push(`    auth: ${auth.expr},`);
    lines.push('    // TODO: tune shared resilience, e.g.');
    lines.push('    // retry: { attempts: 3, on: [429, 502, 503] },');
    lines.push("    // throttle: { rate: '10/s', pool: 'host' },");
    lines.push('});');
    return { path: 'client.ts', contents: `${lines.join('\n')}\n` };
}

interface EmitOpCtx {
    layout: 'dir' | 'flat';
    placement: Map<string, { shared: boolean; owner?: SelectedOp }>;
    components: Record<string, SchemaNode>;
    fileOfComponent: (c: string) => { import: string; path: string };
    warnings: string[];
}

function emitOperation(o: SelectedOp, ctx: EmitOpCtx): GenFile {
    const selfPath =
        ctx.layout === 'flat'
            ? `${toKebab(o.name)}.ts`
            : `${dirOf(o)}/index.ts`;

    // Response type for the stitch<T> generic.
    const respSchema = successResponseSchema(o.op);
    const tctx: TypeCtx = { used: new Set(), unresolved: new Set() };
    const respExpr = respSchema ? tsType(respSchema, tctx) : 'unknown';
    for (const u of tctx.unresolved)
        ctx.warnings.push(
            `unresolved $ref "${u}" in ${o.name} response → unknown`,
        );

    // Imports: shared/private component types this operation references (response + inlined privates).
    const typeImports = new Map<string, string>(); // pascal name → spec
    const inlinedPrivate: string[] = []; // flat layout: private type sources to inline

    const wantType = (comp: string): void => {
        const p = ctx.placement.get(comp);
        if (ctx.layout === 'flat' && p && !p.shared) {
            // inline the private component (and its private transitive closure). Any SHARED
            // component it transitively references still needs an `import type` in this file,
            // else the inlined `type` refers to an undeclared name (TS2304).
            collectInlinePrivate(
                comp,
                ctx,
                inlinedPrivate,
                new Set(),
                selfPath,
                typeImports,
            );
            return;
        }
        const loc = ctx.fileOfComponent(comp);
        typeImports.set(toPascal(comp), relImport(selfPath, loc.import));
    };
    for (const u of tctx.used) wantType(u);

    const clientSpec = ctx.layout === 'flat' ? './client' : '../client';
    const lines: string[] = [];
    lines.push(`import { client } from '${clientSpec}';`);
    for (const [pascal, spec] of typeImports)
        lines.push(`import type { ${pascal} } from '${spec}';`);
    lines.push('');
    if (inlinedPrivate.length) {
        lines.push(
            '// --- types private to this operation (delete this file, they go too) ---',
        );
        lines.push(...inlinedPrivate);
        lines.push('');
    }
    if (o.op.summary) lines.push(`// ${comment(o.op.summary)}`);
    lines.push(`// ${o.method} ${comment(o.path)}`);

    const cfg: string[] = [];
    cfg.push(`    path: ${q(o.path)},`);
    if (o.method !== 'GET') cfg.push(`    method: ${q(o.method)},`);
    const queryParams = (o.op.parameters ?? [])
        .filter((p) => p.in === 'query')
        .map((p) => p.name)
        .filter((n): n is string => typeof n === 'string')
        .map(comment);
    if (queryParams.length)
        cfg.push(
            `    // query params: ${queryParams.join(', ')} — pass them in the call's \`query\``,
        );
    if (o.op.requestBody?.content?.['application/json'])
        cfg.push(`    bodyType: 'json',`);

    lines.push(`export const ${o.name} = client.stitch<${respExpr}>({`);
    lines.push(...cfg);
    lines.push('});');
    return { path: selfPath, contents: `${lines.join('\n')}\n` };
}

// For flat layout: render a private component (and any private components it references) as inline
// `type` declarations, so deleting the operation file deletes them too. Transitive refs that are
// NOT inlined here (shared components — and dir-layout private ones) are added to `typeImports`
// so the inlined `type`s resolve, instead of being silently dropped.
function collectInlinePrivate(
    comp: string,
    ctx: EmitOpCtx,
    out: string[],
    seen: Set<string>,
    selfPath: string,
    typeImports: Map<string, string>,
): void {
    if (seen.has(comp)) return;
    seen.add(comp);
    const schema = ctx.components[comp];
    if (!schema) return;
    const tctx: TypeCtx = { used: new Set(), unresolved: new Set() };
    const expr = tsType(schema, tctx);
    out.push(`type ${toPascal(comp)} = ${expr};`);
    for (const u of tctx.used) {
        if (u === comp) continue;
        const p = ctx.placement.get(u);
        if (p && !p.shared) {
            collectInlinePrivate(u, ctx, out, seen, selfPath, typeImports);
        } else {
            // Shared component (or an unplaced ref → shared file): import it, don't inline.
            const loc = ctx.fileOfComponent(u);
            typeImports.set(toPascal(u), relImport(selfPath, loc.import));
        }
    }
}

function emitIndex(selected: SelectedOp[], layout: 'dir' | 'flat'): GenFile {
    const lines = ["export { client } from './client';"];
    for (const o of selected) {
        const spec =
            layout === 'flat' ? `./${toKebab(o.name)}` : `./${dirOf(o)}`;
        lines.push(`export { ${o.name} } from '${spec}';`);
    }
    return { path: 'index.ts', contents: `${lines.join('\n')}\n` };
}

// ---- auth derivation ------------------------------------------------------

interface DerivedAuth {
    expr?: string;
    imports: string[];
}

function deriveAuth(
    doc: OpenApiDoc,
    schemes: Record<string, SecuritySchemeObject>,
    warnings: string[],
): DerivedAuth {
    const requirement = doc.security?.[0];
    const schemeName = requirement
        ? Object.keys(requirement)[0]
        : Object.keys(schemes)[0];
    if (!schemeName) return { imports: [] };
    const scheme = schemes[schemeName];
    if (!scheme) return { imports: [] };

    if (scheme.type === 'http' && scheme.scheme === 'bearer')
        return { expr: `bearer(env('API_TOKEN'))`, imports: ['bearer', 'env'] };
    if (scheme.type === 'http' && scheme.scheme === 'basic')
        return {
            expr: `basic({ user: env('API_USER'), pass: env('API_PASSWORD') })`,
            imports: ['basic', 'env'],
        };
    if (
        scheme.type === 'apiKey' &&
        (scheme.in === 'header' ||
            scheme.in === 'query' ||
            scheme.in === undefined)
    ) {
        // Core's `apiKey()` only has header (default) and query arms — `name` locates the key in
        // both. Header is the default, so `in: 'header'` is never emitted; a query scheme gets the
        // `in: 'query'` discriminant. An `in: 'cookie'` scheme has no arm, so it must NOT land here
        // (it would silently become a header key) — it falls through to the not-auto-mapped warning.
        const where = scheme.in === 'query' ? `in: 'query', ` : '';
        const nm = scheme.name ? `name: ${JSON.stringify(scheme.name)}, ` : '';
        return {
            expr: `apiKey({ ${where}${nm}value: env('API_KEY') })`,
            imports: ['apiKey', 'env'],
        };
    }
    warnings.push(
        `security scheme "${schemeName}" (type ${scheme.type ?? '?'}) not auto-mapped — set client.ts auth manually`,
    );
    return { imports: [] };
}

// ---- misc -----------------------------------------------------------------

function emptyManifest(validator: string, layout: string): unknown {
    return {
        generator: 'stitch gen openapi',
        validator,
        layout,
        operations: [],
        schemas: [],
    };
}
