// `stitch from-curl` — turn ONE example (a `curl` command line or a single HAR entry) into a
// ready-to-paste `stitch({...})` declaration. PURE and deterministic: no I/O, no clock, no network
// — `parseCurl`/`parseHar` produce a {@link ParsedRequest}, and `toStitchSource` renders it to TS
// text. Testable exactly like src/openapi.ts / src/diagram.ts.
//
// SECURITY: a captured credential value (a Bearer token, an API key, a Basic password) is NEVER
// emitted into the source. Recognised auth headers/params become an `env('NAME')` placeholder; the
// secret stays in the operator's shell history, never in committed code.
//
// CLI-only: imported solely by cli.ts, never by src/index.ts — so it (and its parser) never enter
// the core or browser bundle. Types come from ./types only; core stays zero-dep and
// validator-agnostic (the optional `output:` schema is GENERATED TEXT, not an imported validator).
import type { StitchConfig } from './types';

// ---- parsed request -------------------------------------------------------

export interface ParsedRequest {
    method?: string;
    url: string;
    headers: { name: string; value: string }[];
    /** Raw request body (already a string); `bodyType` says how to read it. */
    body?: string;
    /** How the body was supplied: a JSON document, a urlencoded form, or unknown. */
    bodyKind?: 'json' | 'form';
    /** `-G`/`--get`: fold `-d` data into the query string instead of the body. */
    asQuery?: boolean;
    /** Anything we recognised but could not faithfully map — surfaced, never swallowed. */
    warnings: string[];
}

// ---- curl tokeniser -------------------------------------------------------

// Split a raw curl COMMAND LINE into argv-style tokens. Handles single/double quotes, backslash
// escapes, and shell line-continuations (a backslash immediately before a newline joins the lines).
// Not a full shell — enough for the curl commands people paste from devtools / API docs.
function tokenize(line: string): string[] {
    const tokens: string[] = [];
    let cur = '';
    let has = false; // did we open a token (so an empty '' quote still emits)?
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i] as string;
        if (quote) {
            if (ch === quote) {
                quote = null;
            } else if (quote === '"' && ch === '\\' && i + 1 < line.length) {
                // In double quotes, a backslash escapes the next char (curl-ish).
                cur += line[++i] ?? '';
            } else {
                cur += ch;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            has = true;
            continue;
        }
        if (ch === '\\') {
            const next = line[i + 1];
            if (next === '\n' || next === '\r') {
                // Line-continuation: swallow the backslash + newline (and a \r\n pair).
                i++;
                if (next === '\r' && line[i + 1] === '\n') i++;
                continue;
            }
            if (next !== undefined) {
                cur += next;
                has = true;
                i++;
                continue;
            }
            continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            if (has) {
                tokens.push(cur);
                cur = '';
                has = false;
            }
            continue;
        }
        cur += ch;
        has = true;
    }
    if (has) tokens.push(cur);
    return tokens;
}

// Strip a leading `curl` (and a `$ ` shell prompt) from already-tokenised argv.
function dropCurl(argv: string[]): string[] {
    const out = argv.slice();
    if (out[0] === '$') out.shift();
    if (out[0] === 'curl') out.shift();
    return out;
}

// Flags that take a following value but that we deliberately ignore (their value is consumed so it
// is not mistaken for the URL). Unknown value-less flags are warned about, never crash.
const SKIP_VALUE_FLAGS = new Set([
    '-A',
    '--user-agent',
    '-e',
    '--referer',
    '-b',
    '--cookie',
    '--compressed-ssl',
    '-w',
    '--write-out',
    '--connect-timeout',
    '--max-time',
    '-m',
    '--retry',
    '-o',
    '--output',
    '-T',
    '--upload-file',
    '--url',
]);

/**
 * Tokenise a curl command into a {@link ParsedRequest}. Accepts either a raw single-string command
 * line (with optional backslash-newline continuations) OR an already-split argv array. Recognises:
 * `-X`/`--request`, `-H`/`--header` (repeatable), `-d`/`--data`/`--data-raw`/`--data-binary`/
 * `--data-urlencode`, `-G`/`--get`, and the URL (quoted or bare). Unknown flags are warned about,
 * never fatal.
 */
// `-d`/`--data` family: a raw body part (not url-encoded). `--data-urlencode`
// is handled separately because it sets the urlencode flag.
const DATA_FLAGS = new Set([
    '-d',
    '--data',
    '--data-raw',
    '--data-ascii',
    '--data-binary',
]);

// Flags we recognise but ignore: transport/output toggles with no bearing on
// the request shape.
const NOOP_FLAGS = new Set([
    '-L',
    '--location',
    '-s',
    '--silent',
    '-k',
    '--insecure',
    '-v',
    '--verbose',
    '--compressed',
    '-f',
    '--fail',
    '-#',
]);

// Mutable accumulator threaded through the per-argument parse.
interface CurlAcc {
    warnings: string[];
    headers: { name: string; value: string }[];
    dataParts: { value: string; urlencode: boolean }[];
    method?: string;
    url?: string;
    asQuery: boolean;
    sawData: boolean;
}

function pushHeader(acc: CurlAcc, raw: string): void {
    const idx = raw.indexOf(':');
    if (idx < 0) {
        acc.warnings.push(`ignored header without a colon: "${raw}"`);
        return;
    }
    acc.headers.push({
        name: raw.slice(0, idx).trim(),
        value: raw.slice(idx + 1).trim(),
    });
}

// The switch default: a value-skipping flag (consume its value), an unknown
// flag (warn), or a bare token — the first bare token becomes the URL.
function applyPositionalOrUnknown(
    acc: CurlAcc,
    flag: string,
    tok: string,
    take: () => string | undefined,
): void {
    if (flag.startsWith('-')) {
        if (SKIP_VALUE_FLAGS.has(flag)) {
            take(); // consume its value so it is not read as the URL
        } else {
            acc.warnings.push(`ignored unknown flag: ${flag}`);
        }
        return;
    }
    // A bare token is the URL (first one wins; later bare tokens are noise).
    acc.url ??= tok;
}

// Apply one argv token to the accumulator and return the (possibly advanced)
// index — `take()` consumes the following token for flags that carry a value.
function applyCurlArg(
    acc: CurlAcc,
    argv: string[],
    i: number,
    flag: string,
    inline: string | undefined,
    tok: string,
): number {
    const take = (): string | undefined => inline ?? argv[++i];

    if (DATA_FLAGS.has(flag)) {
        const v = take();
        if (v !== undefined) {
            acc.dataParts.push({ value: v, urlencode: false });
            acc.sawData = true;
        }
        return i;
    }
    if (NOOP_FLAGS.has(flag)) return i;

    switch (flag) {
        case '-X':
        case '--request': {
            const v = take();
            if (v !== undefined) acc.method = v.toUpperCase();
            return i;
        }
        case '-H':
        case '--header': {
            const v = take();
            if (v !== undefined) pushHeader(acc, v);
            return i;
        }
        case '--data-urlencode': {
            const v = take();
            if (v !== undefined) {
                acc.dataParts.push({ value: v, urlencode: true });
                acc.sawData = true;
            }
            return i;
        }
        case '-G':
        case '--get':
            acc.asQuery = true;
            return i;
        case '-I':
        case '--head':
            acc.method = 'HEAD';
            return i;
        default:
            applyPositionalOrUnknown(acc, flag, tok, take);
            return i;
    }
}

function finalizeRequest(acc: CurlAcc): ParsedRequest {
    const warnings = acc.warnings;
    let url = acc.url;
    if (url === undefined) {
        warnings.push('no URL found in the curl command');
        url = '';
    }

    const req: ParsedRequest = { url, headers: acc.headers, warnings };
    if (acc.method !== undefined) req.method = acc.method;
    if (acc.asQuery) req.asQuery = true;
    if (acc.sawData) {
        const joined = acc.dataParts.map((p) => p.value).join('&');
        req.body = joined;
        const anyUrlencode = acc.dataParts.some((p) => p.urlencode);
        req.bodyKind = anyUrlencode ? 'form' : sniffBodyKind(joined);
    }
    return req;
}

export function parseCurl(curl: string | string[]): ParsedRequest {
    const argv = dropCurl(Array.isArray(curl) ? curl.slice() : tokenize(curl));
    const acc: CurlAcc = {
        warnings: [],
        headers: [],
        dataParts: [],
        asQuery: false,
        sawData: false,
    };

    for (let i = 0; i < argv.length; i++) {
        const tok = argv[i];
        if (tok === undefined) continue;
        // A flag may be `--data=foo` or `--data foo`; normalise to (flag, inlineValue?).
        let flag = tok;
        let inline: string | undefined;
        if (tok.startsWith('--')) {
            const eq = tok.indexOf('=');
            if (eq >= 0) {
                flag = tok.slice(0, eq);
                inline = tok.slice(eq + 1);
            }
        }
        i = applyCurlArg(acc, argv, i, flag, inline, tok);
    }

    return finalizeRequest(acc);
}

// Classify a raw `-d` payload: a JSON-parseable document → 'json', else (k=v&… or anything else)
// → 'form'. Conservative — only valid JSON is treated as JSON.
function sniffBodyKind(raw: string): 'json' | 'form' {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            JSON.parse(trimmed);
            return 'json';
        } catch {
            /* not JSON → form */
        }
    }
    return 'form';
}

// ---- HAR entry ------------------------------------------------------------

/**
 * Read ONE request entry from a HAR object into a {@link ParsedRequest}. Defaults to entry 0; never
 * emits a whole registry. Tolerant of partial HARs — missing fields become warnings, not throws.
 */
export function parseHar(har: unknown, entryIndex = 0): ParsedRequest {
    const warnings: string[] = [];
    const entries = (har as { log?: { entries?: unknown[] } }).log?.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
        return { url: '', headers: [], warnings: ['HAR has no entries'] };
    }
    if (entryIndex < 0 || entryIndex >= entries.length) {
        warnings.push(
            `HAR entry ${entryIndex} out of range (0..${entries.length - 1}); using entry 0`,
        );
        entryIndex = 0;
    }
    const request = (entries[entryIndex] as { request?: unknown }).request as
        | {
              method?: unknown;
              url?: unknown;
              headers?: unknown;
              postData?: { text?: unknown; mimeType?: unknown };
          }
        | undefined;
    if (!request) {
        return {
            url: '',
            headers: [],
            warnings: [`HAR entry ${entryIndex} has no request`],
        };
    }

    const headers: { name: string; value: string }[] = [];
    if (Array.isArray(request.headers)) {
        for (const h of request.headers) {
            const name = (h as { name?: unknown }).name;
            const value = (h as { value?: unknown }).value;
            if (typeof name === 'string' && typeof value === 'string') {
                // HAR records HTTP/2 pseudo-headers (`:authority`, `:method`); they are not real
                // request headers, so drop them.
                if (name.startsWith(':')) continue;
                headers.push({ name, value });
            }
        }
    }

    const req: ParsedRequest = {
        url: typeof request.url === 'string' ? request.url : '',
        headers,
        warnings,
    };
    if (req.url === '') warnings.push(`HAR entry ${entryIndex} has no url`);
    if (typeof request.method === 'string')
        req.method = request.method.toUpperCase();

    const text = request.postData?.text;
    if (typeof text === 'string' && text.length) {
        req.body = text;
        const mime =
            typeof request.postData?.mimeType === 'string'
                ? request.postData.mimeType
                : '';
        req.bodyKind = mime.includes('x-www-form-urlencoded')
            ? 'form'
            : mime.includes('json')
              ? 'json'
              : sniffBodyKind(text);
    }
    return req;
}

// ---- URL → baseUrl + path -------------------------------------------------

// Split a URL into origin + path + query. Mirrors openapi.ts's splitServer shape, but also returns
// the query string so `-G` data and existing `?a=b` params can be modelled.
function splitUrl(raw: string): {
    origin?: string;
    path: string;
    query: { name: string; value: string }[];
} {
    const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]+)(\/[^?#]*|)(\?[^#]*)?/i.exec(
        raw,
    );
    if (!m) {
        const q = raw.indexOf('?');
        const path = (q >= 0 ? raw.slice(0, q) : raw) || '/';
        return {
            path: path.startsWith('/') ? path : `/${path}`,
            query: q >= 0 ? parseQuery(raw.slice(q + 1)) : [],
        };
    }
    const origin = m[1] as string;
    const path = m[2]?.length ? m[2] : '/';
    const query = m[3] ? parseQuery(m[3].slice(1)) : [];
    return { origin, path, query };
}

// Parse a `a=b&c=d` query string into name/value pairs (URL-decoded, missing `=` → empty value).
function parseQuery(qs: string): { name: string; value: string }[] {
    const out: { name: string; value: string }[] = [];
    for (const part of qs.split('&')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        const name = eq >= 0 ? part.slice(0, eq) : part;
        const value = eq >= 0 ? part.slice(eq + 1) : '';
        out.push({ name: safeDecode(name), value: safeDecode(value) });
    }
    return out;
}

function safeDecode(s: string): string {
    try {
        return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch {
        return s;
    }
}

// ---- id-like path-segment lifting -----------------------------------------

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX_RE = /^[0-9a-f]{16,}$/i;

// Does a concrete path segment look like an id we should lift into a `{param}` slot? Conservative:
// pure digits, a UUID, a long hex string, or a url-encoded segment. A short word like `users` stays
// literal. Lifting is always warned about so the user can revert a false positive.
function looksLikeId(seg: string): boolean {
    if (seg.length === 0) return false;
    if (/^\d+$/.test(seg)) return true;
    if (UUID_RE.test(seg)) return true;
    if (LONG_HEX_RE.test(seg)) return true;
    if (/%[0-9a-f]{2}/i.test(seg)) return true; // url-encoded (e.g. an email/slug id)
    return false;
}

// A param name for a lifted segment, derived from its preceding literal segment when sensible:
// `/users/1` → the `1` becomes `{id}` (preceding `users` → singular `user` → `userId`? we keep it
// simple and deterministic: `id` for the first lift, then `id2`, `id3`, …). A preceding literal
// gives a friendlier `<singular>Id` when it is a plain word.
function paramNameFor(
    prevLiteral: string | undefined,
    used: Set<string>,
): string {
    let base = 'id';
    if (prevLiteral && /^[a-z][a-z0-9]*$/i.test(prevLiteral)) {
        const singular = prevLiteral.replace(/s$/i, '');
        base = `${singular}Id`;
    }
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}${n}`;
    used.add(name);
    return name;
}

interface LiftedPath {
    path: string;
    params: { name: string; value: string }[];
}

// Walk the path segments, lifting id-like concrete segments into `{param}` slots. Returns the
// templated path plus the (name → example value) pairs so the emitted call can show params:{}.
function liftPath(rawPath: string): LiftedPath {
    const segments = rawPath.split('/');
    const params: { name: string; value: string }[] = [];
    const used = new Set<string>();
    let prevLiteral: string | undefined;
    const out = segments.map((seg) => {
        if (seg === '') return seg;
        if (looksLikeId(seg)) {
            const name = paramNameFor(prevLiteral, used);
            params.push({ name, value: safeDecode(seg) });
            return `{${name}}`;
        }
        prevLiteral = seg;
        return seg;
    });
    return { path: out.join('/'), params };
}

// ---- auth recognition -----------------------------------------------------

type AuthEmit =
    | { kind: 'bearer'; envName: string }
    | { kind: 'apiKey'; envName: string; header?: string; queryName?: string }
    | { kind: 'basic'; userEnv: string; passEnv: string };

// Headers we drop from the static `headers:` block — either handled elsewhere (auth, content-type
// implied by bodyType) or transport noise the runtime sets itself.
const DROP_HEADERS = new Set([
    'authorization',
    'cookie',
    'host',
    'content-length',
    'user-agent',
    'accept-encoding',
    'connection',
    'x-api-key',
]);

// ---- TS source emission ---------------------------------------------------

export interface ToStitchSourceOptions {
    /** Export name for the emitted `export const <name> = stitch(...)`. */
    name?: string;
    /** Emit an `output:` zod schema (generated TEXT — core never imports zod). */
    zod?: boolean;
    /**
     * A sample response (the CLI's `--response`), used ONLY when `zod` is set to infer the
     * `output:` schema's shape. Parsed leniently; a non-JSON sample falls back to `z.unknown()`.
     */
    response?: string;
}

export interface ToStitchSourceResult {
    source: string;
    warnings: string[];
}

// Derive a camelCase export name from the path: `/users/{id}` → `getUsers` / `createUsers` by
// method. Deterministic, identifier-safe; falls back to `request`.
function deriveName(method: string, path: string): string {
    const segs = path
        .split('/')
        .filter((s) => s && !s.startsWith('{'))
        .map((s) => s.replace(/[^A-Za-z0-9]+/g, ' ').trim())
        .filter(Boolean);
    const verb =
        method === 'POST'
            ? 'create'
            : method === 'PUT' || method === 'PATCH'
              ? 'update'
              : method === 'DELETE'
                ? 'delete'
                : 'get';
    const tail = segs.length ? segs[segs.length - 1] : 'request';
    const camelTail = (tail as string)
        .split(/\s+/)
        .map((w, i) =>
            i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1),
        )
        .join('');
    const ident = `${verb}${camelTail.charAt(0).toUpperCase()}${camelTail.slice(1)}`;
    return /^[A-Za-z_$]/.test(ident) ? ident : `request`;
}

// A JS object/string literal renderer for emitted config values. Strings are single-quoted with
// backslashes and quotes escaped; this is for short, simple example values (header values, body
// fields). A captured value can contain line terminators (a HAR header, a multiline `-d @body`),
// which are ILLEGAL inside a single-quoted JS literal and would emit source that doesn't parse — so
// escape the four ES line terminators too: LF, CR, and U+2028/U+2029 (both are string-literal line
// terminators pre-ES2019). Every other control char (tab, form-feed, …) is legal inside the literal
// and left as-is. `\\` is escaped FIRST so the escapes we introduce aren't themselves re-escaped.
function quote(s: string): string {
    return `'${s
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')}'`;
}

// Render a JSON value as TS source, indented. Used for a `-d` JSON body example.
function renderJson(value: unknown, indent: string): string {
    if (value === null) return 'null';
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    if (typeof value === 'string') return quote(value);
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const inner = value
            .map((v) => `${indent}    ${renderJson(v, `${indent}    `)}`)
            .join(',\n');
        return `[\n${inner},\n${indent}]`;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        if (entries.length === 0) return '{}';
        const inner = entries
            .map(
                ([k, v]) =>
                    `${indent}    ${renderKey(k)}: ${renderJson(v, `${indent}    `)}`,
            )
            .join(',\n');
        return `{\n${inner},\n${indent}}`;
    }
    return 'null';
}

// An object key, bare when it is a plain identifier, else quoted.
function renderKey(k: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : quote(k);
}

// Infer a zod schema STRING from a sample response value. GENERATED TEXT only — core never imports
// zod. Recurses one level into objects/arrays; an unknown sample → `z.unknown()`.
function zodFor(value: unknown, indent: string): string {
    if (typeof value === 'string') return 'z.string()';
    if (typeof value === 'number') return 'z.number()';
    if (typeof value === 'boolean') return 'z.boolean()';
    if (value === null) return 'z.null()';
    if (Array.isArray(value)) {
        const first: unknown = value[0];
        return first === undefined
            ? 'z.array(z.unknown())'
            : `z.array(${zodFor(first, indent)})`;
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        if (entries.length === 0) return 'z.object({})';
        const inner = entries
            .map(
                ([k, v]) =>
                    `${indent}    ${renderKey(k)}: ${zodFor(v, `${indent}    `)}`,
            )
            .join(',\n');
        return `z.object({\n${inner},\n${indent}})`;
    }
    return 'z.unknown()';
}

// Recognise an auth strategy from the request headers/query; returns the strategy to emit plus the
// header/param NAME that auth consumes (so it is dropped from static headers/query). The credential
// value is read but NEVER returned for emission — only an env() placeholder name is.
function recogniseAuth(
    headers: { name: string; value: string }[],
    query: { name: string; value: string }[],
): { auth?: AuthEmit; usedHeader?: string; usedQuery?: string } {
    for (const h of headers) {
        const lower = h.name.toLowerCase();
        if (lower === 'authorization') {
            const v = h.value;
            if (/^bearer\s+/i.test(v))
                return {
                    auth: { kind: 'bearer', envName: 'API_TOKEN' },
                    usedHeader: lower,
                };
            if (/^basic\s+/i.test(v))
                return {
                    auth: {
                        kind: 'basic',
                        userEnv: 'API_USER',
                        passEnv: 'API_PASSWORD',
                    },
                    usedHeader: lower,
                };
        }
        if (lower === 'x-api-key')
            return {
                auth: { kind: 'apiKey', envName: 'API_KEY', header: h.name },
                usedHeader: lower,
            };
    }
    for (const q of query) {
        if (q.name === 'api_key' || q.name === 'access_token')
            return {
                auth: { kind: 'apiKey', envName: 'API_KEY', queryName: q.name },
                usedQuery: q.name,
            };
    }
    return {};
}

/**
 * Render a {@link ParsedRequest} into a ready-to-paste `export const <name> = stitch({...})` plus a
 * matching `await <name>({...})` call. Pure and deterministic. Returns the source text and any
 * warnings (lifted path segments, dropped flags, a sample response that could not be parsed).
 *
 * SECURITY: a captured credential never appears in the source — recognised auth becomes an
 * `env('NAME')` placeholder.
 */
// The shape of a parsed request once curl/HAR noise is resolved into the
// pieces a stitch needs: a templated path, recognised auth, the carried query,
// the static headers, and the effective body type + method.
interface AnalyzedRequest {
    origin: string | undefined;
    path: string;
    params: { name: string; value: string }[];
    auth: AuthEmit | undefined;
    query: { name: string; value: string }[];
    staticHeaders: { name: string; value: string }[];
    // analyzeRequest only ever emits 'json' | 'form' (or undefined); the narrower
    // type lets renderBody/renderConfig consume it without a cast.
    bodyType: 'json' | 'form' | undefined;
    method: string | undefined;
    warnings: string[];
}

// Whether a header survives into the static `headers:` block: drop the auth
// header, transport noise, and a content-type already implied by bodyType.
function keepStaticHeader(
    h: { name: string; value: string },
    usedHeader: string | undefined,
    bodyType: 'json' | 'form' | undefined,
): boolean {
    const lower = h.name.toLowerCase();
    if (lower === usedHeader) return false;
    if (DROP_HEADERS.has(lower)) return false;
    if (lower === 'content-type') {
        // Drop content-type only when bodyType implies it (json/form); keep an explicit one
        // for an unusual type so the request still asks for it.
        if (bodyType === 'json' && /application\/json/i.test(h.value))
            return false;
        if (bodyType === 'form' && /x-www-form-urlencoded/i.test(h.value))
            return false;
    }
    if (lower === 'accept' && /^\*\/\*$/.test(h.value.trim())) return false;
    return true;
}

// Resolve a ParsedRequest into the pieces toStitchSource emits: lift id path
// segments, recognise auth, compute the carried query, drop noise headers, and
// decide the body type + method. Warnings accumulate the lifts.
function analyzeRequest(req: ParsedRequest): AnalyzedRequest {
    const warnings: string[] = [...req.warnings];
    const { origin, path: rawPath, query: urlQuery } = splitUrl(req.url);

    // Lift id-like path segments into {param} slots (conservative; each lift is warned).
    const { path, params } = liftPath(rawPath);
    for (const p of params)
        warnings.push(
            `lifted path segment "${p.value}" into {${p.name}} — revert if it is a literal, not an id`,
        );

    // Auth recognition consumes one header or query param; the rest stay static.
    const { auth, usedHeader, usedQuery } = recogniseAuth(
        req.headers,
        urlQuery,
    );

    // The query the call carries: URL query (minus an auth param) plus, under -G, the data.
    const query: { name: string; value: string }[] = urlQuery.filter(
        (q) => q.name !== usedQuery,
    );
    if (req.asQuery && req.body) {
        for (const pair of parseQuery(req.body)) query.push(pair);
    }

    // Static headers: drop auth/transport/implied-content-type noise.
    const bodyType: StitchConfig['bodyType'] | undefined =
        !req.asQuery && req.body
            ? req.bodyKind === 'form'
                ? 'form'
                : 'json'
            : undefined;
    const staticHeaders = req.headers.filter((h) =>
        keepStaticHeader(h, usedHeader, bodyType),
    );

    // Method: explicit wins; else POST when a body is present and we are not folding it to query.
    const method =
        req.method ?? (req.body && !req.asQuery ? 'POST' : undefined);

    return {
        origin,
        path,
        params,
        auth,
        query,
        staticHeaders,
        bodyType,
        method,
        warnings,
    };
}

// The `output:` line under --zod: a generated schema from the --response
// sample, or z.unknown() with a warning when the sample is missing/invalid.
function renderOutputLine(
    opts: ToStitchSourceOptions,
    warnings: string[],
): string {
    let sample: unknown;
    if (opts.response !== undefined) {
        try {
            sample = JSON.parse(opts.response);
        } catch {
            warnings.push(
                '--response was not valid JSON; emitted z.unknown() for output',
            );
        }
    } else {
        warnings.push(
            'no --response sample; emitted z.unknown() for the output schema',
        );
    }
    const output =
        sample === undefined ? 'z.unknown()' : zodFor(sample, '    ');
    return `    output: ${output},`;
}

// Render the `stitch({...})` config plus its import head. `--zod` may append a
// generated output schema (and warnings when no/invalid --response sample).
function renderConfig(
    a: AnalyzedRequest,
    req: ParsedRequest,
    opts: ToStitchSourceOptions,
    warnings: string[],
): { head: string; config: string; name: string } {
    // An explicit --name wins, but a blank/whitespace-only name falls through to the derived one
    // (so `''` is treated as "unset", which is why this is not a plain `??`).
    const trimmedName = opts.name?.trim();
    const name =
        trimmedName !== undefined && trimmedName.length > 0
            ? trimmedName
            : deriveName(a.method ?? 'GET', a.path);
    const lines: string[] = [];
    if (a.origin) {
        lines.push(`    baseUrl: ${quote(a.origin)},`);
        lines.push(`    path: ${quote(a.path)},`);
    } else {
        lines.push(`    url: ${quote(req.url)},`);
    }
    if (a.method && a.method !== 'GET')
        lines.push(`    method: ${quote(a.method)},`);

    if (a.auth) lines.push(`    auth: ${renderAuth(a.auth)},`);

    if (a.staticHeaders.length) {
        const hdr = a.staticHeaders
            .map((h) => `        ${renderKey(h.name)}: ${quote(h.value)}`)
            .join(',\n');
        lines.push(`    headers: {\n${hdr},\n    },`);
    }

    // Request body (only when NOT folded to query). JSON → an example object; form → a note.
    if (a.bodyType && req.body) {
        lines.push(`    bodyType: ${quote(a.bodyType)},`);
    }

    // Output schema: default = a comment; with --zod = a generated schema string from --response.
    if (opts.zod) lines.push(renderOutputLine(opts, warnings));

    const importLine = buildImport(a.auth);
    const head = opts.zod
        ? `${importLine}\nimport { z } from 'zod';\n`
        : `${importLine}\n`;
    const config = `export const ${name} = stitch({\n${lines.join('\n')}\n});`;
    return { head, config, name };
}

// The example call: show params for lifted ids, query, and an example body.
function renderExampleCall(
    a: AnalyzedRequest,
    req: ParsedRequest,
    name: string,
): string {
    const callArgLines: string[] = [];
    if (a.params.length) {
        const ps = a.params
            .map(
                (p) => `        ${renderKey(p.name)}: ${exampleParam(p.value)}`,
            )
            .join(',\n');
        callArgLines.push(`    params: {\n${ps},\n    }`);
    }
    if (a.query.length) {
        const qs = a.query
            .map(
                (q) => `        ${renderKey(q.name)}: ${exampleParam(q.value)}`,
            )
            .join(',\n');
        callArgLines.push(`    query: {\n${qs},\n    }`);
    }
    if (a.bodyType && req.body) {
        callArgLines.push(`    body: ${renderBody(req.body, a.bodyType)}`);
    }
    const callArg = callArgLines.length
        ? `{\n${callArgLines.join(',\n')},\n}`
        : '';
    return `await ${name}(${callArg});`;
}

export function toStitchSource(
    req: ParsedRequest,
    opts: ToStitchSourceOptions = {},
): ToStitchSourceResult {
    const a = analyzeRequest(req);
    const warnings = a.warnings;
    const { head, config, name } = renderConfig(a, req, opts, warnings);
    const call = renderExampleCall(a, req, name);

    const comment = opts.zod
        ? ''
        : '// add an output schema to validate + type the response (rerun with --zod)\n';

    const source = `${head}\n${config}\n\n${comment}${call}\n`;
    return { source, warnings };
}

// Render an example call value: a number when the captured value is all-digits, else a quoted string.
function exampleParam(value: string): string {
    return /^\d+$/.test(value) ? value : quote(value);
}

// Render the body argument for the example call. JSON → the parsed example; form → an object of the
// parsed k=v pairs.
function renderBody(raw: string, bodyType: 'json' | 'form'): string {
    if (bodyType === 'json') {
        try {
            return renderJson(JSON.parse(raw), '    ');
        } catch {
            return quote(raw);
        }
    }
    const pairs = parseQuery(raw);
    if (!pairs.length) return '{}';
    const inner = pairs
        .map((p) => `        ${renderKey(p.name)}: ${exampleParam(p.value)}`)
        .join(',\n');
    return `{\n${inner},\n    }`;
}

// Render the `auth:` value for a recognised strategy. The credential is ALWAYS an env() placeholder.
function renderAuth(auth: AuthEmit): string {
    switch (auth.kind) {
        case 'bearer':
            return `bearer(env('${auth.envName}'))`;
        case 'apiKey':
            return auth.queryName
                ? `apiKey({ in: 'query', name: '${auth.queryName}', value: env('${auth.envName}') })`
                : auth.header && auth.header.toLowerCase() !== 'x-api-key'
                  ? `apiKey({ header: '${auth.header}', value: env('${auth.envName}') })`
                  : `apiKey({ value: env('${auth.envName}') })`;
        case 'basic':
            return `basic({ user: env('${auth.userEnv}'), pass: env('${auth.passEnv}') })`;
    }
}

// The import line(s): only the symbols the emitted code actually uses (stitch always; `env` when
// auth is present; z is imported separately under --zod). The auth STRATEGY comes from the
// `stitchapi/auth` subpath rather than the root, so a scaffolded client without auth never pulls
// the strategies in — which is the whole reason they live behind a subpath.
function buildImport(auth: AuthEmit | undefined): string {
    const named = ['stitch'];
    if (!auth) return `import { ${named.join(', ')} } from 'stitchapi';`;

    named.push('env');
    const strategy =
        auth.kind === 'bearer'
            ? 'bearer'
            : auth.kind === 'apiKey'
              ? 'apiKey'
              : 'basic';
    return [
        `import { ${named.join(', ')} } from 'stitchapi';`,
        `import { ${strategy} } from 'stitchapi/auth';`,
    ].join('\n');
}
