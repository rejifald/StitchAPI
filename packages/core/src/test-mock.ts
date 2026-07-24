// A browser-safe mock transport for testing stitch DEFINITIONS: inject it as `adapter` and the real
// runtime runs (validation, unwrap, retry, pagination, streaming) against canned responses — no
// socket, no global-fetch monkeypatching. Productizes the internal `test/support/mock-server.ts`
// at the {@link Adapter} layer (the contract is `(req) => Promise<res>`), so it runs in any test
// runner or a browser. For deep transport semantics over a real socket the lib still uses the node
// mock server internally; this is the published, isomorphic counterpart.
import { streamOf } from './test-stream';
import type { Adapter, AdapterRequest, AdapterResponse } from './types';
import { parseDuration } from './util';

/** One canned response. Omitted fields default sensibly (`status` 200, empty headers). */
export interface MockResponse {
    /** HTTP status. Default `200`. */
    status?: number;
    /** Response headers (keys are lowercased before delivery, matching real adapters). */
    headers?: Record<string, string>;
    /** The already-decoded response body — an object/array is delivered as-is (the engine treats
     *  `AdapterResponse.body` as parsed), a string/bytes verbatim. Ignored when `stream` is set. */
    body?: unknown;
    /** A live response body for the `stream`/`sse` surfaces — a `ReadableStream`, or chunks that
     *  {@link streamOf} turns into one. Delivered as `AdapterResponse.body`. */
    stream?: ReadableStream<Uint8Array> | (string | Uint8Array)[];
    /** Wait this long before responding — `100`, `'100ms'`, `'1s'`; abortable, so a stitch `timeout`
     *  cancels it like a real slow endpoint. Drives timeout / `Retry-After` pacing tests. */
    delay?: number | string;
    /** Sets the `Retry-After` header in SECONDS (or an HTTP-date string) — for `429`/`503` retry and
     *  `throttle.delegate` tests. Named with its true unit per CONTRACT.md P17 (a wire format speaks
     *  seconds, not the house ms). */
    retryAfterSeconds?: number | string;
}

/** One call's context, passed to a function responder. */
export interface MockCall {
    /** 0-based index of this call to the matched route (drives status/body sequences). */
    index: number;
    /** The outgoing request the engine built. */
    req: AdapterRequest;
}

/** A route's response: one fixed reply, a per-call sequence (last entry repeats), or a function. */
export type MockResponder =
    | MockResponse
    | MockResponse[]
    | ((call: MockCall) => MockResponse | Promise<MockResponse>);

/** How a route (or a spy filter) selects a request: by pathname/substring, regex, or predicate. */
export type MockMatch = string | RegExp | ((req: AdapterRequest) => boolean);

/** A single route. With no `method`/`match` it catches every request. */
export interface MockRoute {
    /** HTTP method to match (case-insensitive). Omitted = any method. */
    method?: string;
    /** Which requests this route answers. A string matches the URL pathname (or, failing that, any
     *  substring of the full URL); a `RegExp` tests the full URL; a function is a predicate.
     *  Omitted = any URL. */
    match?: MockMatch;
    /** The reply. */
    respond: MockResponder;
}

/** Options for {@link mockAdapter}. */
export interface MockAdapterOptions {
    /** What to do when no route matches. `'throw'` (default) raises a descriptive transport error
     *  so an unexpected request fails the test loudly; a number replies with that bare status. */
    onUnmatched?: 'throw' | number;
}

/** An {@link Adapter} with a request spy attached. */
export interface MockAdapter extends Adapter {
    /** Every request received (optionally filtered by pathname/substring, regex, or predicate). */
    calls(filter?: MockMatch): AdapterRequest[];
    /** How many requests were received — assert retry/cache call counts with this. */
    callCount(filter?: MockMatch): number;
    /** The most recent request, or `undefined` if none. */
    lastRequest(): AdapterRequest | undefined;
    /** Forget all recorded calls and reset every route's call counter. */
    reset(): void;
}

const pathnameOf = (url: string): string => {
    try {
        return new URL(url, 'http://localhost').pathname;
    } catch {
        return url;
    }
};

const matches = (req: AdapterRequest, m: MockMatch | undefined): boolean => {
    if (m === undefined) return true;
    if (typeof m === 'function') return m(req);
    if (m instanceof RegExp) return m.test(req.url);
    return pathnameOf(req.url) === m || req.url.includes(m);
};

const at = <T>(arr: T[], i: number): T => arr[Math.min(i, arr.length - 1)] as T;

// An abortable delay: rejects the moment `signal` aborts, so a stitch `timeout` (which aborts the
// per-attempt signal) cancels a slow mock response exactly as it would a real socket.
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
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

/**
 * Build a mock {@link Adapter} from one route or a list. The first route whose `method`+`match`
 * accept a request answers it; the response can be fixed, a per-call sequence, or a function of the
 * call. Inject it as a stitch/seam `adapter`:
 *
 * ```ts
 * const api = mockAdapter([
 *   { method: 'GET', match: '/users/42', respond: { body: { id: 42, name: 'Ada' } } },
 *   { match: '/flaky', respond: [{ status: 503 }, { status: 503 }, { body: { ok: true } }] },
 * ]);
 * const getUser = stitch({ baseUrl: 'https://api.test', path: '/users/{id}', adapter: api });
 * await getUser({ params: { id: 42 } });
 * expect(api.callCount('/users/42')).toBe(1);
 * ```
 */
export function mockAdapter(
    routes: MockRoute | MockRoute[],
    opts: MockAdapterOptions = {},
): MockAdapter {
    const list = Array.isArray(routes) ? routes : [routes];
    const counters = new Array<number>(list.length).fill(0);
    const log: AdapterRequest[] = [];

    const build = (r: MockResponse): AdapterResponse => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(r.headers ?? {}))
            headers[k.toLowerCase()] = v;
        if (r.retryAfterSeconds !== undefined)
            headers['retry-after'] = String(r.retryAfterSeconds);
        const body = r.stream
            ? Array.isArray(r.stream)
                ? streamOf(r.stream)
                : r.stream
            : r.body;
        return { status: r.status ?? 200, headers, body };
    };

    const adapter = (async (req: AdapterRequest): Promise<AdapterResponse> => {
        log.push(req);
        const idx = list.findIndex(
            (r) =>
                (r.method === undefined ||
                    r.method.toUpperCase() === req.method.toUpperCase()) &&
                matches(req, r.match),
        );
        if (idx === -1) {
            if (typeof opts.onUnmatched === 'number')
                return { status: opts.onUnmatched, headers: {}, body: {} };
            throw new Error(
                `mockAdapter: no route matched ${req.method} ${req.url}`,
            );
        }
        const route = list[idx] as MockRoute;
        const callIndex = counters[idx] as number;
        counters[idx] = callIndex + 1;

        const r: MockResponse = Array.isArray(route.respond)
            ? at(route.respond, callIndex)
            : typeof route.respond === 'function'
              ? await route.respond({ index: callIndex, req })
              : route.respond;

        const delay = parseDuration(r.delay);
        if (delay && delay > 0) await sleep(delay, req.signal);
        return build(r);
    }) as MockAdapter;

    const filter = (f?: MockMatch): AdapterRequest[] =>
        f === undefined ? log.slice() : log.filter((req) => matches(req, f));

    adapter.calls = filter;
    adapter.callCount = (f) => filter(f).length;
    adapter.lastRequest = () => log[log.length - 1];
    adapter.reset = () => {
        log.length = 0;
        counters.fill(0);
    };
    return adapter;
}
