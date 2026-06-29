// Pins issue #145: an opt-in delegate-backoff mode that SURFACES a rate-limit outcome (status in
// `rateLimit.on`, default [429]) as a RateLimitError instead of retrying it internally, and bypasses
// the built-in throttle so an OUTER gate (owned by the host) — not StitchAPI — paces the backoff.
import { RateLimitError, type StitchEvent, stitch } from '../../src';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-gap-delegate-backoff-${process.pid}.jsonl`,
);

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

// Await a call expected to reject; return the thrown error (narrowed to the shape these tests read).
async function rejectionOf(
    call: PromiseLike<unknown>,
): Promise<RateLimitError> {
    return Promise.resolve(call).then(
        () => {
            throw new Error('expected the call to reject, but it resolved');
        },
        (e: unknown) => e as RateLimitError,
    );
}

// ── A. a 429 throws RateLimitError on the awaited path, with NO internal retry ──
// `throttle: { delegate: true }` turns a 429 into a thrown RateLimitError carrying the parsed
// `retryAfterMs`, and — crucially — does NOT retry: even with retry.attempts > 1 (and 429 in
// retry.on) the adapter must be hit exactly once, because delegate mode short-circuits the loop.
test('a 429 with Retry-After: 2 throws RateLimitError(retryAfterMs=2000) and is hit exactly once', async () => {
    server.route('GET', '/rl', {
        statuses: [429],
        retryAfter: 2, // delta-seconds → Retry-After: 2
        body: { error: 'slow down' },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/rl',
        // retry would normally fire on 429 three times; delegate mode must override it.
        retry: { attempts: 3, on: [429] },
        throttle: { delegate: true },
    });

    const err = await rejectionOf(call());

    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.name).toBe('RateLimitError');
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(2000);
    // The raw response rides along so the host can read other rate headers.
    expect(err.response.status).toBe(429);
    expect(err.response.body).toEqual({ error: 'slow down' });
    // No internal retry: the route saw exactly one request.
    expect(server.callCount('/rl')).toBe(1);
});

// ── B. the same outcome surfaces as an `error` event with retryAfterMs on .stream() ──
test('.stream() surfaces an error event with status 429 and retryAfterMs 2000', async () => {
    server.route('GET', '/rl-stream', {
        statuses: [429],
        retryAfter: 2,
        body: { error: 'slow down' },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/rl-stream',
        throttle: { delegate: true },
    });

    const events: StitchEvent[] = [];
    for await (const ev of call.stream()) events.push(ev);

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(error).toMatchObject({
        type: 'error',
        status: 429,
        retryAfterMs: 2000,
    });
    // The run terminates as a failure — never a `result`.
    expect(events.some((e) => e.type === 'result')).toBe(false);
    expect(events.find((e) => e.type === 'done')).toMatchObject({ ok: false });
});

// ── C. delegate mode bypasses the internal throttle (no pacing, no `throttled` event) ──
// `throttle.rate: '1/s'` would normally force ~1000ms of spacing between the 1st and 2nd call to a
// key. In delegate mode the throttle is inert: the second call neither waits ~1s nor emits a
// `throttled` event — the host owns the gate. (Both calls 429, so both surface a RateLimitError.)
test('the configured throttle does not pace the call and emits no throttled event', async () => {
    server.route('GET', '/rl-throttle', {
        statuses: [429, 429],
        retryAfter: 1,
        body: { error: 'slow down' },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/rl-throttle',
        // delegate bypasses self-pacing within one envelope (P14): the '1/s' rate would impose
        // ~1000ms spacing if active, but delegate makes it inert.
        throttle: { rate: '1/s', delegate: true },
    });

    // First call arms the limiter's next-grant clock (if it were active).
    await rejectionOf(call());

    // Second call must NOT wait for the ~1s rate slot — delegate mode bypasses the throttle.
    const t0 = Date.now();
    const events: StitchEvent[] = [];
    for await (const ev of call.stream()) events.push(ev);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(500); // ≪ the 1000ms rate spacing a live throttle would add
    expect(
        events.some((e) => e.type === 'progress' && e.phase === 'throttled'),
    ).toBe(false);
    expect(events.find((e) => e.type === 'error')).toMatchObject({
        status: 429,
    });
});

// ── D. Retry-After as an HTTP-date parses to a positive retryAfterMs ──
test('Retry-After as an HTTP-date parses to a positive retryAfterMs', async () => {
    const when = new Date(Date.now() + 5000).toUTCString(); // ~5s in the future, RFC 1123
    server.route('GET', '/rl-date', {
        statuses: [429],
        headers: { 'Retry-After': when },
        body: { error: 'slow down' },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/rl-date',
        throttle: { delegate: true },
    });

    const err = await rejectionOf(call());

    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBeGreaterThan(0);
    // ~5s out; allow generous slack for clock/transit but stay well under/over the bounds.
    expect(err.retryAfterMs).toBeLessThanOrEqual(5000);
    expect(err.retryAfterMs).toBeGreaterThan(3000);
});

// ── E. a missing Retry-After yields RateLimitError with retryAfterMs undefined ──
test('a 429 without Retry-After throws RateLimitError with retryAfterMs undefined', async () => {
    server.route('GET', '/rl-bare', {
        statuses: [429],
        body: { error: 'slow down' },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/rl-bare',
        throttle: { delegate: true },
    });

    const err = await rejectionOf(call());

    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBeUndefined();
});

// ── F. a custom `on` list lets a 503 delegate while a 429 retries normally ──
// `on: [503]` means ONLY 503 is delegated; a 429 is no longer a rate-limit signal and falls through
// to the ordinary retry path (here retry.on includes 429), proving `on` is honoured both ways.
test('throttle.on selects which statuses delegate (503 delegates, 429 retries)', async () => {
    server.route('GET', '/rl-503', {
        statuses: [503],
        retryAfter: 1,
        body: { error: 'unavailable' },
    });
    const delegated = stitch({
        baseUrl: server.url,
        path: '/rl-503',
        throttle: { delegate: true, on: [503] },
    });

    const err = await rejectionOf(delegated());
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.status).toBe(503);
    expect(err.retryAfterMs).toBe(1000);
    expect(server.callCount('/rl-503')).toBe(1);

    // A 429 under the same `on: [503]` is NOT delegated — it flows through ordinary retry: two 429s
    // then a 200, with retry.attempts: 3, must succeed (proving 429 was retried, not surfaced).
    server.route('GET', '/retry-429', {
        statuses: [429, 429, 200],
        body: [{}, {}, { ok: true }],
    });
    const retried = stitch<{ ok: boolean }>({
        baseUrl: server.url,
        path: '/retry-429',
        retry: { attempts: 3, on: [429], backoff: 'fixed', baseMs: 1 },
        throttle: { delegate: true, on: [503] },
    });
    await expect(retried()).resolves.toEqual({ ok: true });
    expect(server.callCount('/retry-429')).toBe(3);
});

// ── G. the success path still runs transform → unwrap → drift under delegate mode ──
// Delegate mode only intercepts rate-limit statuses; a 200 must validate/transform/unwrap exactly as
// it would without the flag — proving the mode is "validate + template + transform + drift, but
// delegate backoff", not a bare pass-through.
test('a success response still runs transform, unwrap, and output validation', async () => {
    server.route('GET', '/ok', {
        statuses: [200],
        body: { data: { id: 7, name: 'widget' } },
    });
    const call = stitch<{ id: number; label: string }>({
        baseUrl: server.url,
        path: '/ok',
        throttle: { delegate: true },
        unwrap: 'data',
        transform: (body) => {
            // raw body → reshape: rename `name` to `label`. Runs before unwrap.
            const b = body as { data: { id: number; name: string } };
            return { data: { id: b.data.id, label: b.data.name } };
        },
        output: (v: unknown): v is { id: number; label: string } => {
            const o = v as { id?: unknown; label?: unknown };
            return typeof o.id === 'number' && typeof o.label === 'string';
        },
    });

    await expect(call()).resolves.toEqual({ id: 7, label: 'widget' });
});

// ── H. .safe() returns a StitchError carrying the rate-limit status (never throws) ──
// `.safe()`'s contract is a StitchError in `error`; a delegate RateLimitError is coerced to one with
// its `status` and the original kept as `.cause`.
test('.safe() surfaces the rate-limit status as a non-throwing StitchError', async () => {
    server.route('GET', '/rl-safe', {
        statuses: [429],
        retryAfter: 2,
        body: { error: 'slow down' },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/rl-safe',
        throttle: { delegate: true },
    });

    const out = await call.safe();
    expect(out.ok).toBe(false);
    expect(out.error?.status).toBe(429);
    // The real RateLimitError is preserved as the cause.
    expect(out.error?.cause).toBeInstanceOf(RateLimitError);
    expect((out.error?.cause as RateLimitError).retryAfterMs).toBe(2000);
});

// ── I. back-compat + predicate widening (CONTRACT.md P14 / P7) ──
test('the @deprecated top-level `rateLimit` still delegates identically (P14)', async () => {
    server.route('GET', '/rl-legacy', {
        statuses: [429],
        retryAfter: 2,
        body: { error: 'slow down' },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/rl-legacy',
        // Pre-fold spelling — must behave exactly like `throttle: { delegate: true }` until GA.
        rateLimit: { delegate: true },
    });
    const err = await rejectionOf(call());
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.status).toBe(429);
});

test('throttle.on accepts a predicate (P7): a 503 matched by the predicate delegates', async () => {
    server.route('GET', '/rl-pred', {
        statuses: [503],
        retryAfter: 1,
        body: { error: 'busy' },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/rl-pred',
        throttle: { delegate: true, on: (s) => s === 503 },
    });
    const err = await rejectionOf(call());
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.status).toBe(503);
});

test('retry.on accepts a predicate (P7): retries while the predicate matches', async () => {
    server.route('GET', '/retry-pred', {
        statuses: [503, 200],
        body: { ok: true },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/retry-pred',
        retry: { attempts: 2, on: (s) => s === 503, baseMs: 1 },
    });
    await expect(call()).resolves.toEqual({ ok: true });
    expect(server.calls('/retry-pred').length).toBe(2); // 503 retried, then 200
});
