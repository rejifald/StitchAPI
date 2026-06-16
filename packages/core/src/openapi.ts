// `stitch export --openapi` — emit an OpenAPI 3.1 document FROM a registry of stitches, so a
// declaration round-trips to a spec (ingestion stays on the roadmap; this is the emit half that
// makes "reversible" true). Server-side only: it reads the public `__config` of each stitch.
//
// STRUCTURAL by design. It emits paths, methods, operationIds, and the path/query parameters
// parsed from the RFC 6570 URL template, plus the PRESENCE of a request body and a response (as
// empty `{}` schemas). Field-level JSON Schema for bodies AND per-parameter schemas are filled
// only when a bring-your-own `toJsonSchema` converter is supplied — after `compose()` the
// input/output schemas are opaque Standard Schema `Validator`s, so turning them into JSON Schema
// needs a per-validator converter (the contract-not-dependency gate; core stays zero-dep). Without
// one, bodies and parameters stay `{}`. `components.securitySchemes` + per-operation `security` are
// emitted from each stitch's non-secret `authScheme` — the {@link SecurityScheme} that redaction
// projects onto `__config` from the live `auth` (the credential itself is stripped; a strategy with
// no declarable scheme, e.g. a jar-mode `cookieSession`, is simply left unannotated). Query/header
// parameters declared via an `input` SCHEMA (rather than the URL template) are still not enumerated.
// A stitch whose endpoint is a thunk (resolved at call time) cannot be exported statically; it is
// reported as a warning, never dropped silently.
import type { StitchRegistry } from './registry';
import { isStandardSchema } from './standard-schema';
import type { SecurityScheme, StitchConfig } from './types';

export interface OpenApiInfo {
    title: string;
    version: string;
}
export interface OpenApiParameter {
    name: string;
    in: 'path' | 'query' | 'header';
    required: boolean;
    schema: Record<string, unknown>;
}
export interface OpenApiMediaType {
    schema: Record<string, unknown>;
}
export interface OpenApiResponse {
    description: string;
    content?: Record<string, OpenApiMediaType>;
}
// A Security Requirement Object: the scheme name → the scopes it needs (`[]` for non-oauth2).
export type OpenApiSecurityRequirement = Record<string, string[]>;
export interface OpenApiOperation {
    operationId: string;
    summary?: string;
    parameters?: OpenApiParameter[];
    requestBody?: { content: Record<string, OpenApiMediaType> };
    responses: Record<string, OpenApiResponse>;
    security?: OpenApiSecurityRequirement[];
}
export interface OpenApiComponents {
    securitySchemes?: Record<string, SecurityScheme>;
}
export interface OpenApiDocument {
    openapi: '3.1.0';
    info: OpenApiInfo;
    servers?: { url: string }[];
    paths: Record<string, Record<string, OpenApiOperation>>;
    components?: OpenApiComponents;
}
export interface OpenApiExportOptions {
    title?: string;
    version?: string;
    /**
     * Bring-your-own Standard Schema → JSON Schema converter (the contract-not-dependency gate:
     * core stays zero-dep, the way `axiosAdapter` takes your axios). When provided, request and
     * response BODY schemas come from the stitch's `input.body` / `output` schemas, and the
     * `params` / `query` object schemas are converted then DECOMPOSED into a JSON Schema per
     * URL-template parameter (instead of `{}`). It receives the raw schema (a `Validator`'s
     * `.source`) plus the slot and the detected Standard Schema `vendor`; return a JSON Schema
     * object, or `undefined` to fall back to `{}`. For `params` / `query` the converter is called
     * once on the whole object schema; its `properties[name]` becomes each parameter's schema.
     */
    toJsonSchema?: (
        source: unknown,
        info: {
            slot: 'body' | 'response' | 'params' | 'query';
            vendor?: string;
        },
    ) => Record<string, unknown> | undefined;
}
export interface OpenApiExportResult {
    document: OpenApiDocument;
    warnings: string[];
}

// An empty schema (`{}` = "any") — the fallback when no converter is supplied or a slot has no
// recoverable source schema.
const EMPTY_SCHEMA: Record<string, unknown> = {};

// A Validator carries its raw schema on a non-enumerable `.source` (validator.ts); pull it out so a
// converter can turn it into JSON Schema. Anything else (a DriftSpec, a sourceless validator) → none.
function sourceOf(slot: unknown): unknown {
    return slot && typeof slot === 'object' && 'source' in slot
        ? (slot as { source?: unknown }).source
        : undefined;
}

// A body/response schema: the converted JSON Schema when a converter and a recoverable source exist,
// else `{}`. The Standard Schema vendor (when detectable) is passed through so a converter can
// dispatch (e.g. only handle `zod`).
function bodySchema(
    slot: unknown,
    where: 'body' | 'response',
    convert: OpenApiExportOptions['toJsonSchema'],
): Record<string, unknown> {
    if (!convert) return EMPTY_SCHEMA;
    const source = sourceOf(slot);
    if (source === undefined) return EMPTY_SCHEMA;
    const vendor = isStandardSchema(source)
        ? source['~standard'].vendor
        : undefined;
    return (
        convert(source, {
            slot: where,
            ...(vendor !== undefined ? { vendor } : {}),
        }) ?? EMPTY_SCHEMA
    );
}

// Convert a `params`/`query` INPUT object schema ONCE, then expose its `properties` map + the set
// of `required` names so each URL-template parameter can be handed its own JSON Schema (OpenAPI
// models a schema per parameter, not one object). No converter, no recoverable source, or a
// non-object/propertyless result → empty (parameters keep `{}`).
function decomposeParamObject(
    slot: unknown,
    where: 'params' | 'query',
    convert: OpenApiExportOptions['toJsonSchema'],
): { properties: Record<string, unknown>; required: Set<string> } {
    const empty = { properties: {}, required: new Set<string>() };
    if (!convert) return empty;
    const source = sourceOf(slot);
    if (source === undefined) return empty;
    const vendor = isStandardSchema(source)
        ? source['~standard'].vendor
        : undefined;
    const converted = convert(source, {
        slot: where,
        ...(vendor !== undefined ? { vendor } : {}),
    });
    if (!converted || typeof converted !== 'object') return empty;
    const props = (converted as { properties?: unknown }).properties;
    const req = (converted as { required?: unknown }).required;
    return {
        properties:
            props && typeof props === 'object'
                ? (props as Record<string, unknown>)
                : {},
        required: new Set(
            Array.isArray(req)
                ? req.filter((x): x is string => typeof x === 'string')
                : [],
        ),
    };
}

// Fill each URL-template parameter's `schema` (and refine a query param's `required`) from the
// decomposed `input.params` / `input.query` object schemas. Path params stay required. Mutates in
// place; a no-op without a converter, so parameters keep their `{}` default.
function fillParamSchemas(
    parameters: OpenApiParameter[],
    cfg: StitchConfig,
    convert: OpenApiExportOptions['toJsonSchema'],
): void {
    if (!convert || !parameters.length) return;
    const path = decomposeParamObject(cfg.input?.params, 'params', convert);
    const query = decomposeParamObject(cfg.input?.query, 'query', convert);
    for (const p of parameters) {
        const from = p.in === 'query' ? query : path;
        const schema = from.properties[p.name];
        if (schema && typeof schema === 'object')
            p.schema = schema as Record<string, unknown>;
        if (p.in === 'query' && from.required.has(p.name)) p.required = true;
    }
}

const BODY_CONTENT_TYPE: Record<
    NonNullable<StitchConfig['bodyType']>,
    string
> = {
    json: 'application/json',
    form: 'application/x-www-form-urlencoded',
    multipart: 'multipart/form-data',
};

// Resolve a stitch's endpoint to a single string. `url` (string) is the whole endpoint; otherwise
// `baseUrl` + `path` are joined — and when there is no `baseUrl`, `path` carries the whole endpoint
// (the `stitch('https://…')` string form composes to `path`). A thunk `url`/`baseUrl` is resolved
// at call time and cannot be exported statically.
// `null` = nothing to export; `{ thunk: true }` = endpoint resolved at call time (unexportable).
type ResolvedEndpoint = { value: string } | { thunk: true } | null;

function endpointOf(cfg: StitchConfig): ResolvedEndpoint {
    if (typeof cfg.url === 'function' || typeof cfg.baseUrl === 'function')
        return { thunk: true };
    if (typeof cfg.url === 'string') return { value: cfg.url };
    const base =
        typeof cfg.baseUrl === 'string' ? cfg.baseUrl.replace(/\/+$/, '') : '';
    const path = cfg.path ?? '';
    if (!base && !path) return null;
    if (!base) return { value: path };
    if (!path) return { value: base };
    return { value: base + (path.startsWith('/') ? path : `/${path}`) };
}

// Split "https://host/rest" into a server origin + path; a relative endpoint has no server.
function splitServer(endpoint: string): { server?: string; path: string } {
    const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)(\/.*)?$/i.exec(endpoint);
    if (m) {
        const server = m[1];
        const path = m[2] ?? '/';
        return server ? { server, path } : { path };
    }
    return { path: endpoint.startsWith('/') ? endpoint : `/${endpoint}` };
}

// Classify one RFC 6570 expression ({+x}, {?q,sort}, {id:3}, {list*}) into its bare variable names
// and where it sits: operators `?`/`&` are query parameters, everything else is in the path.
function classifyExpr(expr: string): {
    names: string[];
    where: 'path' | 'query';
} {
    const op = expr.charAt(0);
    const where: 'path' | 'query' = op === '?' || op === '&' ? 'query' : 'path';
    const body = '+#./;?&'.includes(op) ? expr.slice(1) : expr;
    const names = body
        .split(',')
        .map((s) => s.replace(/[:*].*$/, '').trim())
        .filter(Boolean);
    return { names, where };
}

// Turn an endpoint path template into an OpenAPI path key + the parameters it declares. Path-
// position vars become `{name}` placeholders; query-position vars are pulled out as query
// parameters. A trailing literal `?a=b` (query defaults) is dropped (not yet modelled).
function parsePath(rawPath: string): {
    path: string;
    parameters: OpenApiParameter[];
} {
    const parameters: OpenApiParameter[] = [];
    let path = rawPath.replace(/\{([^{}]+)\}/g, (_full, expr: string) => {
        const { names, where } = classifyExpr(expr);
        for (const name of names)
            parameters.push({
                name,
                in: where,
                required: where === 'path',
                schema: EMPTY_SCHEMA,
            });
        return where === 'path' ? names.map((n) => `{${n}}`).join('') : '';
    });
    const q = path.indexOf('?'); // any leftover is a literal query string (templates removed above)
    if (q >= 0) path = path.slice(0, q);
    return { path: path || '/', parameters };
}

function buildOperation(
    cfg: StitchConfig,
    operationId: string,
    parameters: OpenApiParameter[],
    convert: OpenApiExportOptions['toJsonSchema'],
): OpenApiOperation {
    fillParamSchemas(parameters, cfg, convert);
    const op: OpenApiOperation = {
        operationId,
        responses:
            cfg.output != null
                ? {
                      '200': {
                          description: 'OK',
                          content: {
                              'application/json': {
                                  schema: bodySchema(
                                      cfg.output,
                                      'response',
                                      convert,
                                  ),
                              },
                          },
                      },
                  }
                : { '200': { description: 'OK' } },
    };
    if (cfg.name) op.summary = cfg.name;
    if (parameters.length) op.parameters = parameters;
    // `__config.kind` is the surface id string (graphql posts a `{ query, variables }` body).
    const kindRaw: unknown = cfg.kind;
    const isGraphql = kindRaw === 'graphql';
    if (cfg.input?.body != null || isGraphql) {
        const contentType = BODY_CONTENT_TYPE[cfg.bodyType ?? 'json'];
        op.requestBody = {
            content: {
                [contentType]: {
                    schema: bodySchema(cfg.input?.body, 'body', convert),
                },
            },
        };
    }
    return op;
}

// A friendly base name for a scheme's `components.securitySchemes` key. Distinct schemes that
// collide on a base name get a numeric suffix at registration time (`registerScheme`).
function securityKeyBase(s: SecurityScheme): string {
    if (s.type === 'http')
        return s.scheme === 'basic' ? 'basicAuth' : 'bearerAuth';
    if (s.type === 'apiKey') return 'apiKeyAuth';
    return 'oauth2';
}

// The scopes a Security Requirement lists for a scheme: the oauth2 client-credentials scopes, or
// `[]` for http/apiKey (which take no scopes).
function scopesOf(s: SecurityScheme): string[] {
    return s.type === 'oauth2'
        ? Object.keys(s.flows.clientCredentials?.scopes ?? {})
        : [];
}

/**
 * Build an OpenAPI 3.1 document from a {@link StitchRegistry}. Pure and deterministic (no clock,
 * no I/O), so it round-trips and tests cleanly. Returns the document plus warnings for anything it
 * could not represent (thunk endpoints, duplicate path+method, multiple servers) — never a silent
 * drop.
 */
export function toOpenApi(
    registry: StitchRegistry,
    opts: OpenApiExportOptions = {},
): OpenApiExportResult {
    const warnings: string[] = [];
    const paths: OpenApiDocument['paths'] = {};
    const servers = new Set<string>();

    // `components.securitySchemes`, deduped: identical schemes (by structural signature) share one
    // entry; distinct schemes that want the same friendly name get a numeric suffix. Returns the
    // component key to reference from an operation's `security`.
    const securitySchemes: Record<string, SecurityScheme> = {};
    const keyBySignature = new Map<string, string>();
    const registerScheme = (s: SecurityScheme): string => {
        const sig = JSON.stringify(s);
        const seen = keyBySignature.get(sig);
        if (seen !== undefined) return seen;
        const base = securityKeyBase(s);
        let key = base;
        for (let n = 2; key in securitySchemes; n++) key = `${base}${n}`;
        securitySchemes[key] = s;
        keyBySignature.set(sig, key);
        return key;
    };

    for (const [key, stitch] of Object.entries(registry)) {
        const cfg = stitch.__config;
        const endpoint = endpointOf(cfg);
        if (endpoint === null) {
            warnings.push(`skipped "${key}": no url/baseUrl/path to export`);
            continue;
        }
        if ('thunk' in endpoint) {
            warnings.push(
                `skipped "${key}": endpoint is a thunk (resolved at call time), not a static string`,
            );
            continue;
        }
        const { server, path: rawPath } = splitServer(endpoint.value);
        if (server) servers.add(server);
        const { path, parameters } = parsePath(rawPath);
        const method = (cfg.method ?? 'get').toLowerCase();
        const item = (paths[path] ??= {});
        if (item[method]) {
            warnings.push(
                `skipped "${key}": duplicate ${method.toUpperCase()} ${path} (already mapped)`,
            );
            continue;
        }
        const op = buildOperation(cfg, key, parameters, opts.toJsonSchema);
        // `authScheme` is the non-secret SecurityScheme redaction projects onto `__config` from the
        // live `auth` (which is itself stripped). Present → register it + reference it per-operation.
        const authScheme = (cfg as { authScheme?: SecurityScheme }).authScheme;
        if (authScheme) {
            const schemeKey = registerScheme(authScheme);
            op.security = [{ [schemeKey]: scopesOf(authScheme) }];
        }
        item[method] = op;
    }

    const document: OpenApiDocument = {
        openapi: '3.1.0',
        info: {
            title: opts.title ?? 'StitchAPI export',
            version: opts.version ?? '0.0.0',
        },
        paths,
    };
    const serverList = [...servers].sort();
    if (serverList.length)
        document.servers = serverList.map((url) => ({ url }));
    if (serverList.length > 1)
        warnings.push(
            `${serverList.length} distinct servers across stitches; OpenAPI applies \`servers\` document-wide, so per-path origins are ambiguous`,
        );
    if (Object.keys(securitySchemes).length)
        document.components = { securitySchemes };
    return { document, warnings };
}
