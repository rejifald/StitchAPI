/**
 * Conformance kit for StitchAPI's pluggable seams — published as
 * `stitchapi/testing`.
 *
 * Every seam in the core is a contract, not a dependency: the transport
 * ({@link Adapter}), the state store ({@link StitchStore}), and the trace sink
 * ({@link TraceSink}) each have a small documented surface, core ships only
 * platform defaults for them, and vendor implementations live in their own
 * packages. ANY implementation that passes the relevant `verify*Contract`
 * function here is a valid seam implementation — third-party authors run the
 * kit in their own CI to prove compliance without depending on StitchAPI
 * internals.
 *
 * Framework-agnostic and browser-safe by design: every verifier is a plain
 * async function that RETURNS a {@link ContractReport} (no vitest/jest
 * imports, no `node:*` modules, no `process.env`), so it runs inside any test
 * runner — or a browser. Pair with {@link assertConformance} for a one-line
 * test body.
 */
import type {
    Adapter,
    AdapterRequest,
    StitchEvent,
    StitchStore,
    TraceSink,
} from './types';

/**
 * The outcome of one `verify*Contract` run.
 *
 * Rules are checked independently — one violation never masks another — so a
 * failing report lists EVERY broken rule, each with a human-readable detail.
 */
export interface ContractReport {
    /** Which seam was verified: `'store'`, `'adapter'`, or `'sink'`. */
    seam: string;
    /** `true` when every rule passed. */
    ok: boolean;
    /** Names of the rules that passed. */
    passed: string[];
    /** One entry per failed rule. Empty when `ok` is `true`. */
    violations: { rule: string; detail: string }[];
}

/**
 * Throw one readable `Error` listing every violation in `report`; a no-op when
 * the report is clean. The one-liner for user test bodies:
 *
 * ```ts
 * assertConformance(await verifyStoreContract(() => myStore()));
 * ```
 */
export function assertConformance(report: ContractReport): void {
    if (report.ok) return;
    const lines = report.violations
        .map((v) => `  - ${v.rule}: ${v.detail}`)
        .join('\n');
    throw new Error(
        `StitchAPI ${report.seam} contract: ${report.violations.length} violation(s), ` +
            `${report.passed.length} rule(s) passed\n${lines}`,
    );
}

// ---------------------------------------------------------------------------
// rule runner + tiny assertion helpers (no test framework)
// ---------------------------------------------------------------------------

type Rule = [name: string, run: () => void | Promise<void>];

// Run every rule, catching each independently so one violation cannot mask
// the others; a thrown Error's message becomes the violation detail.
async function runRules(seam: string, rules: Rule[]): Promise<ContractReport> {
    const passed: string[] = [];
    const violations: { rule: string; detail: string }[] = [];
    for (const [rule, run] of rules) {
        try {
            await run();
            passed.push(rule);
        } catch (error) {
            violations.push({ rule, detail: detailOf(error) });
        }
    }
    return { seam, ok: violations.length === 0, passed, violations };
}

const detailOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

function show(value: unknown): string {
    if (value === undefined) return 'undefined';
    try {
        return JSON.stringify(value);
    } catch {
        return '[unserializable value]';
    }
}

// Key-order-insensitive structural comparison via a stable JSON encoding.
function stable(value: unknown): string {
    return JSON.stringify(value, (_key, v: unknown) =>
        v !== null && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(
                  Object.entries(v as Record<string, unknown>).sort(
                      ([a], [b]) => a.localeCompare(b),
                  ),
              )
            : v,
    );
}

function expectDeepEqual(
    actual: unknown,
    expected: unknown,
    label: string,
): void {
    if (stable(actual) !== stable(expected)) {
        throw new Error(
            `${label}: expected ${show(expected)}, got ${show(actual)}`,
        );
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Accept the documented AdapterResponse body contract ("parsed JSON when
// possible, else text"): an already-parsed object, or raw JSON text.
function asJsonObject(body: unknown, label: string): Record<string, unknown> {
    let value = body;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            /* fall through to the type check below */
        }
    }
    if (isRecord(value)) return value;
    throw new Error(`${label}: expected a JSON object, got ${show(body)}`);
}

// ---------------------------------------------------------------------------
// store contract
// ---------------------------------------------------------------------------

/**
 * Verify that a {@link StitchStore} implementation honors the store contract
 * the engine relies on for throttle counters and auth/session state:
 *
 * - `set`/`get` round-trips a value; a missing key resolves to `undefined`;
 *   a second `set` overwrites; writes are isolated by key.
 * - `set(key, value, ttlMs)` expires the value after `ttlMs`; a `set` without
 *   `ttlMs` does not expire.
 * - `incr(key, ttlMs)` initializes a missing key to 1, increments an existing
 *    counter, is ATOMIC within a process (20 concurrent calls return
 *    1..20 exactly), and restarts at 1 once its TTL window lapses.
 *
 * TTL rules use real timers with a small window (default 60ms); raise
 * `opts.ttlMs` for backends with coarser expiry. Keys are namespaced per run,
 * so reruns against a persistent backend (Redis, Postgres, ...) never collide.
 *
 * @param makeStore Factory for the store under test; awaited, so it may
 *   connect to a real backend.
 * @param opts `ttlMs` — the expiry window the TTL rules use (default 60).
 */
export async function verifyStoreContract(
    makeStore: () => StitchStore | Promise<StitchStore>,
    opts?: { ttlMs?: number },
): Promise<ContractReport> {
    const ttlMs = opts?.ttlMs ?? 60;
    const store = await makeStore();
    const ns = `stitch-conformance:${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2)}`;
    const k = (rule: string): string => `${ns}:${rule}`;

    const rules: Rule[] = [
        [
            'set/get: round-trips a value',
            async () => {
                await store.set(k('rt'), { kit: 'stitchapi', n: 7 });
                expectDeepEqual(
                    await store.get(k('rt')),
                    { kit: 'stitchapi', n: 7 },
                    'get after set',
                );
            },
        ],
        [
            'get: a missing key resolves to undefined',
            async () => {
                const value = await store.get(k('missing'));
                if (value !== undefined) {
                    throw new Error(`expected undefined, got ${show(value)}`);
                }
            },
        ],
        [
            'set: overwrite replaces the value',
            async () => {
                await store.set(k('ow'), 'first');
                await store.set(k('ow'), 'second');
                expectDeepEqual(
                    await store.get(k('ow')),
                    'second',
                    'get after overwrite',
                );
            },
        ],
        [
            'set: a ttlMs entry expires',
            async () => {
                await store.set(k('ttl'), 'soon-gone', ttlMs);
                expectDeepEqual(
                    await store.get(k('ttl')),
                    'soon-gone',
                    'get before expiry',
                );
                await sleep(ttlMs + 50);
                const after = await store.get(k('ttl'));
                if (after !== undefined) {
                    throw new Error(
                        `value survived its ${ttlMs}ms TTL: got ${show(after)}`,
                    );
                }
            },
        ],
        [
            'set: no ttlMs means no expiry',
            async () => {
                await store.set(k('keep'), 'kept');
                await sleep(ttlMs + 50);
                expectDeepEqual(
                    await store.get(k('keep')),
                    'kept',
                    'get without ttl after a wait',
                );
            },
        ],
        [
            'incr: initializes a missing key to 1',
            async () => {
                const first = await store.incr(k('init'), 5_000);
                if (first !== 1) {
                    throw new Error(`expected 1, got ${show(first)}`);
                }
            },
        ],
        [
            'incr: increments an existing counter',
            async () => {
                await store.incr(k('seq'), 5_000);
                const second = await store.incr(k('seq'), 5_000);
                if (second !== 2) {
                    throw new Error(`expected 2, got ${show(second)}`);
                }
            },
        ],
        [
            'incr: 20 concurrent calls net exactly +20',
            async () => {
                const results = await Promise.all(
                    Array.from({ length: 20 }, () =>
                        store.incr(k('atomic'), 5_000),
                    ),
                );
                const sorted = [...results].sort((a, b) => a - b);
                const wanted = Array.from({ length: 20 }, (_, i) => i + 1);
                expectDeepEqual(
                    sorted,
                    wanted,
                    'sorted results of 20 concurrent incrs (non-atomic stores collide)',
                );
            },
        ],
        [
            'incr: the counter expires after ttlMs',
            async () => {
                await store.incr(k('window'), ttlMs);
                await sleep(ttlMs + 50);
                const restarted = await store.incr(k('window'), ttlMs);
                if (restarted !== 1) {
                    throw new Error(
                        `expected a fresh window to restart at 1, got ${show(restarted)}`,
                    );
                }
            },
        ],
        [
            'keys: writes are isolated by key',
            async () => {
                await store.set(k('iso-a'), 'a');
                await store.set(k('iso-b'), 'b');
                await store.incr(k('iso-n'), 5_000);
                expectDeepEqual(await store.get(k('iso-a')), 'a', 'iso-a');
                expectDeepEqual(await store.get(k('iso-b')), 'b', 'iso-b');
            },
        ],
    ];
    return runRules('store', rules);
}

// ---------------------------------------------------------------------------
// adapter contract
// ---------------------------------------------------------------------------

const TEXT_BODY = 'stitch-conformance-text';
const JSON_BODY = { kit: 'stitchapi', numbers: [1, 2, 3] };
const SLOW_DELAY_MS = 300;
const ABORT_AFTER_MS = 25;
const ABORT_PROMPT_MS = 200;

/** The request shape {@link adapterContractFixture} consumes. */
export interface FixtureRequest {
    /** HTTP method, any case. */
    method: string;
    /** Path plus optional query string, e.g. `'/echo'` or `'/status/404?x=1'`. */
    path: string;
    /** Request headers with LOWERCASED names — the host lowercases them. */
    headers: Record<string, string>;
    /** Raw request body text, when there is one. */
    body?: string;
}

/** The response shape {@link adapterContractFixture} produces. */
export interface FixtureResponse {
    status: number;
    /** Response headers (lowercased names). */
    headers: Record<string, string>;
    /** Raw response body text. */
    body: string;
    /** When set, the host MUST delay sending the response by this many ms. */
    delayMs?: number;
}

/**
 * The echo contract {@link verifyAdapterContract} verifies a transport
 * against, as a PURE function — request in, response out, no server — so you
 * can mount it on anything: `node:http`, hono, a service worker, ...
 *
 * Routes (matched after stripping any query string):
 *
 * - `GET /status/{code}` → that status, JSON body `{"status":code}`.
 * - ANY `/echo` → 200, JSON body `{ method, headers, body, json }` echoing
 *   the request as the server saw it (`json` is the request body parsed as
 *   JSON, or `null` when absent/unparseable).
 * - `GET /text` → 200 `text/plain` body `"stitch-conformance-text"` with the
 *   response header `x-stitch-echo: text`.
 * - `GET /json` → 200 `application/json` body
 *   `{"kit":"stitchapi","numbers":[1,2,3]}` with `x-stitch-echo: json`.
 * - `GET /slow` → 200 JSON `{"slow":true}` with `delayMs: 300`.
 * - anything else → 404 JSON `{"error":"not_found"}`.
 *
 * Host duties: lowercase request header names, hand over the raw request body
 * text, and honor `delayMs` (the in-flight abort rule depends on it).
 */
export function adapterContractFixture(req: FixtureRequest): FixtureResponse {
    const path = req.path.split('?', 1)[0] ?? req.path;
    const method = req.method.toUpperCase();

    const json = (
        status: number,
        value: unknown,
        headers: Record<string, string> = {},
    ): FixtureResponse => ({
        status,
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(value),
    });

    if (path.startsWith('/status/')) {
        const code = Number(path.slice('/status/'.length));
        if (Number.isInteger(code) && code >= 100 && code <= 599) {
            return json(code, { status: code });
        }
    }
    if (path === '/echo') {
        let parsed: unknown = null;
        if (req.body !== undefined && req.body !== '') {
            try {
                parsed = JSON.parse(req.body);
            } catch {
                parsed = null;
            }
        }
        return json(200, {
            method,
            headers: req.headers,
            body: req.body ?? '',
            json: parsed,
        });
    }
    if (path === '/text' && method === 'GET') {
        return {
            status: 200,
            headers: {
                'content-type': 'text/plain; charset=utf-8',
                'x-stitch-echo': 'text',
            },
            body: TEXT_BODY,
        };
    }
    if (path === '/json' && method === 'GET') {
        return json(200, JSON_BODY, { 'x-stitch-echo': 'json' });
    }
    if (path === '/slow' && method === 'GET') {
        return { ...json(200, { slow: true }), delayMs: SLOW_DELAY_MS };
    }
    return json(404, { error: 'not_found' });
}

/**
 * Verify that an {@link Adapter} implements the transport contract against a
 * host serving {@link adapterContractFixture} at `opts.baseUrl`:
 *
 * - Status passthrough: 200/404/500 all RESOLVE — an adapter never throws on
 *   a non-2xx status; only network/abort errors reject.
 * - Request delivery: method, headers, and the JSON-encoded body reach the
 *   server intact.
 * - Response headers are readable using LOWERCASED names (the documented
 *   {@link AdapterResponse} case convention).
 * - Body decoding: a `text/plain` body round-trips as a string; an
 *   `application/json` body round-trips as parsed data.
 * - Abort: a pre-aborted `AbortSignal` rejects, and an in-flight abort
 *   rejects promptly instead of waiting out the response.
 *
 * @param adapter The transport under test.
 * @param opts `baseUrl` — origin of a server mounting the fixture, e.g.
 *   `http://127.0.0.1:4123`.
 */
export async function verifyAdapterContract(
    adapter: Adapter,
    opts: { baseUrl: string },
): Promise<ContractReport> {
    const base = opts.baseUrl.replace(/\/+$/, '');
    const request = (
        method: string,
        path: string,
        extra?: Partial<AdapterRequest>,
    ): AdapterRequest => ({
        url: `${base}${path}`,
        method,
        headers: {},
        ...extra,
    });

    const expectStatus = async (code: number): Promise<void> => {
        const res = await adapter(request('GET', `/status/${code}`));
        if (res.status !== code) {
            throw new Error(`expected status ${code}, got ${show(res.status)}`);
        }
    };

    const rules: Rule[] = [
        ['status: 200 resolves with status 200', () => expectStatus(200)],
        ['status: 404 resolves without throwing', () => expectStatus(404)],
        ['status: 500 resolves without throwing', () => expectStatus(500)],
        [
            'request: method, headers, and body are delivered',
            async () => {
                const res = await adapter(
                    request('POST', '/echo', {
                        headers: { 'x-stitch-probe': 'alpha' },
                        body: { ping: 'pong', n: 7 },
                    }),
                );
                const echo = asJsonObject(res.body, 'echo response body');
                if (echo['method'] !== 'POST') {
                    throw new Error(
                        `server saw method ${show(echo['method'])}, expected "POST"`,
                    );
                }
                const headers = echo['headers'];
                const probe = isRecord(headers)
                    ? headers['x-stitch-probe']
                    : undefined;
                if (probe !== 'alpha') {
                    throw new Error(
                        `request header x-stitch-probe did not reach the server (saw ${show(probe)})`,
                    );
                }
                expectDeepEqual(
                    echo['json'],
                    { ping: 'pong', n: 7 },
                    'request body as the server saw it',
                );
            },
        ],
        [
            'response: headers are readable with lowercase names',
            async () => {
                const res = await adapter(request('GET', '/json'));
                if (res.headers['x-stitch-echo'] !== 'json') {
                    throw new Error(
                        `expected headers['x-stitch-echo'] === 'json', got ${show(
                            res.headers['x-stitch-echo'],
                        )} — AdapterResponse headers must use lowercased names`,
                    );
                }
            },
        ],
        [
            'response: text body round-trips',
            async () => {
                const res = await adapter(request('GET', '/text'));
                expectDeepEqual(res.body, TEXT_BODY, 'text/plain body');
            },
        ],
        [
            'response: JSON body round-trips as parsed data',
            async () => {
                const res = await adapter(request('GET', '/json'));
                expectDeepEqual(res.body, JSON_BODY, 'application/json body');
            },
        ],
        [
            'abort: a pre-aborted signal rejects',
            async () => {
                const controller = new AbortController();
                controller.abort();
                let resolved = false;
                try {
                    await adapter(
                        request('GET', '/json', {
                            signal: controller.signal,
                        }),
                    );
                    resolved = true;
                } catch {
                    /* expected */
                }
                if (resolved) {
                    throw new Error(
                        'adapter resolved although the signal was already aborted',
                    );
                }
            },
        ],
        [
            'abort: an in-flight abort rejects promptly',
            async () => {
                const controller = new AbortController();
                const started = Date.now();
                const pending = adapter(
                    request('GET', '/slow', { signal: controller.signal }),
                );
                const timer = setTimeout(() => {
                    controller.abort();
                }, ABORT_AFTER_MS);
                let outcome: 'resolved' | 'rejected';
                try {
                    await pending;
                    outcome = 'resolved';
                } catch {
                    outcome = 'rejected';
                }
                clearTimeout(timer);
                const elapsed = Date.now() - started;
                if (outcome === 'resolved') {
                    throw new Error(
                        'adapter resolved a /slow request despite an in-flight abort ' +
                            '(is the host honoring the fixture delayMs?)',
                    );
                }
                if (elapsed > ABORT_PROMPT_MS) {
                    throw new Error(
                        `abort rejected only after ${elapsed}ms — the adapter waited ` +
                            'out the response instead of aborting',
                    );
                }
            },
        ],
    ];
    return runRules('adapter', rules);
}

// ---------------------------------------------------------------------------
// sink contract
// ---------------------------------------------------------------------------

const SINK_AT = 1_700_000_000_000;

// Canonical sequence covering EVERY StitchEvent variant — including 'delta',
// which the type declares ahead of engine support; a conforming sink must
// already tolerate it.
const SINK_EVENT_FIXTURES: readonly StitchEvent[] = [
    {
        type: 'start',
        name: 'conformance',
        method: 'GET',
        url: 'https://api.example.test/users?page=1',
        input: { query: { page: 1 } },
        at: SINK_AT,
    },
    {
        type: 'progress',
        phase: 'throttled',
        attempt: 1,
        detail: 'rate',
        waitedMs: 12,
        at: SINK_AT + 1,
    },
    {
        type: 'drift',
        finding: {
            level: 'warn',
            path: 'data[].name',
            change: 'type-changed',
            detail: 'string -> number',
        },
        at: SINK_AT + 2,
    },
    { type: 'delta', chunk: { partial: true }, at: SINK_AT + 3 },
    {
        type: 'result',
        value: { users: [] },
        status: 200,
        attempts: 1,
        at: SINK_AT + 4,
    },
    {
        type: 'error',
        name: 'conformance',
        message: 'upstream 503',
        status: 503,
        attempts: 2,
        at: SINK_AT + 5,
    },
    { type: 'done', ok: true, ms: 34, attempts: 1, at: SINK_AT + 6 },
];

/**
 * Verify that a {@link TraceSink} implements the sink contract: `handle` must
 * accept a canonical fixture sequence covering ALL `StitchEvent` variants —
 * `start`, `progress`, `drift`, `delta`, `result`, `error`, `done` — without
 * throwing ('delta' is declared by the type ahead of engine support, so a
 * conforming sink must already tolerate it), and the optional `flush()` must
 * settle without throwing when present.
 *
 * @param makeSink Factory for the sink under test; one sink instance receives
 *   the whole sequence in order.
 */
export function verifySinkContract(
    makeSink: () => TraceSink,
): Promise<ContractReport> {
    const sink = makeSink();
    const ctx = { name: 'conformance' };
    const rules: Rule[] = SINK_EVENT_FIXTURES.map(
        (event): Rule => [
            `handle: accepts a '${event.type}' event`,
            () => {
                sink.handle(event, ctx);
            },
        ],
    );
    rules.push([
        'flush: optional flush() settles without throwing',
        async () => {
            if (typeof sink.flush === 'function') await sink.flush();
        },
    ]);
    return runRules('sink', rules);
}
