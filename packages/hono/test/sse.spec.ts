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
    test('an error event writes an event: error frame, invokes onError, and stops forwarding', async () => {
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
                        message: 'upstream failed',
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
        expect(body).toContain('upstream failed');
        expect(body).not.toContain('never');
        expect(captured).toBeInstanceOf(Error);
        expect((captured as Error).message).toBe('upstream failed');
    });

    test('a throw mid-stream is caught: onError fires and a final event: error frame is written', async () => {
        let captured: unknown;
        async function* boom(): AsyncGenerator<StitchEvent, void> {
            yield { type: 'delta', chunk: 'a', at: 0 };
            throw new Error('stream blew up');
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
        expect(body).toContain('stream blew up');
        expect((captured as Error).message).toBe('stream blew up');
    });
});
