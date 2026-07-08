// @stitchapi/next behaviour — Web-standard Response helpers driven with fake event
// sources and errors. No engine, no Next.
import { isStitchError, stitchErrorResponse, streamStitchSse } from '../src';

import type { StitchEvent } from 'stitchapi';
import { describe, expect, test, vi } from 'vitest';

async function* events(
    ...evs: StitchEvent[]
): AsyncGenerator<StitchEvent, void> {
    for (const e of evs) {
        await Promise.resolve();
        yield e;
    }
}

const delta = (chunk: unknown): StitchEvent => ({
    type: 'delta',
    chunk,
    at: 0,
});
const result = (value: unknown): StitchEvent => ({
    type: 'result',
    data: value,
    status: 200,
    attempts: 1,
    at: 0,
});
const done: StitchEvent = {
    type: 'done',
    ok: true,
    elapsed: 1,
    attempts: 1,
    at: 0,
};

function stitchError(message: string, status?: number): Error {
    const e = new Error(message) as Error & { status?: number };
    e.name = 'StitchError';
    if (status !== undefined) e.status = status;
    return e;
}

// --- streamStitchSse ---------------------------------------------------------

describe('streamStitchSse', () => {
    test('streams each delta as an SSE frame and sets the content type', async () => {
        const res = streamStitchSse(
            events(delta('a'), delta('b'), result(['a', 'b']), done),
        );
        expect(res.headers.get('content-type')).toBe(
            'text/event-stream; charset=utf-8',
        );
        const body = await res.text();
        expect(body).toBe('data: a\n\ndata: b\n\n');
    });

    test('accepts anything with a .stream() (the core StitchEventSource intake)', async () => {
        const source = { stream: () => events(delta('a'), done) };
        const res = streamStitchSse(source);
        expect(await res.text()).toBe('data: a\n\n');
    });

    test('a `data` mapper pulls text out of a structured chunk', async () => {
        const res = streamStitchSse(events(delta({ text: 'hi' }), done), {
            data: (c) => (c as { text: string }).text,
        });
        expect(await res.text()).toBe('data: hi\n\n');
    });

    test('the data mapper receives the zero-based frame index', async () => {
        const res = streamStitchSse(events(delta('a'), delta('b'), done), {
            data: (c, index) => `${String(c)}#${index}`,
        });
        expect(await res.text()).toBe('data: a#0\n\ndata: b#1\n\n');
    });

    test('event accepts a function of the chunk for per-frame event names', async () => {
        const res = streamStitchSse(
            events(
                delta({ kind: 'token', text: 'a' }),
                delta({ kind: 'usage', text: 'b' }),
                done,
            ),
            {
                event: (c) => (c as { kind: string }).kind,
                data: (c) => (c as { text: string }).text,
            },
        );
        expect(await res.text()).toBe(
            'event: token\ndata: a\n\nevent: usage\ndata: b\n\n',
        );
    });

    test('by default an error event yields a named event: error frame with a generic token, never the raw message', async () => {
        const res = streamStitchSse(
            events(delta('a'), {
                type: 'error',
                name: 'StitchError',
                // A transport failure whose message discloses an internal hostname — it must NOT
                // reach the client (topology disclosure; same class PR #407/#408 fixed on the
                // error-handler surface).
                message: 'getaddrinfo ENOTFOUND payments.internal.corp',
                status: 502,
                attempts: 1,
                at: 0,
            }),
        );
        const body = await res.text();
        // The stream still ends with a named `error` frame, but the data is a generic token.
        expect(body).toBe('data: a\n\nevent: error\ndata: error\n\n');
        expect(body).not.toContain('payments.internal.corp');
        expect(body).not.toContain('ENOTFOUND');
    });

    test('errorData opts in to the raw message on the error frame', async () => {
        const res = streamStitchSse(
            events(delta('a'), {
                type: 'error',
                name: 'StitchError',
                message: 'upstream blew up',
                attempts: 1,
                at: 0,
            }),
            { errorData: (e) => e.message },
        );
        const body = await res.text();
        expect(body).toBe(
            'data: a\n\nevent: error\ndata: upstream blew up\n\n',
        );
    });

    test('onError observes the real failure server-side while the client frame stays generic', async () => {
        const onError = vi.fn();
        const res = streamStitchSse(
            events(delta('a'), {
                type: 'error',
                name: 'StitchError',
                message: 'getaddrinfo ENOTFOUND payments.internal.corp',
                status: 502,
                attempts: 1,
                at: 0,
            }),
            { onError },
        );
        const body = await res.text();
        expect(body).toBe('data: a\n\nevent: error\ndata: error\n\n');
        expect(onError).toHaveBeenCalledTimes(1);
        expect((onError.mock.calls[0]?.[0] as Error).message).toBe(
            'getaddrinfo ENOTFOUND payments.internal.corp',
        );
    });

    test('the event option labels each frame', async () => {
        const res = streamStitchSse(events(delta('a'), done), {
            event: 'token',
        });
        expect(await res.text()).toBe('event: token\ndata: a\n\n');
    });

    test('the id option emits an id: line per frame with the zero-based index', async () => {
        const res = streamStitchSse(events(delta('a'), delta('b'), done), {
            id: (chunk, i) => `${String(chunk)}-${i}`,
        });
        expect(await res.text()).toBe(
            'id: a-0\ndata: a\n\nid: b-1\ndata: b\n\n',
        );
    });

    test('a multi-line chunk gets one data: prefix per line (SSE spec)', async () => {
        const res = streamStitchSse(events(delta('l1\nl2'), done));
        expect(await res.text()).toBe('data: l1\ndata: l2\n\n');
    });

    test('extra headers merge over the SSE defaults, with overrides winning', async () => {
        const res = streamStitchSse(events(delta('a'), done), {
            headers: { 'x-custom': '1', 'cache-control': 'no-store' },
        });
        expect(res.headers.get('x-custom')).toBe('1');
        // A default that is not overridden survives…
        expect(res.headers.get('content-type')).toBe(
            'text/event-stream; charset=utf-8',
        );
        // …and an explicit override wins (spread after the defaults).
        expect(res.headers.get('cache-control')).toBe('no-store');
        await res.text();
    });

    test('a pre-aborted signal yields no frames', async () => {
        const res = streamStitchSse(events(delta('a'), delta('b'), done), {
            signal: AbortSignal.abort(),
        });
        expect(await res.text()).toBe('');
    });

    test('by default a throw mid-stream ends with a generic error frame (raw message withheld)', async () => {
        async function* boom(): AsyncGenerator<StitchEvent, void> {
            yield delta('a');
            // A transport failure disclosing an internal hostname must not reach the client.
            throw new Error('getaddrinfo ENOTFOUND payments.internal.corp');
        }
        const res = streamStitchSse(boom());
        const body = await res.text();
        expect(body).toBe('data: a\n\nevent: error\ndata: error\n\n');
        expect(body).not.toContain('payments.internal.corp');
        expect(body).not.toContain('ENOTFOUND');
    });

    test('errorData opts in to the raw message on the throw path too', async () => {
        async function* boom(): AsyncGenerator<StitchEvent, void> {
            yield delta('a');
            throw new Error('stream blew up');
        }
        const res = streamStitchSse(boom(), { errorData: (e) => e.message });
        const body = await res.text();
        expect(body).toBe('data: a\n\nevent: error\ndata: stream blew up\n\n');
    });

    test('onError observes the original thrown value on the throw path', async () => {
        const thrown = new Error('stream blew up');
        async function* boom(): AsyncGenerator<StitchEvent, void> {
            yield delta('a');
            throw thrown;
        }
        const onError = vi.fn();
        const res = streamStitchSse(boom(), { onError });
        await res.text();
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0]?.[0]).toBe(thrown);
    });
});

// --- stitchErrorResponse ---------------------------------------------------

describe('stitchErrorResponse', () => {
    test('a StitchError maps to 502 by default with a generic JSON body', async () => {
        const res = stitchErrorResponse(stitchError('upstream down', 503));
        expect(res).toBeDefined();
        expect(res?.status).toBe(502);
        expect(res?.headers.get('content-type')).toContain('application/json');
        // the raw message is withheld by default (see the leak-regression block below)
        expect(await res?.json()).toEqual({ error: 'Bad Gateway' });
    });

    test('status can propagate the upstream status', async () => {
        const res = stitchErrorResponse(stitchError('rate limited', 429), {
            status: (e) => e.status ?? 502,
        });
        expect(res?.status).toBe(429);
    });

    test('a non-StitchError returns undefined so the caller can rethrow it', () => {
        expect(stitchErrorResponse(new Error('oops'))).toBeUndefined();
        expect(stitchErrorResponse('oops')).toBeUndefined();
        expect(stitchErrorResponse(undefined)).toBeUndefined();
    });

    test('composes with ?? for the map-or-rethrow pattern', () => {
        const fallthrough = new Error('not a stitch failure');
        const attempt = (err: unknown): Response => {
            const mapped = stitchErrorResponse(err);
            if (mapped) return mapped;
            throw err;
        };
        expect(attempt(stitchError('upstream down'))).toBeInstanceOf(Response);
        expect(() => attempt(fallthrough)).toThrow(fallthrough);
    });

    // Regression: the default body must not echo the raw upstream/transport message,
    // which can leak internal network topology (a transport error names the host it
    // failed to reach) or the upstream's status semantics to an untrusted client.
    describe('does not leak the raw error message by default', () => {
        test('a transport failure with an internal hostname is not disclosed', async () => {
            const res = stitchErrorResponse(
                stitchError('getaddrinfo ENOTFOUND payments.internal.corp'),
            );
            expect(res?.status).toBe(502);
            const body = await res?.text();
            expect(body).not.toContain('payments.internal.corp');
            expect(body).not.toContain('ENOTFOUND');
        });

        test("an upstream 401 does not surface as 'HTTP 401' in the body", async () => {
            const res = stitchErrorResponse(stitchError('HTTP 401', 401));
            expect(res?.status).toBe(502);
            expect(await res?.text()).not.toContain('HTTP 401');
        });

        test('the `body` opt-in can still include the raw message', async () => {
            const res = stitchErrorResponse(
                stitchError('getaddrinfo ENOTFOUND payments.internal.corp'),
                { body: (e) => ({ error: e.message }) },
            );
            expect(await res?.text()).toContain('payments.internal.corp');
        });
    });
});

describe('isStitchError', () => {
    test('matches the branded error only', () => {
        expect(isStitchError(stitchError('x'))).toBe(true);
        expect(isStitchError(new Error('x'))).toBe(false);
        expect(isStitchError('x')).toBe(false);
    });
});
