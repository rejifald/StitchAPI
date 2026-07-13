// Focused tests for @stitchapi/elysia's `streamStitchSse`. The integration
// `elysia.spec.ts` only exercises the basic delta→`data:` path and the
// error-event frame. This drives the helper directly with hand-rolled
// `StitchEvent` generators — it takes just the source and returns a Web-standard
// `Response`, so no Elysia app is needed — to cover the untested surface: the
// DEFAULT data mapper, the `event:` label, the `onError` callback, control
// events not being forwarded, the throw-mid-stream catch path, the SSE-spec
// multi-line `data:` framing, and the response headers.
import { streamStitchSse } from '../src';

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
        const res = streamStitchSse(
            gen([
                { type: 'delta', chunk: 'hello', at: 0 },
                { type: 'delta', chunk: { a: 1 }, at: 0 },
                { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
            ]),
        );

        const body = await res.text();
        expect(body).toContain('data: hello');
        expect(body).toContain('data: {"a":1}');
    });

    test('the event option labels each delta message', async () => {
        const res = streamStitchSse(
            gen([
                { type: 'delta', chunk: 't1', at: 0 },
                { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
            ]),
            { event: 'token' },
        );

        const body = await res.text();
        expect(body).toContain('event: token');
        expect(body).toContain('data: t1');
    });

    test('a custom data mapper pulls text out of a structured chunk', async () => {
        const res = streamStitchSse(
            gen([
                { type: 'delta', chunk: { text: 'pulled' }, at: 0 },
                { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
            ]),
            { data: (chunk) => (chunk as { text: string }).text },
        );

        const body = await res.text();
        expect(body).toContain('data: pulled');
    });

    test('a multi-line chunk gets one data: prefix per line (SSE spec)', async () => {
        const res = streamStitchSse(
            gen([
                { type: 'delta', chunk: 'line1\nline2', at: 0 },
                { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
            ]),
        );

        const body = await res.text();
        expect(body).toContain('data: line1\ndata: line2');
    });
});

describe('streamStitchSse — control events', () => {
    test('start/progress/result/done are consumed but not forwarded — only deltas reach the client', async () => {
        const res = streamStitchSse(
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
        );

        const body = await res.text();
        expect(dataLines(body)).toEqual(['data: only-this']);
        expect(body).not.toContain('SHOULD-NOT-APPEAR');
    });
});

describe('streamStitchSse — error paths', () => {
    test('an error event writes an event: error frame, invokes onError, and stops forwarding', async () => {
        let captured: unknown;
        const res = streamStitchSse(
            gen([
                { type: 'delta', chunk: 'a', at: 0 },
                {
                    type: 'error',
                    name: 'StitchError',
                    message: 'upstream failed',
                    attempts: 1,
                    at: 0,
                },
                { type: 'delta', chunk: 'never', at: 0 },
            ]),
            {
                onError: (e) => {
                    captured = e;
                },
            },
        );

        const body = await res.text();
        expect(body).toContain('data: a');
        expect(body).toContain('event: error');
        // the raw upstream message is withheld from the client by default (leak-regression below)
        expect(body).not.toContain('upstream failed');
        expect(body).toContain('data: error');
        expect(body).not.toContain('never');
        // onError still sees the real failure server-side
        expect((captured as Error).message).toBe('upstream failed');
    });

    test('a throw mid-stream is caught: onError fires and a final event: error frame is written', async () => {
        let captured: unknown;
        async function* boom(): AsyncGenerator<StitchEvent, void> {
            yield { type: 'delta', chunk: 'a', at: 0 };
            throw new Error('stream blew up');
        }

        const res = streamStitchSse(boom(), {
            onError: (e) => {
                captured = e;
            },
        });

        const body = await res.text();
        expect(body).toContain('data: a');
        expect(body).toContain('event: error');
        // the raw throw message is withheld from the client by default
        expect(body).not.toContain('stream blew up');
        expect(body).toContain('data: error');
        // onError still sees the real failure server-side
        expect((captured as Error).message).toBe('stream blew up');
    });
});

describe('streamStitchSse — the error frame does not leak the raw message', () => {
    // Regression: the default error frame must not echo the raw upstream/transport message, which
    // can disclose internal network topology (a transport error names the host it failed to reach)
    // or the upstream's status to an untrusted client — bringing @stitchapi/elysia in line with the
    // other hosts (express/fastify/hono/nest/next), whose SSE helpers already withhold it.
    test('an internal hostname in the error message is not disclosed by default', async () => {
        const res = streamStitchSse(
            gen([
                {
                    type: 'error',
                    name: 'StitchError',
                    message: 'getaddrinfo ENOTFOUND payments.internal.corp',
                    status: 502,
                    attempts: 1,
                    at: 0,
                },
            ]),
        );
        const body = await res.text();
        expect(body).toContain('event: error');
        expect(body).toContain('data: error');
        expect(body).not.toContain('payments.internal.corp');
        expect(body).not.toContain('ENOTFOUND');
    });

    test('errorData opts in to shaping the client-facing error payload', async () => {
        const res = streamStitchSse(
            gen([
                {
                    type: 'error',
                    name: 'StitchError',
                    message: 'upstream blew up',
                    attempts: 1,
                    at: 0,
                },
            ]),
            { errorData: (e) => e.message },
        );
        const body = await res.text();
        expect(body).toContain('event: error');
        expect(body).toContain('data: upstream blew up');
    });

    test('errorData shapes the throw path too', async () => {
        async function* boom(): AsyncGenerator<StitchEvent, void> {
            yield { type: 'delta', chunk: 'a', at: 0 };
            throw new Error('stream blew up');
        }
        const res = streamStitchSse(boom(), {
            errorData: (e) => JSON.stringify({ error: e.message }),
        });
        const body = await res.text();
        expect(body).toContain('event: error');
        expect(body).toContain('data: {"error":"stream blew up"}');
    });
});

describe('streamStitchSse — response', () => {
    test('returns a text/event-stream Response', async () => {
        const res = streamStitchSse(
            gen([{ type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 }]),
        );
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        expect(res.headers.get('cache-control')).toContain('no-cache');
        // Drain so the stream is not left dangling.
        await res.text();
    });
});
