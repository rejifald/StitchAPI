// `stitch export --openapi` — emit an OpenAPI 3.1 document FROM a registry of stitches, so a
// declaration round-trips to a spec (ingestion stays on the roadmap; this is the emit half that
// makes "reversible" true). Server-side only: it reads the public `__config` of each stitch.
//
// STRUCTURAL by design. It emits paths, methods, operationIds, and the path/query parameters
// parsed from the RFC 6570 URL template, plus the PRESENCE of a request body and a response (as
// empty `{}` schemas). It deliberately does NOT emit field-level JSON Schema: after `compose()`
// the input/output schemas are opaque Standard Schema `Validator`s, so turning them into JSON
// Schema needs a per-validator converter — deferred to a future `stitchapi/jsonschema` contract
// (mirroring the fingerprint packages). `securitySchemes` are deferred with the separate decision
// to surface a non-sensitive auth kind on `__config` (today `auth` is stripped). Query/header
// parameters declared via an `input` SCHEMA (rather than the URL template) are likewise not
// enumerable here. A stitch whose endpoint is a thunk (resolved at call time) cannot be exported
// statically; it is reported as a warning, never dropped silently.
import type { StitchRegistry } from './registry';
import { isStandardSchema } from './standard-schema';
import type { StitchConfig } from './types';

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
export interface OpenApiOperation {
    operationId: string;
    summary?: string;
    parameters?: OpenApiParameter[];
    requestBody?: { content: Record<string, OpenApiMediaType> };
    responses: Record<string, OpenApiResponse>;
}
export interface OpenApiDocument {
    openapi: '3.1.0';
    info: OpenApiInfo;
    servers?: { url: string }[];
    paths: Record<string, Record<string, OpenApiOperation>>;
}
export interface OpenApiExportOptions {
    title?: string;
    version?: string;
    /**
     * Bring-your-own Standard Schema → JSON Schema converter (the contract-not-dependency gate:
     * core stays zero-dep, the way `axiosAdapter` takes your axios). When provided, request and
     * response BODY schemas are emitted from the stitch's `input.body` / `output` schemas instead
     * of `{}`. It receives the raw schema (a `Validator`'s `.source`) plus the slot and the
     * detected Standard Schema `vendor`; return a JSON Schema object, or `undefined` to fall back
     * to `{}`. Per-parameter schemas and a CLI flag for this are follow-ups.
     */
    toJsonSchema?: (
        source: unknown,
        info: { slot: 'body' | 'response'; vendor?: string },
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
        item[method] = buildOperation(cfg, key, parameters, opts.toJsonSchema);
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
    return { document, warnings };
}
