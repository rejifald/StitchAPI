// ADR 0010 — the injectable Clock. A `manualClock()` injected as `clock` makes retry backoff,
// throttle pacing, the per-attempt timeout and OAuth2 token expiry deterministic with zero real
// waiting: `advance(ms)` drives them. Verified against the REAL engine via the published mock
// adapter.
import { seam, stitch } from '../src';
import { oauth2 } from '../src/auth';
import { manualClock, mockAdapter } from '../src/testing';
import type { Adapter, Clock } from '../src/types';

describe('manualClock drives retry backoff (ADR 0010)', () => {
    test('each backoff elapses only when the clock is advanced', async () => {
        const clock = manualClock();
        const api = mockAdapter({
            match: '/flaky',
            respond: [{ status: 503 }, { status: 503 }, { body: { ok: true } }],
        });
        const call = stitch({
            baseUrl: 'https://api.test',
            path: '/flaky',
            adapter: api,
            retry: {
                attempts: 3,
                on: [503],
                backoff: { curve: 'fixed', base: 10_000 },
            },
            clock,
        });

        const p = call.safe();

        await clock.advance(0); // run the first attempt
        expect(api.callCount()).toBe(1);

        await clock.advance(10_000); // fire the backoff → 2nd attempt
        expect(api.callCount()).toBe(2);

        await clock.advance(10_000); // fire the backoff → 3rd attempt (200)
        const res = await p;

        expect(res.ok).toBe(true);
        expect(res.data).toEqual({ ok: true });
        expect(api.callCount()).toBe(3);
        expect(clock.pending()).toBe(0);
    });

    test('without advancing, a pending backoff never resolves', async () => {
        const clock = manualClock();
        const api = mockAdapter({
            match: '/flaky',
            respond: [{ status: 503 }, { body: { ok: true } }],
        });
        const call = stitch({
            baseUrl: 'https://api.test',
            path: '/flaky',
            adapter: api,
            retry: {
                attempts: 2,
                on: [503],
                backoff: { curve: 'fixed', base: 10_000 },
            },
            clock,
        });

        const p = call.safe();
        await clock.advance(0); // first attempt only — backoff is armed but not elapsed

        expect(api.callCount()).toBe(1);
        expect(clock.pending()).toBe(1); // the backoff sleep is waiting

        await clock.advance(10_000);
        await p;
        expect(api.callCount()).toBe(2);
    });
});

describe('manualClock drives throttle rate spacing (ADR 0010)', () => {
    test('a second call is paced by the rate budget, released on advance', async () => {
        const clock = manualClock();
        const api = mockAdapter({ respond: { body: { ok: true } } });
        const call = stitch({
            url: 'https://api.test/x',
            adapter: api,
            throttle: { rate: '2/s' }, // 500ms between grants
            clock,
        });

        const a = call.safe();
        const b = call.safe();

        await clock.advance(0); // first grant is immediate; second is paced
        expect(api.callCount()).toBe(1);

        await clock.advance(500); // release the second grant
        await Promise.all([a, b]);
        expect(api.callCount()).toBe(2);
    });

    // A seam builds its SHARED bucket from the raw authoring fragment, before `compose` normalizes
    // any member — so the rate-string shorthand has to be expanded on that path too. Miss it and
    // the bucket is built with an undefined rate: both members would fire at `advance(0)`.
    test('a seam-level `throttle: "2/s"` shorthand paces two DIFFERENT members on one bucket', async () => {
        const clock = manualClock();
        const api = mockAdapter({ respond: { body: { ok: true } } });
        const shared = seam({
            baseUrl: 'https://api.test',
            adapter: api,
            throttle: '2/s', // ≡ { rate: '2/s' } — 500ms between grants
            clock,
        });
        const x = shared.stitch('/x');
        const y = shared.stitch('/y');

        const a = x.safe();
        const b = y.safe();

        await clock.advance(0); // the seam pools one bucket, so the second member is paced
        expect(api.callCount()).toBe(1);

        await clock.advance(500);
        await Promise.all([a, b]);
        expect(api.callCount()).toBe(2);
    });
});

// The token cache's freshness math (`expiresAt` and the `refresh.skew` window) is control-flow
// time — it decides whether the next call fetches — so ADR 0010's seam has to reach it. Before
// this, `oauth2` read the module-global wall clock: 600,000 virtual ms past a 60s `expires_in`
// refetched nothing, so "does my client refresh the token before it expires" could not be tested.
describe('manualClock drives OAuth2 token expiry (ADR 0010)', () => {
    // One mock serves both the token endpoint and the protected resource, so a single spy reports
    // how many token fetches happened.
    const api = () =>
        mockAdapter([
            {
                method: 'POST',
                match: '/token',
                respond: ({ index }) => ({
                    body: {
                        access_token: `T${index + 1}`,
                        token_type: 'Bearer',
                        expires_in: 60, // 60s, and the default refresh skew is 30s
                    },
                }),
            },
            { method: 'GET', match: '/data', respond: { body: { ok: true } } },
        ]);

    const protectedStitch = (mock: ReturnType<typeof api>, clock: Clock) =>
        stitch({
            baseUrl: 'https://api.test',
            path: '/data',
            adapter: mock,
            clock,
            auth: oauth2({
                tokenUrl: 'https://api.test/token',
                clientId: 'cid',
                clientSecret: 'csecret',
                adapter: mock,
            }),
        });

    test('advancing past `expires_in` refetches the token', async () => {
        const clock = manualClock();
        const mock = api();
        const call = protectedStitch(mock, clock);

        await call();
        expect(mock.callCount('/token')).toBe(1);
        expect(mock.lastRequest()?.headers['authorization']).toBe('Bearer T1');

        // Still inside the freshness window (60s expiry − 30s skew = fresh until virtual 30s).
        await clock.advance(20_000);
        await call();
        expect(mock.callCount('/token')).toBe(1); // reused, not refetched

        // Past it, on virtual time alone — no real waiting.
        await clock.advance(580_000); // virtual 600s, ten minutes past a 60s token
        await call();
        expect(mock.callCount('/token')).toBe(2);
        expect(mock.lastRequest()?.headers['authorization']).toBe('Bearer T2');
    });

    test('the `refresh.skew` window is honoured on virtual time', async () => {
        const clock = manualClock();
        const mock = api();
        const call = stitch({
            baseUrl: 'https://api.test',
            path: '/data',
            adapter: mock,
            clock,
            auth: oauth2({
                tokenUrl: 'https://api.test/token',
                clientId: 'cid',
                clientSecret: 'csecret',
                adapter: mock,
                refresh: { skew: '10s' }, // fresh until virtual 50s (60s expiry − 10s skew)
            }),
        });

        await call();
        expect(mock.callCount('/token')).toBe(1);

        await clock.advance(49_999);
        await call();
        expect(mock.callCount('/token')).toBe(1); // one ms inside the window

        await clock.advance(1);
        await call();
        expect(mock.callCount('/token')).toBe(2); // the skew boundary, on the injected clock
    });

    test('with no clock injected, expiry still rides the system clock', async () => {
        const mock = api();
        const call = stitch({
            baseUrl: 'https://api.test',
            path: '/data',
            adapter: mock,
            auth: oauth2({
                tokenUrl: 'https://api.test/token',
                clientId: 'cid',
                clientSecret: 'csecret',
                adapter: mock,
            }),
        });

        await call();
        await call();
        expect(mock.callCount('/token')).toBe(1); // a 60s token is fresh across two calls
    });
});

describe('manualClock drives the per-attempt timeout (ADR 0010)', () => {
    test('the timeout fires on advance, aborting the in-flight request', async () => {
        const clock = manualClock();
        // A transport that hangs until its signal aborts — so only the timeout can end it.
        const hangs: Adapter = (req) =>
            new Promise((_resolve, reject) => {
                req.signal?.addEventListener(
                    'abort',
                    () => {
                        reject(new Error('aborted'));
                    },
                    { once: true },
                );
            });
        const call = stitch({
            url: 'https://api.test/slow',
            adapter: hangs,
            timeout: { each: 1000 },
            clock,
        });

        const p = call.safe();
        await clock.advance(0); // reach the adapter; arm the timeout
        await clock.advance(1000); // fire it

        const res = await p;
        expect(res.ok).toBe(false);
        expect(res.error).toBeDefined();
    });
});
