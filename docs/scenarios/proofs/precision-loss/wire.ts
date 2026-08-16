// The wire, and the digits on it.
//
// Every other proof directory in this repo starts from a fixture OBJECT. This one cannot: the
// entire scenario is the difference between the bytes a vendor sent and the value JavaScript ended
// up holding, and an object literal has already lost that difference. `1234567890123456789` typed
// into a `.ts` file IS `1234567890123456768` — the corruption happens in the TypeScript source,
// before any library code runs. So the fixtures here are STRINGS, and the digits are only ever
// asserted against strings.
//
// `wireAdapter` is likewise not a hand-written stub. It is the library's real `fetchAdapter` with a
// fake `fetch` underneath, so the parse under test is `http-adapter.ts:135` itself —
// `parsed = text === '' ? undefined : JSON.parse(text)` — and not this file's imitation of it. That
// matters more here than anywhere else: a hand-rolled adapter that called `JSON.parse` would prove
// only that `JSON.parse` loses precision, which nobody disputes. What is in question is whether the
// LIBRARY'S path does, and the only way to measure that is to run the library's path.
import { fetchAdapter } from '../../../../packages/core/src/http-adapter';
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
} from '../../../../packages/core/src/types';

export const BASE = 'https://api.snowflake.test';

// ---- the digits ------------------------------------------------------------
// Each is the exact literal a vendor puts on the wire. They are strings so that this file itself
// cannot round them.

/** A Discord/Twitter-style snowflake. 19 digits, comfortably above 2^53. */
export const SNOWFLAKE = '1234567890123456789';
/** 2^53 + 1 — the smallest integer a double cannot represent. The canonical demonstration. */
export const TWO53_PLUS_1 = '9007199254740993';
/** 2^53 - 1 = `Number.MAX_SAFE_INTEGER`. The control: this one MUST survive. */
export const MAX_SAFE = '9007199254740991';
/** int64 max — a `bigint` primary key at the top of its range. */
export const BIGINT_PK = '9223372036854775807';
/** A small legacy ID, far below the danger zone. The second control. */
export const SMALL_ID = '4242';
/** A retail price. Not an integer problem — a binary-fraction problem, same root cause. */
export const MONEY = '19.99';
/** The two addends of the oldest float demo in the world, sent as separate fields. */
export const TENTH = '0.1';
export const FIFTH = '0.2';

/**
 * The vendor's response, as TEXT. Hand-assembled rather than `JSON.stringify`d, because
 * `JSON.stringify` would have to be handed numbers, and handing it numbers is the bug.
 */
export const WIRE_TEXT =
    '{' +
    `"snowflake":${SNOWFLAKE},` +
    `"two53_plus_1":${TWO53_PLUS_1},` +
    `"max_safe":${MAX_SAFE},` +
    `"bigint_pk":${BIGINT_PK},` +
    `"small_id":${SMALL_ID},` +
    `"money":${MONEY},` +
    `"tenth":${TENTH},` +
    `"fifth":${FIFTH},` +
    '"snowflake_str":"' +
    SNOWFLAKE +
    '"' +
    '}';

/** The single-field payload most claims use — one snowflake, nothing else to read past. */
export const ONE_ID_TEXT = `{"id":${SNOWFLAKE}}`;

/** The same shape with a SAFE id, for the control runs. */
export const ONE_SAFE_ID_TEXT = `{"id":${SMALL_ID}}`;

/** A nested/array payload, for the C7 detector's false-positive/negative workload. */
export const NESTED_TEXT =
    '{"page":1,"items":[' +
    `{"id":${SNOWFLAKE},"qty":3},` +
    `{"id":${SMALL_ID},"qty":1}` +
    '],"cursor":"' +
    SNOWFLAKE +
    '"}';

// ---- transports ------------------------------------------------------------

/** An {@link Adapter} that also records what it was handed and what it answered with. */
export interface RecordingAdapter extends Adapter {
    /** Every request the transport received. */
    readonly seen: AdapterRequest[];
    /** How many requests it received. */
    count(): number;
}

/** Options shared by the transports below. */
export interface WireOpts {
    status?: number;
    contentType?: string;
    /** Extra response headers, merged over `content-type`. */
    headers?: Record<string, string>;
}

/**
 * THE transport for this directory: the library's own `fetchAdapter`, fed a fake `fetch` that hands
 * back a real `Response` carrying `text` verbatim. Everything `fetchAdapter` does to a body — the
 * content-type sniff, the `responseType` switch, the `JSON.parse` on line 135 — runs for real.
 *
 * `text` is the wire. Nothing between this string and `AdapterResponse.body` is this file's code.
 */
export function wireAdapter(
    text: string,
    opts: WireOpts = {},
): RecordingAdapter {
    const seen: AdapterRequest[] = [];
    const inner = fetchAdapter({
        fetch: (async () =>
            new Response(text, {
                status: opts.status ?? 200,
                headers: {
                    'content-type': opts.contentType ?? 'application/json',
                    ...opts.headers,
                },
            })) as unknown as typeof fetch,
    });
    const fn = (async (req: AdapterRequest): Promise<AdapterResponse> => {
        seen.push(req);
        return inner(req);
    }) as RecordingAdapter;
    Object.defineProperty(fn, 'seen', { value: seen });
    fn.count = () => seen.length;
    fn.capabilities = { name: 'wireAdapter', supports: ['stream'] };
    return fn;
}

/**
 * A transport that hands back an ALREADY-BUILT body, bypassing any parse. Used by C3/C4 to put a
 * `BigInt`-bearing object into the engine without pretending a parser produced it, and by C6 to
 * hand back a `ReadableStream`.
 */
export function bodyAdapter(
    body: unknown,
    opts: WireOpts = {},
): RecordingAdapter {
    const seen: AdapterRequest[] = [];
    const fn = (async (req: AdapterRequest): Promise<AdapterResponse> => {
        seen.push(req);
        return {
            status: opts.status ?? 200,
            headers: {
                'content-type': opts.contentType ?? 'application/json',
                ...opts.headers,
            },
            body,
        };
    }) as RecordingAdapter;
    Object.defineProperty(fn, 'seen', { value: seen });
    fn.count = () => seen.length;
    fn.capabilities = { name: 'bodyAdapter', supports: ['stream'] };
    return fn;
}

// ---- a bigint-aware JSON parse (no new dependencies) -----------------------
// The capture calls this "regex the raw text first … and is a JSON parser written in regex. Breaks
// on numbers inside strings." That criticism is correct about a regex, so this is not one: it is a
// small single-pass scanner that tracks whether it is inside a string literal (respecting `\\`
// escapes) and only rewrites number tokens found OUTSIDE one. It is roughly 40 lines, which is
// itself a measurement — C3 reports the cost of the repair, and this is the cost.

/**
 * A big-integer token is quoted with this prefix so the reviver can find it again.
 *
 * PRINTABLE ASCII, and that is a deliberate compromise worth naming. The collision-free choice is
 * a control character, precisely because one cannot appear unescaped in a vendor string — but
 * `JSON.parse` rejects a raw control character inside a string literal ("Bad control character in
 * string literal in JSON at position N"), which this directory learned by writing that version
 * first. Emitting it as a six-byte `\\u0001` ESCAPE SEQUENCE instead would work, and is more
 * scanner than the point requires. So: a printable prefix, one residual false positive, and C3(a2)
 * MEASURES that false positive rather than hiding it.
 */
export const SENTINEL = '~bigint~';

/** The reviver's guard: the sentinel followed by nothing but an optional sign and digits. */
const SENTINEL_RE = /^~bigint~(-?\d+)$/;

/**
 * Rewrite every out-of-string integer literal whose magnitude exceeds `Number.MAX_SAFE_INTEGER`
 * into a sentinel-prefixed STRING, so `JSON.parse` never sees the digits as a number.
 */
export function quoteBigInts(text: string): string {
    let out = '';
    let i = 0;
    let inString = false;
    while (i < text.length) {
        const c = text[i] as string;
        if (inString) {
            out += c;
            if (c === '\\') {
                out += text[i + 1] ?? '';
                i += 2;
                continue;
            }
            if (c === '"') inString = false;
            i += 1;
            continue;
        }
        if (c === '"') {
            inString = true;
            out += c;
            i += 1;
            continue;
        }
        // A number token starts with `-` or a digit, and may only START here if the previous
        // non-space character was structural — which, outside a string, it always is in valid JSON.
        if (c === '-' || (c >= '0' && c <= '9')) {
            let j = i;
            if (text[j] === '-') j += 1;
            while (
                j < text.length &&
                (text[j] as string) >= '0' &&
                (text[j] as string) <= '9'
            )
                j += 1;
            const isInteger =
                text[j] !== '.' && text[j] !== 'e' && text[j] !== 'E';
            const token = text.slice(i, j);
            if (isInteger && !Number.isSafeInteger(Number(token))) {
                out += `"${SENTINEL}${token}"`;
            } else {
                // Not big, or not an integer — copy the whole token (including any fraction and
                // exponent) unchanged.
                let k = j;
                if (text[k] === '.') {
                    k += 1;
                    while (
                        k < text.length &&
                        (text[k] as string) >= '0' &&
                        (text[k] as string) <= '9'
                    )
                        k += 1;
                }
                if (text[k] === 'e' || text[k] === 'E') {
                    k += 1;
                    if (text[k] === '+' || text[k] === '-') k += 1;
                    while (
                        k < text.length &&
                        (text[k] as string) >= '0' &&
                        (text[k] as string) <= '9'
                    )
                        k += 1;
                }
                out += text.slice(i, k);
                i = k;
                continue;
            }
            i = j;
            continue;
        }
        out += c;
        i += 1;
    }
    return out;
}

/** `JSON.parse` with big integers preserved as `BigInt`. Built on {@link quoteBigInts}. */
export function parseWithBigInt(text: string): unknown {
    return JSON.parse(quoteBigInts(text), (_k: string, v: unknown) => {
        if (typeof v !== 'string') return v;
        const m = SENTINEL_RE.exec(v);
        return m ? BigInt(m[1] as string) : v;
    });
}

/**
 * `JSON.parse` with big integers preserved as STRINGS — the other half of C3's fork.
 *
 * Takes `unknown`, not `string`, and that is not laziness. `StitchConfig.transform` is typed
 * `(body: unknown) => unknown` — it has to be, since it sits downstream of an `AdapterResponse.body`
 * that is `unknown` — so a parser written as `(text: string)` does NOT typecheck in a `transform`
 * slot even when `wire.response: 'text'` guarantees a string at runtime. The narrowing has to happen
 * inside the function. C8(c) reports this as one of the costs; it is measured here in the signature.
 */
export function parseBigIntsAsStrings(body: unknown): unknown {
    return JSON.parse(quoteBigInts(String(body)), (_k: string, v: unknown) => {
        if (typeof v !== 'string') return v;
        const m = SENTINEL_RE.exec(v);
        return m ? (m[1] as string) : v;
    });
}

/**
 * An {@link Adapter} that reads the wire with {@link parseWithBigInt} instead of `JSON.parse` —
 * C3's repair, spelled as the one seam the capture says is available.
 */
export function bigintAdapter(
    text: string,
    opts: WireOpts = {},
): RecordingAdapter {
    const seen: AdapterRequest[] = [];
    const fn = (async (req: AdapterRequest): Promise<AdapterResponse> => {
        seen.push(req);
        return {
            status: opts.status ?? 200,
            headers: {
                'content-type': opts.contentType ?? 'application/json',
                ...opts.headers,
            },
            body: parseWithBigInt(text),
        };
    }) as RecordingAdapter;
    Object.defineProperty(fn, 'seen', { value: seen });
    fn.count = () => seen.length;
    fn.capabilities = { name: 'bigintAdapter', supports: [] };
    return fn;
}

/** Render a `DriftFinding` as `level|change|path|detail` — the format the other proofs use. */
export function fmt(f: {
    level?: string;
    change?: string;
    path?: string;
    detail?: string;
    message?: string;
}): string {
    return [
        f.level ?? '?',
        f.change ?? '?',
        f.path ?? '',
        f.detail ?? f.message ?? '',
    ].join('|');
}
