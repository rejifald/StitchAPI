// Behavioural tests for @stitchapi/fastify, fully offline: the seam is built with a FAKE
// `adapter` (no network), so every stitch call resolves against canned responses. We drive the
// app with `fastify.inject()` and assert the four contracts: the seam is decorated, the
// request-scoped principal binds (a route reads `currentStitch()` and `request.stitch`),
// `sendStitchSse` streams events, and `stitchErrorHandler` maps a StitchError to a status.
import {
    currentStitch,
    isStitchError,
    sendStitchSse,
    stitchErrorHandler,
    stitchPlugin,
} from '../src';

import Fastify from 'fastify';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
    StitchEvent,
} from 'stitchapi';
import { isSeam } from 'stitchapi';
import { afterEach, describe, expect, test } from 'vitest';

// A fake adapter: route by URL path so one seam serves several test endpoints. It records the
// requests it sees so a test can assert the principal-scoped auth state, etc.
function fakeAdapter(handler: (req: AdapterRequest) => AdapterResponse): {
    adapter: Adapter;
    seen: AdapterRequest[];
} {
    const seen: AdapterRequest[] = [];
    const adapter: Adapter = async (req) => {
        seen.push(req);
        return handler(req);
    };
    return { adapter, seen };
}

const apps: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
});

describe('stitchPlugin', () => {
    test('decorates the app with the seam (built from seamConfig)', async () => {
        const { adapter } = fakeAdapter(() => ({
            status: 200,
            headers: {},
            body: { ok: true },
        }));
        const app = Fastify();
        apps.push(app);
        await app.register(stitchPlugin, {
            seamConfig: { baseUrl: 'https://api.test', adapter },
            logger: false,
        });
        await app.ready();

        expect(isSeam(app.stitch)).toBe(true);
        // The decorated seam can build a member that hits the fake adapter.
        const me = app.stitch.stitch<{ ok: boolean }>({ path: '/me' });
        await expect(me()).resolves.toEqual({ ok: true });
    });

    test('borrows a prebuilt seam and never closes it by default', async () => {
        const { adapter } = fakeAdapter(() => ({
            status: 200,
            headers: {},
            body: { ok: true },
        }));
        const { seam } = await import('stitchapi');
        let closed = false;
        const borrowed = seam({ baseUrl: 'https://api.test', adapter });
        const origClose = borrowed.close.bind(borrowed);
        borrowed.close = async () => {
            closed = true;
            await origClose();
        };

        const app = Fastify();
        await app.register(stitchPlugin, { seam: borrowed, logger: false });
        await app.ready();
        expect(app.stitch).toBe(borrowed);
        await app.close();
        // A borrowed seam is the app's to dispose — the plugin must not close it.
        expect(closed).toBe(false);
    });

    test('binds a request-scoped principal on request.stitch and currentStitch()', async () => {
        const { adapter } = fakeAdapter((req) => ({
            status: 200,
            headers: {},
            // Echo back the request URL so the test can confirm the call went through.
            body: { url: req.url },
        }));
        const app = Fastify();
        apps.push(app);
        await app.register(stitchPlugin, {
            seamConfig: { baseUrl: 'https://api.test', adapter },
            principal: (r) => (r.headers['x-tenant'] as string) || undefined,
            logger: false,
        });

        app.get('/whoami', async (request) => {
            // request.stitch and currentStitch() must be the SAME per-request host.
            const ambient = currentStitch();
            const fromReq = request.stitch;
            const sameHost = ambient === fromReq;
            // The host has a principal bound → its __config is the shared (redacted) fragment;
            // the important contract is that a principal-bound handle has no lifecycle levers.
            const isPrincipalBound =
                !('close' in fromReq) && !('flush' in fromReq);
            return { sameHost, isPrincipalBound };
        });
        await app.ready();

        const res = await app.inject({
            method: 'GET',
            url: '/whoami',
            headers: { 'x-tenant': 'acme' },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ sameHost: true, isPrincipalBound: true });
    });

    test('falls back to the root seam when no principal is resolved', async () => {
        const { adapter } = fakeAdapter(() => ({
            status: 200,
            headers: {},
            body: {},
        }));
        const app = Fastify();
        apps.push(app);
        await app.register(stitchPlugin, {
            seamConfig: { baseUrl: 'https://api.test', adapter },
            principal: () => undefined, // anonymous
            logger: false,
        });
        app.get('/root', async (request) => ({
            isRoot: request.stitch === app.stitch,
        }));
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/root' });
        expect(res.json()).toEqual({ isRoot: true });
    });

    test('sendStitchSse streams delta events to the reply', async () => {
        // A hand-built event stream — the SSE bridge consumes any AsyncIterable<StitchEvent>.
        async function* events(): AsyncGenerator<StitchEvent<unknown>> {
            yield {
                type: 'start',
                name: 's',
                method: 'GET',
                url: '/x',
                input: {},
                at: 0,
            };
            yield { type: 'delta', chunk: 'hello', at: 1 };
            yield { type: 'delta', chunk: 'world', at: 2 };
            yield { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 3 };
        }
        const app = Fastify();
        apps.push(app);
        await app.register(stitchPlugin, {
            seamConfig: {
                baseUrl: 'https://api.test',
                adapter: fakeAdapter(() => ({
                    status: 200,
                    headers: {},
                    body: {},
                })).adapter,
            },
            logger: false,
        });
        app.get('/sse', (_request, reply) => sendStitchSse(reply, events()));
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/sse' });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/event-stream');
        // Only the two delta chunks become frames; control events are not forwarded.
        expect(res.body).toBe('data: hello\n\ndata: world\n\n');
    });

    test('by default an error event yields a named event: error frame with a generic token, never the raw message', async () => {
        async function* events(): AsyncGenerator<StitchEvent<unknown>> {
            yield { type: 'delta', chunk: 'partial', at: 1 };
            yield {
                type: 'error',
                name: 'StitchError',
                // A transport failure whose message discloses an internal hostname — it must NOT
                // reach the client (topology disclosure; same class PR #408 fixed on the
                // error-handler surface).
                message: 'getaddrinfo ENOTFOUND payments.internal.corp',
                status: 502,
                attempts: 1,
                at: 2,
            };
        }
        const app = Fastify();
        apps.push(app);
        await app.register(stitchPlugin, {
            seamConfig: {
                baseUrl: 'https://api.test',
                adapter: fakeAdapter(() => ({
                    status: 200,
                    headers: {},
                    body: {},
                })).adapter,
            },
            logger: false,
        });
        app.get('/sse-err', (_request, reply) =>
            sendStitchSse(reply, events()),
        );
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/sse-err' });
        // The stream still ends with a named `error` frame, but the data is a generic token.
        expect(res.body).toBe('data: partial\n\nevent: error\ndata: error\n\n');
        expect(res.body).not.toContain('payments.internal.corp');
        expect(res.body).not.toContain('ENOTFOUND');
    });

    test('errorData opts in to the raw message on the error frame', async () => {
        async function* events(): AsyncGenerator<StitchEvent<unknown>> {
            yield { type: 'delta', chunk: 'partial', at: 1 };
            yield {
                type: 'error',
                name: 'StitchError',
                message: 'upstream blew up',
                attempts: 1,
                at: 2,
            };
        }
        const app = Fastify();
        apps.push(app);
        await app.register(stitchPlugin, {
            seamConfig: {
                baseUrl: 'https://api.test',
                adapter: fakeAdapter(() => ({
                    status: 200,
                    headers: {},
                    body: {},
                })).adapter,
            },
            logger: false,
        });
        app.get('/sse-err', (_request, reply) =>
            sendStitchSse(reply, events(), { errorData: (e) => e.message }),
        );
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/sse-err' });
        expect(res.body).toBe(
            'data: partial\n\nevent: error\ndata: upstream blew up\n\n',
        );
    });

    test('the registered error handler maps a StitchError to 502 by default', async () => {
        // The fake adapter returns 503 → the stitch throws a StitchError with status 503.
        const { adapter } = fakeAdapter(() => ({
            status: 503,
            headers: {},
            body: { message: 'down' },
        }));
        const app = Fastify();
        apps.push(app);
        await app.register(stitchPlugin, {
            seamConfig: { baseUrl: 'https://api.test', adapter },
            logger: false,
        });
        app.get('/fail', async (request) => {
            // No try/catch — the thrown StitchError is mapped by the plugin's error handler.
            return request.stitch.stitch({ path: '/down' })();
        });
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/fail' });
        expect(res.statusCode).toBe(502); // gateway default — upstream 503 is not leaked
        // The default body is the generic, status-tied phrase — NOT the raw upstream message.
        expect(res.json()).toEqual({ error: 'Bad Gateway' });
    });

    test('the error handler can propagate the upstream status', async () => {
        const { adapter } = fakeAdapter(() => ({
            status: 429,
            headers: {},
            body: {},
        }));
        const app = Fastify();
        apps.push(app);
        await app.register(stitchPlugin, {
            seamConfig: { baseUrl: 'https://api.test', adapter },
            logger: false,
            errorHandler: { status: (e) => e.status ?? 502 },
        });
        app.get('/limited', async (request) =>
            request.stitch.stitch({ path: '/limited' })(),
        );
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/limited' });
        expect(res.statusCode).toBe(429);
    });

    test('non-stitch errors are rethrown for Fastify default handling', async () => {
        const { adapter } = fakeAdapter(() => ({
            status: 200,
            headers: {},
            body: {},
        }));
        const app = Fastify();
        apps.push(app);
        await app.register(stitchPlugin, {
            seamConfig: { baseUrl: 'https://api.test', adapter },
            logger: false,
        });
        app.get('/boom', async () => {
            throw new Error('not a stitch error');
        });
        await app.ready();

        const res = await app.inject({ method: 'GET', url: '/boom' });
        // Fastify's default handler renders an unmapped error as 500.
        expect(res.statusCode).toBe(500);
    });
});

describe('isStitchError / stitchErrorHandler unit', () => {
    test('isStitchError discriminates by name', () => {
        const e = Object.assign(new Error('x'), { name: 'StitchError' });
        expect(isStitchError(e)).toBe(true);
        expect(isStitchError(new Error('plain'))).toBe(false);
        expect(isStitchError('nope')).toBe(false);
    });

    test('stitchErrorHandler rethrows a non-stitch error', () => {
        const handler = stitchErrorHandler();
        const plain = new Error('plain') as never;
        expect(() =>
            handler(
                plain,
                {} as never,
                {
                    status: () => ({ send: () => undefined }),
                } as never,
            ),
        ).toThrow('plain');
    });

    // A fake reply capturing the `.status(code).send(body)` chain, so the handler can be driven
    // directly (no Fastify instance) to assert exactly what body leaves the process.
    function captureReply(): {
        reply: FastifyReply;
        statusCode: number | undefined;
        sent: unknown;
    } {
        const captured: { statusCode: number | undefined; sent: unknown } = {
            statusCode: undefined,
            sent: undefined,
        };
        const reply = {
            status(code: number) {
                captured.statusCode = code;
                return this;
            },
            send(body: unknown) {
                captured.sent = body;
                return this;
            },
        };
        return {
            reply: reply as unknown as FastifyReply,
            get statusCode() {
                return captured.statusCode;
            },
            get sent() {
                return captured.sent;
            },
        };
    }

    test('does not leak a transport failure message (internal hostname) by default', () => {
        // The exact shape core throws for a BYO-adapter/DNS failure: message carries the host.
        const err = Object.assign(
            new Error('getaddrinfo ENOTFOUND payments.internal.corp'),
            { name: 'StitchError' },
        ) as unknown as FastifyError;
        const cap = captureReply();
        stitchErrorHandler()(err, {} as FastifyRequest, cap.reply);

        expect(cap.statusCode).toBe(502); // status stays masked
        const serialized = JSON.stringify(cap.sent);
        expect(serialized).not.toContain('payments.internal.corp');
        expect(serialized).not.toContain('ENOTFOUND');
        expect(cap.sent).toEqual({ error: 'Bad Gateway' });
    });

    test('does not leak the upstream status message (`HTTP 401`) by default', () => {
        // core builds `HTTP <status>` (packages/core/src/engine.ts) for an upstream error.
        const err = Object.assign(new Error('HTTP 401'), {
            name: 'StitchError',
            status: 401,
        }) as unknown as FastifyError;
        const cap = captureReply();
        stitchErrorHandler()(err, {} as FastifyRequest, cap.reply);

        expect(cap.statusCode).toBe(502);
        expect(JSON.stringify(cap.sent)).not.toContain('HTTP 401');
        expect(cap.sent).toEqual({ error: 'Bad Gateway' });
    });

    test('the `body` opt-in still includes the raw message', () => {
        const err = Object.assign(
            new Error('getaddrinfo ENOTFOUND payments.internal.corp'),
            { name: 'StitchError' },
        ) as unknown as FastifyError;
        const cap = captureReply();
        stitchErrorHandler({ body: (e) => ({ error: e.message }) })(
            err,
            {} as FastifyRequest,
            cap.reply,
        );

        // The escape hatch is preserved — callers who want the message can still opt in.
        expect(cap.sent).toEqual({
            error: 'getaddrinfo ENOTFOUND payments.internal.corp',
        });
    });
});
