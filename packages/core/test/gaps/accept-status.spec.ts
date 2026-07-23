// Pins issue #155 part A: `acceptStatus` — declare statuses (a number list or a predicate) that are
// a NORMAL result rather than an error. An accepted non-2xx returns its body and flows through the
// SAME success pipeline a 2xx does (interpret → transform → unwrap → validate) instead of throwing.
// `retry.on` still wins while attempts remain (retried, then accepted on the final attempt); the
// policy is honoured on the buffered, paginated, and streaming paths via the shared `attemptLoop`.
import { type StitchError, type StitchEvent, stitch } from '../../src';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-gap-accept-status-${process.pid}.jsonl`,
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

// Await a call expected to reject; return the thrown error narrowed to a StitchError.
async function rejectionOf(call: PromiseLike<unknown>): Promise<StitchError> {
    return Promise.resolve(call).then(
        () => {
            throw new Error('expected the call to reject, but it resolved');
        },
        (e: unknown) => e as StitchError,
    );
}

// ── A. an accepted 404 RESOLVES with the 404 body (no throw) ──
// `acceptStatus: [404]` turns a 404 into a normal result: the awaited path resolves to the response
// body — exactly the "resource-gone → fall back" control flow that today runs through a `catch`.
test('acceptStatus: [404] resolves with the 404 body instead of throwing', async () => {
    server.route('GET', '/missing', {
        statuses: [404],
        body: { error: 'not_found', code: 'gone' },
    });
    const call = stitch<{ error: string; code: string }>({
        baseUrl: server.url,
        path: '/missing',
        acceptStatus: [404],
    });

    await expect(call()).resolves.toEqual({ error: 'not_found', code: 'gone' });
});

// ── B. transform / unwrap / output validation still run on an accepted non-2xx ──
// An accepted 404 is NOT a bare pass-through: it flows through the whole success pipeline. Here a
// 404 body { data: {...} } is unwrapped, reshaped by transform, and validated by the output guard —
// proving the accepted response is treated identically to a 2xx.
test('an accepted non-2xx still runs transform, unwrap, and output validation', async () => {
    server.route('GET', '/accepted-pipeline', {
        statuses: [404],
        body: { data: { id: 7, name: 'widget' } },
    });
    const call = stitch<{ id: number; label: string }>({
        baseUrl: server.url,
        path: '/accepted-pipeline',
        acceptStatus: [404],
        pick: 'data',
        transform: (body) => {
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

// ── C. a predicate accepts a 400 but still throws on a 500 ──
// `acceptStatus: (s) => s < 500` — a 400 is accepted (resolves), a 500 is not (still a StitchError).
test('acceptStatus predicate accepts a 400 and still throws on a 500', async () => {
    server.route('GET', '/bad-request', {
        statuses: [400],
        body: { error: 'bad_input' },
    });
    server.route('GET', '/server-error', {
        statuses: [500],
        body: { error: 'boom' },
    });
    const accept4xx = (s: number): boolean => s < 500;

    const ok = stitch<{ error: string }>({
        baseUrl: server.url,
        path: '/bad-request',
        acceptStatus: accept4xx,
    });
    await expect(ok()).resolves.toEqual({ error: 'bad_input' });

    const bad = stitch({
        baseUrl: server.url,
        path: '/server-error',
        acceptStatus: accept4xx,
    });
    const err = await rejectionOf(bad());
    expect(err.name).toBe('StitchError');
    expect(err.status).toBe(500);
});

// ── D. retry.on wins while attempts remain, then accept on the final attempt ──
// A status in BOTH `retry.on` and `acceptStatus` is RETRIED until attempts are exhausted, then
// ACCEPTED (returned) on the final attempt. Here two 503s then a third 503: with retry.attempts: 3
// the first two are retried, the third (final attempt) is accepted and its body resolves — proving
// the accept check sits AFTER the retry-on-status path (3 requests, no throw).
test('a status in both retry.on and acceptStatus is retried, then accepted on the final attempt', async () => {
    server.route('GET', '/retry-then-accept', {
        statuses: [503, 503, 503],
        body: [{ try: 1 }, { try: 2 }, { ok: true, last: true }],
    });
    const call = stitch<{ ok: boolean; last: boolean }>({
        baseUrl: server.url,
        path: '/retry-then-accept',
        retry: { attempts: 3, on: [503], backoff: 'fixed', baseMs: 1 },
        acceptStatus: [503],
    });

    await expect(call()).resolves.toEqual({ ok: true, last: true });
    // Retried twice, accepted on the third — the route saw exactly three requests.
    expect(server.callCount('/retry-then-accept')).toBe(3);
});

// ── E. acceptStatus is honoured on the streaming path too ──
// Streaming shares the same per-stitch policy: an accepted non-2xx streams its live body as `delta`
// chunks and terminates as a success (a `result`, `done.ok: true`) rather than an `error` event.
test('acceptStatus lets a streaming surface accept a non-2xx and stream its body', async () => {
    server.route('GET', '/accept-stream', {
        statuses: [404],
        stream: { chunks: ['hello ', 'world'] },
        headers: { 'content-type': 'text/plain' },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/accept-stream',
        acceptStatus: [404],
        kind: {
            id: 'text-stream',
            // Minimal text-stream surface: decode each Uint8Array chunk to a string `delta`.
            stream: async function* (res) {
                const body = res.body as ReadableStream<Uint8Array>;
                const reader = body.getReader();
                const dec = new TextDecoder();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    yield dec.decode(value, { stream: true });
                }
            },
        },
    });

    const events: StitchEvent[] = [];
    for await (const ev of call.stream()) events.push(ev);

    // No error event: the accepted 404 streamed as a success.
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.find((e) => e.type === 'done')).toMatchObject({ ok: true });
    const deltas = events
        .filter((e) => e.type === 'delta')
        .map((e) => (e as { chunk: unknown }).chunk);
    expect(deltas.join('')).toBe('hello world');
});

// ── F. a non-accepted status under acceptStatus still throws ──
// Sanity: acceptStatus is additive — a status NOT in the list/predicate keeps the ordinary failure.
test('a status outside acceptStatus still throws a StitchError', async () => {
    server.route('GET', '/still-throws', {
        statuses: [403],
        body: { error: 'forbidden' },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/still-throws',
        acceptStatus: [404], // 403 is NOT accepted
    });

    const err = await rejectionOf(call());
    expect(err.name).toBe('StitchError');
    expect(err.status).toBe(403);
});
