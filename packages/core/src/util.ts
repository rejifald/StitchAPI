// Small dependency-free helpers shared across the prototype.
import type { Clock, RunContext } from './types';

export const now = (): number => Date.now();

// ---- run identity (ADR 0007) ----------------------------------------------
// Browser-safe random hex ids for the OTLP-aligned span tree: crypto.getRandomValues
// where available, else Math.random (ids need to be unique-ish, not secret). 16 bytes
// → a 32-hex traceId, 8 bytes → a 16-hex spanId. The lone minter, shared by the
// engine (run identity) and the OTLP sink (its fallback when fed events by hand).
export function hex(bytes: number): string {
    const buf = new Uint8Array(bytes);
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.getRandomValues) c.getRandomValues(buf);
    else
        for (let i = 0; i < buf.length; i++)
            buf[i] = Math.floor(Math.random() * 256);
    return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Mint a {@link RunContext} for one logical call (ADR 0007). A root run gets a fresh
 * 32-hex `traceId` and a 16-hex `spanId`; a child run (a `cookieSession` login, a `linked`
 * step) passes its caller's context to **inherit** the `traceId` and set `parentSpanId` to the
 * caller's `spanId`, so runs form one OTLP span tree. Ids are engine-minted, never supplied
 * by a caller (a caller-named id would spoof correlation — ADR 0002 §2 reasoning).
 */
export function newRunContext(parent?: {
    traceId: string;
    spanId: string;
}): RunContext {
    return {
        traceId: parent?.traceId ?? hex(16),
        spanId: hex(8),
        ...(parent ? { parentSpanId: parent.spanId } : {}),
    };
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
        }
        const t = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(t);
                reject(new Error('aborted'));
            },
            { once: true },
        );
    });
}

/**
 * The default {@link Clock}: wall-clock time and the platform's global timers. The behaviour the
 * engine has always had — injecting a different `Clock` (e.g. `manualClock()`) is opt-in.
 */
export const systemClock: Clock = {
    now: () => Date.now(),
    sleep: (ms, signal) => sleep(ms, signal),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
};

/**
 * Parse a duration into milliseconds. Grammar: a number (already ms), a numeric
 * string (`"1500"` → 1500), or `<number><unit>` with unit `ms` | `s` | `m` | `h` | `d`
 * (`"500ms"`, `"30s"`, `"2m"`, `"1h"`, `"2d"`; fractions like `"1.5s"` allowed).
 * Anything else → `undefined`.
 */
export function parseDuration(
    d: number | string | undefined,
): number | undefined {
    if (d == null) return undefined;
    if (typeof d === 'number') return d;
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(d.trim());
    if (!m) return Number(d) || undefined;
    const n = parseFloat(m[1] ?? '');
    const scale: Record<string, number> = {
        ms: 1,
        s: 1000,
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000,
    };
    return n * (scale[m[2] ?? ''] ?? 1);
}

/** "2/s" | "10/m" -> { count, per } (window length in ms). */
export function parseRate(r: string): { count: number; per: number } {
    const m = /^(\d+)\s*\/\s*(ms|s|m)$/.exec(r.trim());
    if (!m) throw new Error(`bad rate: ${r}`);
    const per = m[2] === 'ms' ? 1 : m[2] === 's' ? 1000 : 60000;
    return { count: parseInt(m[1] ?? '', 10), per };
}

/**
 * Strip any trailing `/` from a base URL. Done by hand rather than with `replace(/\/+$/, '')`:
 * the anchored `\/+$` backtracks quadratically on a string of many slashes that doesn't end the
 * match (a polynomial-ReDoS trap), whereas this single backward scan is linear.
 */
export function stripTrailingSlashes(s: string): string {
    let end = s.length;
    while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
    return end === s.length ? s : s.slice(0, end);
}

export const isObj = (x: unknown): x is Record<string, unknown> =>
    !!x && typeof x === 'object' && !Array.isArray(x);

export function deepMerge<T>(a: T, b: T): T {
    if (b === undefined) return a;
    if (a === undefined) return b;
    if (Array.isArray(a) && Array.isArray(b)) return b;
    if (isObj(a) && isObj(b)) {
        const out: Record<string, unknown> = { ...a };
        for (const k of Object.keys(b)) {
            out[k] =
                k in a
                    ? deepMerge(
                          (a as Record<string, unknown>)[k],
                          (b as Record<string, unknown>)[k],
                      )
                    : (b as Record<string, unknown>)[k];
        }
        return out as T;
    }
    return b;
}

export function getPath(obj: unknown, path: string): unknown {
    if (!path) return obj;
    return path
        .split('.')
        .reduce<unknown>(
            (acc, k) =>
                acc == null ? acc : (acc as Record<string, unknown>)[k],
            obj,
        );
}

// ---- RFC 6570 URI Template expansion --------------------------------------
// A dependency-free port of the `url-template` (v3) algorithm, covering RFC 6570
// through Level 4: the operators `+ # . / ; ? &`, the explode (`*`) and prefix
// (`:n`) modifiers, and list/object values. Plain `{id}` interpolation is the common
// case; the operators make reserved, path, label, and query expansion available too.
const TEMPLATE_OPERATORS = ['+', '#', '.', '/', ';', '?', '&'];

// Coerce a leaf value to its string form for URL encoding. Template/query leaves are
// expected to be primitives; a stray object is JSON-encoded rather than emitted as the
// useless '[object Object]'.
function stringifyLeaf(value: unknown): string {
    if (typeof value === 'string') return value;
    if (
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        typeof value === 'bigint'
    )
        return String(value);
    if (value === null || value === undefined) return '';
    return JSON.stringify(value);
}

// Percent-encode everything outside RFC 6570 *unreserved* — i.e. `encodeURIComponent`
// plus the extra characters it leaves alone (`! ' ( ) *`).
function encodeUnreserved(str: string): string {
    return encodeURIComponent(str).replace(
        /[!'()*]/g,
        (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
    );
}

// Percent-encode but leave *reserved* characters — and existing `%XX` triples —
// intact. Used by the `+` and `#` operators, where reserved characters pass through.
function encodeReserved(str: string): string {
    return str
        .split(/(%[0-9A-Fa-f]{2})/g)
        .map((part) =>
            /%[0-9A-Fa-f]{2}/.test(part)
                ? part
                : encodeURI(part).replace(/%5B/g, '[').replace(/%5D/g, ']'),
        )
        .join('');
}

const isKeyOperator = (op: string | null): boolean =>
    op === ';' || op === '&' || op === '?';

function encodeTemplateValue(
    op: string | null,
    value: string,
    key?: string,
): string {
    const v =
        op === '+' || op === '#'
            ? encodeReserved(value)
            : encodeUnreserved(value);
    return key !== undefined ? encodeUnreserved(key) + '=' + v : v;
}

// Expand one variable (the `getValues` step of RFC 6570 §3.2.1) into its rendered pieces.
function expandTemplateVar(
    vars: Record<string, unknown>,
    op: string | null,
    key: string,
    modifier: string | undefined,
): string[] {
    const value = vars[key];
    const out: string[] = [];
    const defined = value !== undefined && value !== null;
    if (defined && value !== '') {
        if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'boolean'
        ) {
            let s = String(value);
            if (modifier && modifier !== '*')
                s = s.substring(0, parseInt(modifier, 10));
            out.push(
                encodeTemplateValue(op, s, isKeyOperator(op) ? key : undefined),
            );
        } else if (modifier === '*') {
            // explode: each list item / each object pair becomes its own piece
            if (Array.isArray(value)) {
                for (const item of value)
                    if (item != null)
                        out.push(
                            encodeTemplateValue(
                                op,
                                String(item),
                                isKeyOperator(op) ? key : undefined,
                            ),
                        );
            } else {
                for (const [k, v] of Object.entries(
                    value as Record<string, unknown>,
                ))
                    if (v != null)
                        out.push(encodeTemplateValue(op, stringifyLeaf(v), k));
            }
        } else {
            // no explode: collapse the list/object into one comma-joined piece
            const tmp: string[] = [];
            if (Array.isArray(value)) {
                for (const item of value)
                    if (item != null)
                        tmp.push(encodeTemplateValue(op, String(item)));
            } else {
                for (const [k, v] of Object.entries(
                    value as Record<string, unknown>,
                ))
                    if (v != null) {
                        tmp.push(encodeUnreserved(k));
                        tmp.push(encodeTemplateValue(op, stringifyLeaf(v)));
                    }
            }
            if (isKeyOperator(op))
                out.push(encodeUnreserved(key) + '=' + tmp.join(','));
            else if (tmp.length) out.push(tmp.join(','));
        }
    } else if (op === ';') {
        if (defined) out.push(encodeUnreserved(key)); // empty string → bare `;name`
    } else if (value === '' && (op === '&' || op === '?')) {
        out.push(encodeUnreserved(key) + '='); // empty string → `name=`
    } else if (value === '') {
        out.push('');
    }
    return out;
}

/** Expand an RFC 6570 template (`/users/{id}`, `/files{/path*}`, `{?q,sort}`, …) against `params`. */
export function expandPath(
    tpl: string,
    params: Record<string, unknown> = {},
): string {
    return tpl.replace(
        /\{([^{}]+)\}|([^{}]+)/g,
        (_m, expr: string | undefined, literal: string | undefined) => {
            if (expr === undefined) return encodeReserved(literal ?? '');
            let body = expr;
            let op: string | null = null;
            if (TEMPLATE_OPERATORS.includes(body.charAt(0))) {
                op = body.charAt(0);
                body = body.slice(1);
            }
            const values: string[] = [];
            for (const varspec of body.split(',')) {
                const m = /([^:*]*)(?::(\d+)|(\*))?/.exec(varspec);
                if (!m) continue;
                values.push(
                    ...expandTemplateVar(params, op, m[1] ?? '', m[2] ?? m[3]),
                );
            }
            if (op && op !== '+') {
                const sep = op === '?' ? '&' : op === '#' ? ',' : op;
                return (values.length ? op : '') + values.join(sep);
            }
            return values.join(',');
        },
    );
}

// ---- Query strings --------------------------------------------------------
// Build a query string from a possibly-nested object, `qs`-style: nested objects
// expand to `a[b]=c`, and both the bracketed key and the value are percent-encoded
// (so `a[b]` goes on the wire as `a%5Bb%5D`, which servers decode back to `a[b]`).
// `null`/`undefined` are skipped; empty objects/arrays add nothing.
// Array serialisation is controlled by `arrayFormat` (default 'indices'):
//   'indices'  → a%5B0%5D=x&a%5B1%5D=y  (numeric subscripts)
//   'brackets' → a%5B%5D=x&a%5B%5D=y    (empty bracket suffix, no index)
//   'repeat'   → a=x&a=y                 (bare repeated keys, no brackets)
export type ArrayFormat = 'indices' | 'brackets' | 'repeat';

export function buildQuery(
    q: Record<string, unknown> | undefined,
    arrayFormat: ArrayFormat = 'indices',
): string {
    if (!q) return '';
    const parts: string[] = [];
    for (const [k, v] of Object.entries(q))
        appendQueryParam(k, v, parts, arrayFormat);
    return parts.length ? `?${parts.join('&')}` : '';
}

function appendQueryParam(
    key: string,
    value: unknown,
    out: string[],
    arrayFormat: ArrayFormat,
): void {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
        value.forEach((item, i) => {
            if (arrayFormat === 'repeat') {
                appendQueryParam(key, item, out, arrayFormat);
            } else if (arrayFormat === 'brackets') {
                appendQueryParam(`${key}[]`, item, out, arrayFormat);
            } else {
                // 'indices' — default
                appendQueryParam(`${key}[${i}]`, item, out, arrayFormat);
            }
        });
    } else if (value instanceof Date) {
        out.push(
            `${encodeURIComponent(key)}=${encodeURIComponent(value.toISOString())}`,
        );
    } else if (typeof value === 'object') {
        for (const [k, v] of Object.entries(value as Record<string, unknown>))
            appendQueryParam(`${key}[${k}]`, v, out, arrayFormat);
    } else {
        out.push(
            `${encodeURIComponent(key)}=${encodeURIComponent(stringifyLeaf(value))}`,
        );
    }
}

/**
 * Index of the first `?` that is *not* inside an RFC 6570 `{…}` expression, so a `{?x}`
 * query operator in a template isn't mistaken for the predefined-query delimiter.
 */
export function topLevelQueryIndex(raw: string): number {
    let depth = 0;
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '{') depth++;
        else if (c === '}') depth = Math.max(0, depth - 1);
        else if (c === '?' && depth === 0) return i;
    }
    return -1;
}

/**
 * Append an already-built query string (`?a=b`, or `''`) onto a URL that may already
 * carry a query (e.g. from a `{?x}` template operator), switching the leading `?` to `&`
 * as needed. A trailing `#fragment` (from a `{#…}` operator) is preserved at the end.
 */
export function appendQueryString(url: string, qs: string): string {
    if (!qs) return url;
    const hashIdx = url.indexOf('#');
    const head = hashIdx === -1 ? url : url.slice(0, hashIdx);
    const tail = hashIdx === -1 ? '' : url.slice(hashIdx);
    return head + (head.includes('?') ? '&' + qs.slice(1) : qs) + tail;
}

/**
 * Does a drift path (e.g. `data[].headline`) match a user pattern?
 * Supports: exact match, `*` (single segment wildcard), and prefix match
 * (pattern `data` matches `data[].id`).
 */
export function matchPath(pattern: string, path: string): boolean {
    if (pattern === path) return true;
    if (path.startsWith(pattern + '.') || path.startsWith(pattern + '['))
        return true;
    if (pattern.includes('*')) {
        const rx = new RegExp(
            '^' +
                pattern
                    .split('.')
                    .map((s) =>
                        s === '*'
                            ? '[^.]+'
                            : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                    )
                    .join('\\.') +
                '($|\\.|\\[)',
        );
        return rx.test(path);
    }
    return false;
}

export function matchAny(
    patterns: string[] | undefined,
    path: string,
): boolean {
    return !!patterns && patterns.some((p) => matchPath(p, path));
}

// ---- platform seam ---------------------------------------------------------
// Browser-safe access to Node facilities (GAP-AUDIT §1.5). Importing the library
// must never evaluate `node:*` or assume `process` exists: Node builtins load
// lazily through `process.getBuiltinModule`, so a browser bundle contains no
// `node:` specifier at all, and both helpers return undefined off Node — the
// file-based features treat that as an explicit no-op, never a crash.

interface PlatformGlobals {
    process?: {
        env?: Record<string, string | undefined>;
        getBuiltinModule?: (id: string) => unknown;
    };
}

/** Read an environment variable; undefined where `process` doesn't exist (browser). */
export function readEnv(name: string): string | undefined {
    return (globalThis as PlatformGlobals).process?.env?.[name];
}

/** The slice of node:fs the file-based features use (trace JSONL, drift snapshots, secrets). */
export interface NodeFs {
    existsSync(path: string): boolean;
    readFileSync(path: string, encoding: 'utf8'): string;
    writeFileSync(path: string, data: string): void;
    appendFileSync(path: string, data: string): void;
    mkdirSync(path: string, options: { recursive: true }): string | undefined;
}

/** Lazily load node:fs (Node ≥ 20.16 / 22.3); undefined in the browser. */
export function nodeFs(): NodeFs | undefined {
    const proc = (globalThis as PlatformGlobals).process;
    return proc?.getBuiltinModule?.('node:fs') as NodeFs | undefined;
}

/** Directory part of a file path (either separator) — node:path's dirname, browser-safe. */
export function dirnameOf(path: string): string {
    const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    if (i < 0) return '.';
    return i === 0 ? path.slice(0, 1) : path.slice(0, i);
}

// Query keys whose values are secrets when they ride in a URL: redacted before a
// URL reaches a trace sink (OTLP `url.full`, the JSONL `start.url`). A key matches
// if (case-insensitively) it is one of these names …
const SECRET_QUERY_KEYS = new Set([
    'key',
    'sig',
    'auth',
    'pwd',
    'code',
    'sas',
    'access_key',
]);
// … or if it CONTAINS one of these stems — so `access_token`, `refresh_token`,
// `client_secret`, `x-amz-signature`, and `apikey` are all caught without listing
// every vendor spelling. Over-matching a benign param is the safe direction here.
const SECRET_QUERY_STEMS = [
    'token',
    'secret',
    'password',
    'passwd',
    'signature',
    'credential',
    'apikey',
    'api_key',
];
const URL_REDACTED = 'REDACTED';

// Caller-registered query-param names that carry a secret value — the escape hatch for a
// credential whose param name the built-in set/stems don't catch. `apiKey({ in: 'query', name })`
// registers its configured `name` here at construction, so a key placed in the URL is redacted in
// every trace sink (the JSONL/console `start.url` via `scrubUrl`, the OTLP `url.full`, and the
// structured `input.query` via `redactSecretQuery`) without listing every vendor spelling. The
// default `api_key` already matches a stem; this covers an arbitrary configured name too.
// Lower-cased on insert so the membership test in `isSecretKey` stays case-insensitive.
const REGISTERED_SECRET_KEYS = new Set<string>();

/**
 * Register an additional key name whose value is a secret (a query-param name, a body
 * field, …), so the trace URL/query scrubbers redact it. Additive and process-wide
 * (mirroring the built-in denylist): names can be widened but never un-redacted.
 * Idempotent — registering the same name twice is a no-op.
 */
export function registerSecretKey(name: string): void {
    REGISTERED_SECRET_KEYS.add(name.toLowerCase());
}

/**
 * True when a key name (a query-param name, a response-body object key, or any
 * key in the same family — a `start` event's `input.query`) carries a secret value:
 * matched case-insensitively against the secret key set above, by containing one of
 * the secret stems, or because a caller registered it via
 * {@link registerSecretKey} (e.g. `apiKey({ in: 'query', name })`).
 */
export function isSecretKey(key: string): boolean {
    const k = key.toLowerCase();
    return (
        SECRET_QUERY_KEYS.has(k) ||
        REGISTERED_SECRET_KEYS.has(k) ||
        SECRET_QUERY_STEMS.some((s) => k.includes(s))
    );
}

/**
 * Deep-clone `value` and replace any object key that matches {@link isSecretKey}
 * (or the caller's `extra` name/path patterns via {@link matchPath}) with the
 * `'REDACTED'` sentinel. Returns a new value — the input is **never mutated**.
 * Walks arrays and plain objects recursively; leaves primitives as-is unless they
 * sit under a redacted key. Used by `.inspect({ redact })` to scrub `raw` before
 * the caller logs or forwards it.
 *
 * @param value - the value to deep-clone and scrub.
 * @param extra - optional extra key-name/path patterns (reuses the {@link matchPath}
 *   grammar: exact, `*` wildcard, or prefix). Added on top of the shared denylist;
 *   the denylist is always applied.
 */
export function redactSecretsDeep(value: unknown, extra?: string[]): unknown {
    return redactSecretsAt(value, extra, undefined);
}

// Recursive worker for redactSecretsDeep: `path` tracks where in the tree we are so the
// caller's `extra` patterns can match full paths, without that state leaking into the export.
function redactSecretsAt(
    value: unknown,
    extra: string[] | undefined,
    path: string | undefined,
): unknown {
    if (Array.isArray(value)) {
        return value.map((item, i) =>
            redactSecretsAt(
                item,
                extra,
                path !== undefined ? `${path}[${i}]` : `[${i}]`,
            ),
        );
    }
    if (value !== null && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            const childPath = path !== undefined ? `${path}.${k}` : k;
            const secret =
                isSecretKey(k) ||
                (extra !== undefined &&
                    (extra.some((p) => matchPath(p, k)) ||
                        (path !== undefined &&
                            extra.some((p) => matchPath(p, childPath)))));
            out[k] = secret
                ? URL_REDACTED
                : redactSecretsAt(v, extra, childPath);
        }
        return out;
    }
    return value;
}

/**
 * Strip credentials from a URL before it reaches a trace sink: removes userinfo
 * (`https://user:pass@host` → `https://host`) and replaces the values of
 * secret-bearing query params (`api_key`, `access_token`, `signature`, …) with
 * `REDACTED`, while keeping benign params (`page`, `sort`) intact for observability.
 * Returns the original string unchanged when there is nothing to scrub (so a clean
 * URL is never reformatted) or when it is not an absolute URL we can parse.
 */
export function scrubUrl(url: string): string {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return url; // relative/opaque/malformed — no structured parts to scrub
    }
    const hadUserinfo = u.username !== '' || u.password !== '';
    u.username = '';
    u.password = '';
    const secretKeys = [...new Set(u.searchParams.keys())].filter(isSecretKey);
    for (const key of secretKeys) {
        // Preserve a repeated key's arity (e.g. `?k=a&k=b` → two REDACTED values).
        const count = u.searchParams.getAll(key).length;
        u.searchParams.delete(key);
        for (let i = 0; i < count; i++)
            u.searchParams.append(key, URL_REDACTED);
    }
    return hadUserinfo || secretKeys.length > 0 ? u.toString() : url;
}
