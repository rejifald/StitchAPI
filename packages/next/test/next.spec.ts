// @stitchapi/next behaviour — Web-standard Response helpers driven with fake event
// sources and errors. No engine, no Next.
import { stitchError, streamStitchSse } from '../src';
import * as api from '../src';

import type { StitchEvent } from 'stitchapi';
import { describe, expect, test } from 'vitest';

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

function makeStitchError(message: string, status?: number): Error {
    const e = new Error(message) as Error & { status?: number };
    e.name = 'StitchError';
    if (status !== undefined) e.status = status;
    return e;
}

// --- streamStitchSse -----------------------------------------------------------

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

    test('a `delta` function shorthand pulls text out of a structured chunk', async () => {
        const res = streamStitchSse(events(delta({ text: 'hi' }), done), {
            delta: (c) => (c as { text: string }).text,
        });
        expect(await res.text()).toBe('data: hi\n\n');
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

    test('error (function shorthand) opts in to the raw message on the error frame', async () => {
        const res = streamStitchSse(
            events(delta('a'), {
                type: 'error',
                name: 'StitchError',
                message: 'upstream blew up',
                attempts: 1,
                at: 0,
            }),
            { error: (e) => e.message },
        );
        const body = await res.text();
        expect(body).toBe(
            'data: a\n\nevent: error\ndata: upstream blew up\n\n',
        );
    });

    test('the delta.event option labels each frame', async () => {
        const res = streamStitchSse(events(delta('a'), done), {
            delta: { event: 'token' },
        });
        expect(await res.text()).toBe('event: token\ndata: a\n\n');
    });

    test('the delta.id option emits an id: line per frame with the zero-based index', async () => {
        const res = streamStitchSse(events(delta('a'), delta('b'), done), {
            delta: { id: (chunk, i) => `${String(chunk)}-${i}` },
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

    test('error opts in to the raw message on the throw path too', async () => {
        async function* boom(): AsyncGenerator<StitchEvent, void> {
            yield delta('a');
            throw new Error('stream blew up');
        }
        const res = streamStitchSse(boom(), { error: (e) => e.message });
        const body = await res.text();
        expect(body).toBe('data: a\n\nevent: error\ndata: stream blew up\n\n');
    });

    test('error.observe sees the real failure even when the client gets the generic token', async () => {
        const observed: unknown[] = [];
        const res = streamStitchSse(
            events(delta('a'), {
                type: 'error',
                name: 'StitchError',
                message: 'getaddrinfo ENOTFOUND payments.internal.corp',
                status: 502,
                attempts: 1,
                at: 0,
            }),
            { error: { observe: (err) => observed.push(err) } },
        );
        const body = await res.text();
        // Client still gets the generic token — the raw message is withheld.
        expect(body).toBe('data: a\n\nevent: error\ndata: error\n\n');
        expect(body).not.toContain('payments.internal.corp');
        // … but observe got the real failure server-side.
        expect((observed[0] as Error).message).toContain('ENOTFOUND');
    });

    test('error can be the full object with a custom event name', async () => {
        const res = streamStitchSse(
            events(delta('a'), {
                type: 'error',
                name: 'StitchError',
                message: 'upstream blew up',
                attempts: 1,
                at: 0,
            }),
            { error: { data: (e) => e.message, event: 'failure' } },
        );
        expect(await res.text()).toBe(
            'data: a\n\nevent: failure\ndata: upstream blew up\n\n',
        );
    });
});

// --- stitchError.map -------------------------------------------------------

describe('stitchError.map', () => {
    // The helper now returns `Response | undefined` (undefined ⇒ not a StitchError, so the
    // caller can rethrow). The cases below all pass a StitchError, so a Response is
    // guaranteed — narrow it once here.
    const mustRespond = (res: Response | undefined): Response => {
        if (!res) throw new Error('expected a Response');
        return res;
    };

    test('a StitchError maps to 502 by default with a generic JSON body', async () => {
        const res = mustRespond(
            stitchError.map(makeStitchError('upstream down', 503)),
        );
        expect(res.status).toBe(502);
        expect(res.headers.get('content-type')).toContain('application/json');
        // the raw message is withheld by default (see the leak-regression block below)
        expect(await res.json()).toEqual({ error: 'Bad Gateway' });
    });

    test('status can propagate the upstream status', async () => {
        const res = mustRespond(
            stitchError.map(makeStitchError('rate limited', 429), {
                status: (e) => e.status ?? 502,
            }),
        );
        expect(res.status).toBe(429);
    });

    test('a non-StitchError returns undefined so the caller can rethrow', () => {
        expect(stitchError.map(new Error('oops'))).toBeUndefined();
        expect(stitchError.map('not even an error')).toBeUndefined();
    });

    // Regression: the default body must not echo the raw upstream/transport message,
    // which can leak internal network topology (a transport error names the host it
    // failed to reach) or the upstream's status semantics to an untrusted client.
    describe('does not leak the raw error message by default', () => {
        test('a transport failure with an internal hostname is not disclosed', async () => {
            const res = mustRespond(
                stitchError.map(
                    makeStitchError(
                        'getaddrinfo ENOTFOUND payments.internal.corp',
                    ),
                ),
            );
            expect(res.status).toBe(502);
            const body = await res.text();
            expect(body).not.toContain('payments.internal.corp');
            expect(body).not.toContain('ENOTFOUND');
        });

        test("an upstream 401 does not surface as 'HTTP 401' in the body", async () => {
            const res = mustRespond(
                stitchError.map(makeStitchError('HTTP 401', 401)),
            );
            expect(res.status).toBe(502);
            expect(await res.text()).not.toContain('HTTP 401');
        });

        test('the `body` opt-in can still include the raw message', async () => {
            const res = mustRespond(
                stitchError.map(
                    makeStitchError(
                        'getaddrinfo ENOTFOUND payments.internal.corp',
                    ),
                    { body: (e) => ({ error: e.message }) },
                ),
            );
            expect(await res.text()).toContain('payments.internal.corp');
        });
    });
});

describe('stitchError.is', () => {
    test('matches the branded error only', () => {
        expect(stitchError.is(makeStitchError('x'))).toBe(true);
        expect(stitchError.is(new Error('x'))).toBe(false);
        expect(stitchError.is('x')).toBe(false);
    });
});

// --- public-surface pin: the error family is ONE namespace -------------------
//
// This package has no dedicated public-surface spec (only core does), so the pin lives here,
// beside the behaviour it guards. It mirrors the intent of core's `REMOVED_SECRET_FUNCTIONS`
// in `packages/core/test/public-api-surface.spec.ts`, in both directions:
//
//  - PRESENT, as a WHOLE: `stitchError` is an OBJECT whose members are exactly `is` and `map` (no `handler`: a Next route
//    handler is its own `Request` -> `Response` function, so there is no central error
//    hook to register one on).
//    The key set is pinned rather than each member independently, so adding or dropping one is
//    a deliberate edit here — the same call core's `SECRET_NAMESPACE_MEMBERS` makes. Object-ness
//    is asserted explicitly because `stitchError` was a FUNCTION in `@stitchapi/hono` before the
//    fold, and a bare `typeof === 'function'` check would have passed for it.
//  - ABSENT: every verb-prefixed spelling the namespace replaced, across all six adapters — not
//    only the ones this package carried. Pre-GA `rc`, so they were removed outright rather than
//    aliased (CONTRACT.md P19); re-adding one would put two spellings of one call back on the
//    barrel, which is exactly the drift this fold closes.
describe('public surface: the stitchError namespace', () => {
    const MEMBERS = ['is', 'map'] as const;

    test('exports stitchError as a namespace object', () => {
        expect(typeof api.stitchError).toBe('object');
        expect(Object.keys(api.stitchError).sort()).toEqual(
            [...MEMBERS].sort(),
        );
    });

    test.each(MEMBERS)('exports stitchError.%s as a function', (member) => {
        expect(
            typeof (api.stitchError as Record<string, unknown>)[member],
        ).toBe('function');
    });

    test.each([
        'isStitchError',
        'stitchErrorHandler',
        'stitchOnError',
        'stitchErrorResponse',
        'toHttpException',
    ] as const)('does NOT export %s — the namespace replaced it', (name) => {
        expect(name in (api as Record<string, unknown>)).toBe(false);
    });
});
