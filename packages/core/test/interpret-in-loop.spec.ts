// ADR 0022 Decision 1 — `interpret` runs INSIDE the attempt loop, as the terminal verdict of each
// attempt, on every response including the non-2xx the engine used to throw on first.
//
// accept-status.spec.ts is the regression gate (it must pass with the slot spelling unchanged);
// this file pins what the reordering BUYS, and the invariant it must not break.
import { type StitchError, type StitchEvent, stitch } from '../src';
import type { Surface } from '../src/surface';
import { httpFailure } from '../src/surface';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});

async function rejectionOf(call: PromiseLike<unknown>): Promise<StitchError> {
    return Promise.resolve(call).then(
        () => {
            throw new Error('expected the call to reject, but it resolved');
        },
        (e: unknown) => e as StitchError,
    );
}

describe('a surface’s interpret now SEES every response (Decision 1)', () => {
    test('interpret is handed a 404 — previously the engine threw before any hook ran', async () => {
        server.route('GET', '/gone', {
            statuses: [404],
            body: { error: 'gone' },
        });
        const seen: number[] = [];
        const spy: Surface = {
            id: 'spy',
            interpret: (res, cfg) => {
                seen.push(res.status);
                return httpFailure(res, cfg) ?? { ok: true, data: res.body };
            },
        };

        await rejectionOf(
            stitch({ baseUrl: server.url, path: '/gone', kind: spy })(),
        );
        expect(seen).toEqual([404]);
    });

    // The capability #155 minted `acceptStatus` for (now `verdict.accept`), now reachable from a surface with NO config:
    // the surface itself rules a non-2xx a normal result.
    test('a surface can accept a non-2xx on its own authority, with no verdict.accept', async () => {
        server.route('GET', '/tolerant', {
            statuses: [404],
            body: { items: [] },
        });
        const tolerant: Surface = {
            id: 'tolerant',
            // A 404 means "no items" for this API — a result, not an error.
            interpret: (res) =>
                res.status === 404
                    ? { ok: true, data: { items: [] } }
                    : { ok: true, data: res.body },
        };

        await expect(
            stitch({
                baseUrl: server.url,
                path: '/tolerant',
                kind: tolerant,
            })(),
        ).resolves.toEqual({ items: [] });
    });

    test('a surface rejecting a non-2xx still throws a StitchError carrying status and body', async () => {
        server.route('GET', '/boom', {
            statuses: [500],
            body: { error: 'kaput' },
        });
        const err = await rejectionOf(
            stitch({ baseUrl: server.url, path: '/boom' })(),
        );
        expect(err.name).toBe('StitchError');
        expect(err.status).toBe(500);
        expect(err.body).toEqual({ error: 'kaput' });
    });
});

// The invariant the routing in `attemptLoop` exists to hold. `circuit` behaviour is on this ADR's
// "what does not change" list, and it would have moved silently: before the reordering a graphql
// `{ errors }` response returned NORMALLY from the loop (recording a circuit success) and only
// failed later; a naive "interpret fails ⇒ throw" would have started tripping the breaker on
// application-level errors, so one bad query could open the circuit for every call to that host.
describe('circuit tracks TRANSPORT health, not the surface’s verdict', () => {
    const failingBody: Surface = {
        id: 'always-rejects',
        interpret: (res) => ({
            ok: false,
            message: 'payload rejected',
            status: res.status,
        }),
    };

    test('a 200 the surface rejects does NOT open the circuit', async () => {
        server.route('GET', '/app-error', {
            statuses: [200, 200, 200],
            body: {},
        });
        const call = stitch({
            baseUrl: server.url,
            path: '/app-error',
            kind: failingBody,
            circuit: { failures: 2, cooldown: '1m' },
        });

        for (let i = 0; i < 3; i++) {
            const err = await rejectionOf(call());
            // Never a CircuitOpenError — every attempt reached the network.
            expect(err.message).toContain('payload rejected');
        }
        // All three calls hit the server: the breaker never fast-failed one.
        expect(server.callCount('/app-error')).toBe(3);
    });

    test('a failing STATUS still opens the circuit', async () => {
        server.route('GET', '/host-down', {
            statuses: [500, 500, 500],
            body: { error: 'down' },
        });
        const call = stitch({
            baseUrl: server.url,
            path: '/host-down',
            circuit: { failures: 2, cooldown: '1m' },
        });

        await rejectionOf(call());
        await rejectionOf(call());
        const third = await rejectionOf(call());

        // The breaker opened after two transport failures, so the third never left the process.
        // Two tells, both required: the network count stopped rising, and the third rejection
        // reports the breaker's own `503` rather than the origin's `500` — it never reached the
        // origin to learn one.
        expect(server.callCount('/host-down')).toBe(2);
        expect(third.status).toBe(503);
    });
});

describe('an application-level rejection keeps its own error event shape', () => {
    test('a graphql 200-with-errors yields one error event and done.ok false', async () => {
        server.route('POST', '/gql', {
            body: { errors: [{ message: 'bad field' }] },
        });
        const q = stitch({
            baseUrl: server.url,
            path: '/gql',
            kind: (await import('../src/surface')).graphqlSurface,
            document: '{ nope }',
        });

        const events: StitchEvent[] = [];
        for await (const ev of q.stream()) events.push(ev);

        const errs = events.filter((e) => e.type === 'error');
        expect(errs).toHaveLength(1);
        expect(errs[0]).toMatchObject({ message: 'GraphQL: bad field' });
        expect(events.find((e) => e.type === 'done')).toMatchObject({
            ok: false,
        });
    });
});

// ADR 0022 Decision 5 (issue #529) — the retry arm. Expressible only because Decision 1 put
// `interpret` inside the loop: a surface that has READ the body can ask for another attempt.
describe('the SurfaceOutcome retry arm (Decision 5)', () => {
    // A poller: the resource reports PENDING until it is READY. No status is ever non-2xx, so
    // `retry.on` could never see this — only the body knows.
    const poller: Surface = {
        id: 'poller',
        interpret: (res) => {
            const body = res.body as { status?: string };
            return body.status === 'PENDING'
                ? { ok: false, retry: true, message: 'PENDING', after: 1 }
                : { ok: true, data: body };
        },
    };

    test('a 200 the surface rules PENDING is re-attempted, then resolves', async () => {
        server.route('GET', '/job', {
            statuses: [200, 200, 200],
            body: [
                { status: 'PENDING' },
                { status: 'PENDING' },
                { status: 'READY', id: 9 },
            ],
        });
        const call = stitch({
            baseUrl: server.url,
            path: '/job',
            kind: poller,
            retry: { attempts: 3, backoff: { curve: 'fixed', base: 1 } },
        });

        await expect(call()).resolves.toEqual({ status: 'READY', id: 9 });
        expect(server.callCount('/job')).toBe(3);
    });

    test('it shares the retry.attempts budget and stops at the cap', async () => {
        server.route('GET', '/stuck', {
            statuses: [200, 200, 200, 200],
            body: { status: 'PENDING' },
        });
        const call = stitch({
            baseUrl: server.url,
            path: '/stuck',
            kind: poller,
            retry: { attempts: 2, backoff: { curve: 'fixed', base: 1 } },
        });

        const err = await rejectionOf(call());
        expect(err.message).toContain('PENDING');
        // Exactly `attempts`, not one more: the arm does not get a budget of its own.
        expect(server.callCount('/stuck')).toBe(2);
    });

    test('with no retry config it is a single attempt and an ordinary failure', async () => {
        server.route('GET', '/once', { body: { status: 'PENDING' } });
        const err = await rejectionOf(
            stitch({ baseUrl: server.url, path: '/once', kind: poller })(),
        );
        expect(err.message).toContain('PENDING');
        expect(server.callCount('/once')).toBe(1);
    });

    test('the retry event is distinguishable from a status-driven one', async () => {
        server.route('GET', '/evt', {
            statuses: [200, 200],
            body: [{ status: 'PENDING' }, { status: 'READY' }],
        });
        const events: StitchEvent[] = [];
        const call = stitch({
            baseUrl: server.url,
            path: '/evt',
            kind: poller,
            retry: { attempts: 2, backoff: { curve: 'fixed', base: 1 } },
        });
        for await (const ev of call.stream()) events.push(ev);

        const retries = events.filter(
            (e) => e.type === 'progress' && e.phase === 'retry',
        );
        expect(retries).toHaveLength(1);
        // `interpret: …` rather than `status NNN` — a trace consumer can tell them apart (Q3).
        expect(retries[0]).toMatchObject({ detail: 'interpret: PENDING' });
    });

    // ADR 0022 Q4: a body-driven retry replays a write, so it must be held to the same idempotency
    // rule as the status-driven path. It is, by construction — the key is stamped once in
    // `buildRequest` and every attempt is a clone of that request — and this pins it.
    test('a body-driven retry replays the SAME idempotency key', async () => {
        server.route('POST', '/write', {
            statuses: [200, 200],
            body: [{ status: 'PENDING' }, { status: 'READY' }],
        });
        const call = stitch({
            baseUrl: server.url,
            path: '/write',
            method: 'POST',
            kind: poller,
            idempotency: true,
            retry: { attempts: 2, backoff: { curve: 'fixed', base: 1 } },
        });

        await expect(call()).resolves.toEqual({ status: 'READY' });
        const keys = server
            .calls('/write')
            .map((c) => c.headers['idempotency-key']);
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBeDefined();
        expect(keys[1]).toBe(keys[0]); // one key for the whole run, replay-safe
    });
});

// ADR 0022 Decision 3 — `verdict.flag`. Three-state, and ONLY ONE state is a verdict. The negative
// cases matter most: a regression here silently breaks working calls, because every response whose
// body happens to lack the path would start failing. So they are pinned separately, not as a doc
// sentence.
describe('verdict.flag — three states, one verdict (Decision 3)', () => {
    test('present and truthy → success', async () => {
        server.route('GET', '/f-true', { body: { meta: { ok: true }, v: 1 } });
        await expect(
            stitch({
                baseUrl: server.url,
                path: '/f-true',
                verdict: { flag: 'meta.ok' },
            })(),
        ).resolves.toEqual({ meta: { ok: true }, v: 1 });
    });

    test.each([
        ['false', false],
        ['0', 0],
        ['empty string', ''],
    ])('present and falsy (%s) → FAILURE — the feature', async (_l, value) => {
        server.route('GET', `/f-falsy-${String(value)}`, {
            body: { meta: { ok: value } },
        });
        const err = await rejectionOf(
            stitch({
                baseUrl: server.url,
                path: `/f-falsy-${String(value)}`,
                verdict: { flag: 'meta.ok' },
            })(),
        );
        expect(err.message).toContain('meta.ok');
    });

    // The two silence cases. A server sends what it sends: the same endpoint returns the envelope on
    // Tuesday and a bare body on Wednesday. This library exists to survive that, so it must not be
    // the thing that breaks on it.
    test('ABSENT → no signal: the 200 still resolves', async () => {
        server.route('GET', '/f-absent', { body: { v: 1 } });
        await expect(
            stitch({
                baseUrl: server.url,
                path: '/f-absent',
                verdict: { flag: 'meta.ok' },
            })(),
        ).resolves.toEqual({ v: 1 });
    });

    test('null → no signal: "not applicable" is not a declaration of failure', async () => {
        server.route('GET', '/f-null', { body: { meta: { ok: null }, v: 1 } });
        await expect(
            stitch({
                baseUrl: server.url,
                path: '/f-null',
                verdict: { flag: 'meta.ok' },
            })(),
        ).resolves.toEqual({ meta: { ok: null }, v: 1 });
    });

    // `flag` only ever turns a success into a failure; `accept` only a failure into a success.
    // Neither invents a verdict from absence — the symmetry that makes the envelope teachable.
    test('it cannot rescue a failing status — only accept does that', async () => {
        server.route('GET', '/f-500', {
            statuses: [500],
            body: { meta: { ok: true } },
        });
        const err = await rejectionOf(
            stitch({
                baseUrl: server.url,
                path: '/f-500',
                verdict: { flag: 'meta.ok' },
            })(),
        );
        expect(err.status).toBe(500);
    });

    test('both members compose: accept rescues the status, flag still rules the body', async () => {
        server.route('GET', '/f-both', {
            statuses: [404],
            body: { meta: { ok: false } },
        });
        const err = await rejectionOf(
            stitch({
                baseUrl: server.url,
                path: '/f-both',
                verdict: { accept: [404], flag: 'meta.ok' },
            })(),
        );
        // Accepted as a status, then rejected by the flag — not an `HTTP 404`.
        expect(err.message).toContain('meta.ok');
    });
});

// The diagnostic half of the trade: an inert `flag` must not fail the call, but it must not be
// invisible either. Findings are diagnostic, never control flow (ADR 0015/0016).
describe('an inert verdict.flag is reported as an info finding', () => {
    const driftOf = (events: StitchEvent[]) =>
        events.filter((e) => e.type === 'drift');

    test('an ABSENT path yields one info finding and the call still resolves', async () => {
        server.route('GET', '/d-absent', { body: { v: 1 } });
        const call = stitch({
            baseUrl: server.url,
            path: '/d-absent',
            verdict: { flag: 'meta.succes' }, // the realistic typo
        });

        const events: StitchEvent[] = [];
        for await (const ev of call.stream()) events.push(ev);

        expect(events.find((e) => e.type === 'done')).toMatchObject({
            ok: true,
        });
        const drifts = driftOf(events);
        expect(drifts).toHaveLength(1);
        expect(drifts[0]).toMatchObject({
            finding: { level: 'info', path: 'meta.succes' },
        });
    });

    test('a null value reports too — "not applicable" is still no signal', async () => {
        server.route('GET', '/d-null', { body: { meta: { ok: null } } });
        const events: StitchEvent[] = [];
        for await (const ev of stitch({
            baseUrl: server.url,
            path: '/d-null',
            verdict: { flag: 'meta.ok' },
        }).stream())
            events.push(ev);

        expect(driftOf(events)[0]).toMatchObject({
            finding: { level: 'info', change: 'undeclared' },
        });
    });

    test('a flag that IS present reports nothing', async () => {
        server.route('GET', '/d-present', { body: { meta: { ok: true } } });
        const events: StitchEvent[] = [];
        for await (const ev of stitch({
            baseUrl: server.url,
            path: '/d-present',
            verdict: { flag: 'meta.ok' },
        }).stream())
            events.push(ev);

        expect(driftOf(events)).toEqual([]);
    });

    test('no flag configured reports nothing', async () => {
        server.route('GET', '/d-none', { body: { v: 1 } });
        const events: StitchEvent[] = [];
        for await (const ev of stitch({
            baseUrl: server.url,
            path: '/d-none',
        }).stream())
            events.push(ev);

        expect(driftOf(events)).toEqual([]);
    });
});

// A `200` whose BODY flag says failure is an application-level rejection of a healthy transport —
// the same category as graphql's 200-with-`errors`, and it must be routed the same way. It is a
// separate test because the two reach the verdict by different members (`verdict.flag` vs the
// surface's own rules), and the engine asks `classifyStatus` — not the body-aware `httpFailure` —
// precisely so they cannot diverge.
describe('a flag-failed 200 is an application rejection, not a transport failure', () => {
    test('it does NOT open the circuit', async () => {
        server.route('GET', '/flag-circuit', {
            statuses: [200, 200, 200],
            body: { meta: { ok: false } },
        });
        const call = stitch({
            baseUrl: server.url,
            path: '/flag-circuit',
            verdict: { flag: 'meta.ok' },
            circuit: { failures: 2, cooldown: '1m' },
        });

        for (let i = 0; i < 3; i++) {
            const err = await rejectionOf(call());
            expect(err.message).toContain('meta.ok');
        }
        // All three reached the network: the breaker never fast-failed one.
        expect(server.callCount('/flag-circuit')).toBe(3);
    });

    test('a failing STATUS with the same flag config still opens it', async () => {
        server.route('GET', '/flag-circuit-500', {
            statuses: [500, 500, 500],
            body: { meta: { ok: false } },
        });
        const call = stitch({
            baseUrl: server.url,
            path: '/flag-circuit-500',
            verdict: { flag: 'meta.ok' },
            circuit: { failures: 2, cooldown: '1m' },
        });

        await rejectionOf(call());
        await rejectionOf(call());
        await rejectionOf(call());

        expect(server.callCount('/flag-circuit-500')).toBe(2);
    });
});
