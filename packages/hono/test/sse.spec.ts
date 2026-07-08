// Focused tests for @stitchapi/hono's `streamStitchSse`. The behavioural
// `hono.spec.ts` only exercises the basic delta→`data:` path (always with a
// custom `data` mapper) and the error-event frame. This drives the helper
// directly with hand-rolled `StitchEvent` generators (its `StitchEventSource`
// accepts any event iterable — no seam, no adapter) to cover the untested
// surface: the DEFAULT data mapper, the `event:` label, the `onError` callback,
// control events not being forwarded, and the throw-mid-stream catch path.
import { streamStitchSse } from '../src';

import { Hono } from 'hono';
import type { StitchEvent } from 'stitchapi';
import { describe, expect, test } from 'vitest';

/** An async event source over a fixed list, yielding on a microtask per event. */
async function* gen(events: StitchEvent[]): AsyncGenerator<StitchEvent, void> {
    for (const e of events) {
        await Promise.resolve();
        yield e;
    }
}

/** The `data:` lines of an SSE body, in order. */
function dataLines(body: string): string[] {
    return body
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.trimEnd());
}

describe('streamStitchSse — delta mapping', () => {
    test('the default data mapper sends a string verbatim and JSON-stringifies an object', async () => {
        const app = new Hono();
        app.get('/x', (c) =>
            streamStitchSse(
                c,
                gen([
                    { type: 'delta', chunk: 'hello', at: 0 },
                    { type: 'delta', chunk: { a: 1 }, at: 0 },
                    { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
                ]),
            ),
        );

        const res = await app.request('/x');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const body = await res.text();
        expect(body).toContain('data: hello');
        expect(body).toContain('data: {"a":1}');
    });

    test('the event option labels each delta message', async () => {
        const app = new Hono();
        app.get('/x', (c) =>
            streamStitchSse(
                c,
                gen([
                    { type: 'delta', chunk: 't1', at: 0 },
                    { type: 'delta', chunk: 't2', at: 0 },
                    { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
                ]),
                { event: 'token' },
            ),
        );

        const body = await (await app.request('/x')).text();
        expect(body).toContain('event: token');
        expect(body).toContain('data: t1');
        expect(body).toContain('data: t2');
    });

    test('the data mapper receives the zero-based message index', async () => {
        const app = new Hono();
        app.get('/x', (c) =>
            streamStitchSse(
                c,
                gen([
                    { type: 'delta', chunk: 'a', at: 0 },
                    { type: 'delta', chunk: 'b', at: 0 },
                    { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
                ]),
                { data: (chunk, index) => `${String(chunk)}#${index}` },
            ),
        );

        const body = await (await app.request('/x')).text();
        expect(body).toContain('data: a#0');
        expect(body).toContain('data: b#1');
    });

    test('event accepts a function of the chunk for per-message event names', async () => {
        const app = new Hono();
        app.get('/x', (c) =>
            streamStitchSse(
                c,
                gen([
                    {
                        type: 'delta',
                        chunk: { kind: 'token', text: 'a' },
                        at: 0,
                    },
                    {
                        type: 'delta',
                        chunk: { kind: 'usage', text: 'b' },
                        at: 0,
                    },
                    { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
                ]),
                {
                    event: (chunk) => (chunk as { kind: string }).kind,
                    data: (chunk) => (chunk as { text: string }).text,
                },
            ),
        );

        const body = await (await app.request('/x')).text();
        expect(body).toContain('event: token\ndata: a');
        expect(body).toContain('event: usage\ndata: b');
    });

    test('the id option stamps each delta message with a last-event id (chunk + index)', async () => {
        const app = new Hono();
        app.get('/x', (c) =>
            streamStitchSse(
                c,
                gen([
                    { type: 'delta', chunk: 'a', at: 0 },
                    { type: 'delta', chunk: 'b', at: 0 },
                    { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
                ]),
                { id: (_chunk, index) => `msg-${index}` },
            ),
        );

        const body = await (await app.request('/x')).text();
        expect(body).toContain('id: msg-0');
        expect(body).toContain('id: msg-1');
    });

    test('a { stream() } holder (StitchResult-shaped source) is unwrapped and driven', async () => {
        const app = new Hono();
        const holder = {
            stream: () =>
                gen([
                    { type: 'delta', chunk: 'held', at: 0 },
                    { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
                ]),
        };
        app.get('/x', (c) => streamStitchSse(c, holder));

        const body = await (await app.request('/x')).text();
        expect(dataLines(body)).toEqual(['data: held']);
    });

    test('a custom data mapper pulls text out of a structured chunk', async () => {
        const app = new Hono();
        app.get('/x', (c) =>
            streamStitchSse(
                c,
                gen([
                    { type: 'delta', chunk: { text: 'pulled' }, at: 0 },
                    { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
                ]),
                { data: (chunk) => (chunk as { text: string }).text },
            ),
        );

        const body = await (await app.request('/x')).text();
        expect(body).toContain('data: pulled');
    });
});

describe('streamStitchSse — control events', () => {
    test('start/progress/result/done are consumed but not forwarded — only deltas reach the client', async () => {
        const app = new Hono();
        app.get('/x', (c) =>
            streamStitchSse(
                c,
                gen([
                    {
                        type: 'start',
                        name: 'x',
                        method: 'GET',
                        url: 'https://api.test/x',
                        input: {},
                        at: 0,
                    },
                    { type: 'progress', phase: 'request', attempt: 1, at: 0 },
                    { type: 'delta', chunk: 'only-this', at: 0 },
                    {
                        type: 'result',
                        data: { leak: 'SHOULD-NOT-APPEAR' },
                        status: 200,
                        attempts: 1,
                        at: 0,
                    },
                    { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
                ]),
            ),
        );

        const body = await (await app.request('/x')).text();
        expect(dataLines(body)).toEqual(['data: only-this']);
        // The result value is a control payload — it must never reach the wire.
        expect(body).not.toContain('SHOULD-NOT-APPEAR');
    });
});

describe('streamStitchSse — error paths', () => {
    test('by default an error event writes a generic event: error frame (raw message withheld), while onError still gets the real failure', async () => {
        let captured: unknown;
        const app = new Hono();
        app.get('/x', (c) =>
            streamStitchSse(
                c,
                gen([
                    { type: 'delta', chunk: 'a', at: 0 },
                    {
                        type: 'error',
                        name: 'StitchError',
                        // Discloses an internal hostname — must NOT reach the client (topology
                        // disclosure; same class PR #408 fixed on the error-handler surface).
                        message: 'getaddrinfo ENOTFOUND payments.internal.corp',
                        status: 502,
                        attempts: 1,
                        at: 0,
                    },
                    // Anything after the error must not be forwarded.
                    { type: 'delta', chunk: 'never', at: 0 },
                ]),
                {
                    onError: (e) => {
                        captured = e;
                    },
                },
            ),
        );

        const body = await (await app.request('/x')).text();
        expect(body).toContain('data: a');
        expect(body).toContain('event: error');
        expect(body).toContain('data: error');
        // The raw message is withheld from the client by default …
        expect(body).not.toContain('payments.internal.corp');
        expect(body).not.toContain('ENOTFOUND');
        expect(body).not.toContain('never');
        // … but onError still observes the real failure server-side (for logging).
        expect(captured).toBeInstanceOf(Error);
        expect((captured as Error).message).toBe(
            'getaddrinfo ENOTFOUND payments.internal.corp',
        );
    });

    test('errorData opts in to the raw message on the error frame', async () => {
        const app = new Hono();
        app.get('/x', (c) =>
            streamStitchSse(
                c,
                gen([
                    { type: 'delta', chunk: 'a', at: 0 },
                    {
                        type: 'error',
                        name: 'StitchError',
                        message: 'upstream failed',
                        attempts: 1,
                        at: 0,
                    },
                ]),
                { errorData: (e) => e.message },
            ),
        );

        const body = await (await app.request('/x')).text();
        expect(body).toContain('event: error');
        expect(body).toContain('data: upstream failed');
    });

    test('a throw mid-stream is caught: onError fires and a final generic event: error frame is written (raw message withheld)', async () => {
        let captured: unknown;
        async function* boom(): AsyncGenerator<StitchEvent, void> {
            yield { type: 'delta', chunk: 'a', at: 0 };
            throw new Error('getaddrinfo ENOTFOUND payments.internal.corp');
        }

        const app = new Hono();
        app.get('/x', (c) =>
            streamStitchSse(c, boom(), {
                onError: (e) => {
                    captured = e;
                },
            }),
        );

        const body = await (await app.request('/x')).text();
        expect(body).toContain('data: a');
        expect(body).toContain('event: error');
        expect(body).toContain('data: error');
        expect(body).not.toContain('payments.internal.corp');
        expect(body).not.toContain('ENOTFOUND');
        // onError still sees the real thrown error server-side.
        expect((captured as Error).message).toBe(
            'getaddrinfo ENOTFOUND payments.internal.corp',
        );
    });

    test('errorData opts in on the throw path too (thrown error normalised to an error event)', async () => {
        async function* boom(): AsyncGenerator<StitchEvent, void> {
            yield { type: 'delta', chunk: 'a', at: 0 };
            throw new Error('stream blew up');
        }

        const app = new Hono();
        app.get('/x', (c) =>
            streamStitchSse(c, boom(), { errorData: (e) => e.message }),
        );

        const body = await (await app.request('/x')).text();
        expect(body).toContain('event: error');
        expect(body).toContain('data: stream blew up');
    });
});
