// @stitchapi/elysia integration tests. Elysia is Bun-first, so we drive it RUNTIME-AGNOSTICALLY via
// `app.handle(new Request(...))` (Web-standard, works under Node — no Bun needed) and a FAKE adapter
// (no socket): a stitch's `adapter` is just `(req) => Promise<AdapterResponse>`, so we inject canned
// responses — buffered JSON for the plugin/error paths, a live `ReadableStream` for the SSE path
// (mirroring core's test/support/streams.ts, inlined here to avoid a cross-package import). Asserts
// the three public surfaces: seam-on-context (+ principal binding), the SSE bridge, and the
// StitchError → HTTP mapping.
import { stitch } from '../src';
import { isStitchError, stitchErrorResponse } from '../src';
import { streamStitchSse } from '../src';

import { Elysia } from 'elysia';
import type { Adapter } from 'stitchapi';
import { seam } from 'stitchapi';
import { sseSurface } from 'stitchapi/sse';
import { describe, expect, test } from 'vitest';

const enc = new TextEncoder();

/** A ReadableStream that emits each chunk as its own read, then closes (precise SSE boundaries). */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (i >= chunks.length) {
                controller.close();
                return;
            }
            controller.enqueue(enc.encode(chunks[i++]));
        },
    });
}

/** A buffered adapter that returns the same canned JSON for any request. */
function jsonAdapter(status: number, body: unknown): Adapter {
    return () => Promise.resolve({ status, headers: {}, body });
}

/** A streaming adapter that hands back `body` as the live (`req.stream`) response body. */
function sseAdapter(chunks: string[], status = 200): Adapter {
    return (req) => {
        if (!req.stream)
            return Promise.reject(new Error('expected req.stream to be set'));
        return Promise.resolve({
            status,
            headers: { 'content-type': 'text/event-stream' },
            body: streamOf(chunks),
        });
    };
}

const GET = (path: string, init?: RequestInit): Request =>
    new Request(`http://localhost${path}`, init);

describe('stitch() plugin puts a seam on the context', () => {
    test('handlers read the seam via ctx.stitch and it resolves a call', async () => {
        const api = seam({ baseUrl: 'https://api.test' });
        const app = new Elysia()
            .use(stitch({ seam: api }))
            .get('/me', ({ stitch }) =>
                stitch.stitch({
                    path: '/me',
                    adapter: jsonAdapter(200, { id: 'u1' }),
                })(),
            );

        const res = await app.handle(GET('/me'));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: 'u1' });
        await api.close();
    });

    test('principal binds the request seam — it is the lifecycle-free PrincipalSeam', async () => {
        const api = seam({ baseUrl: 'https://api.test' });
        const app = new Elysia()
            .use(
                stitch({
                    seam: api,
                    principal: ({ request }) =>
                        request.headers.get('x-user') ?? undefined,
                }),
            )
            // A principal handle is lifecycle-free: it lacks `close` (a root-only lever, ADR 0002).
            .get('/whoami', ({ stitch }) => ({
                isPrincipal: !('close' in stitch),
                isRoot: 'close' in stitch,
            }));

        // With a principal header → bound PrincipalSeam (no `close`).
        const bound = await (
            await app.handle(GET('/whoami', { headers: { 'x-user': 'alice' } }))
        ).json();
        expect(bound).toEqual({ isPrincipal: true, isRoot: false });

        // Without it → the root seam (has `close`), proving the binding is request-scoped.
        const root = await (await app.handle(GET('/whoami'))).json();
        expect(root).toEqual({ isPrincipal: false, isRoot: true });
        await api.close();
    });

    test('the bound principal cannot be named in a call argument (closure-only)', async () => {
        // The principal lives in the `.as(id)` closure, never in StitchInput — there is no call
        // argument a handler (or attacker) could set to impersonate another identity.
        const api = seam();
        const app = new Elysia()
            .use(stitch({ seam: api, principal: () => 'svc' }))
            // `as` exists (re-bind), but the principal is not surfaced as data on the handle.
            .get('/x', ({ stitch }) => ({
                hasAs: typeof stitch.as === 'function',
            }));

        const res = await app.handle(GET('/x'));
        expect(await res.json()).toEqual({ hasAs: true });
        await api.close();
    });
});

describe('streamStitchSse bridges a stitch stream to an SSE body', () => {
    test('each delta becomes a data: message in the SSE response body', async () => {
        const api = seam({ baseUrl: 'https://api.test' });
        const app = new Elysia()
            .use(stitch({ seam: api }))
            .get('/events', ({ stitch }) => {
                const events = stitch.stitch({
                    kind: sseSurface,
                    path: '/events',
                    adapter: sseAdapter(['data: one\n\n', 'data: two\n\n']),
                });
                return streamStitchSse(events.stream(), {
                    // The sse surface parses each frame to `{ data: 'one' }`; pull the text back out.
                    delta: (chunk) => (chunk as { data: string }).data,
                });
            });

        const res = await app.handle(GET('/events'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const body = await res.text();
        expect(body).toContain('data: one');
        expect(body).toContain('data: two');
        await api.close();
    });

    test('a mid-stream / upstream error ends with an event: error frame', async () => {
        const api = seam({ baseUrl: 'https://api.test' });
        const app = new Elysia()
            .use(stitch({ seam: api }))
            .get('/events', ({ stitch }) => {
                const events = stitch.stitch({
                    kind: sseSurface,
                    path: '/events',
                    // A >=400 open fails before any delta → the stream yields an `error` event.
                    adapter: sseAdapter(['data: nope\n\n'], 500),
                });
                return streamStitchSse(events.stream());
            });

        const res = await app.handle(GET('/events'));
        const body = await res.text();
        // A generic `data: error` token — the raw upstream message (`HTTP 500`) is withheld
        // so upstream status/topology is not disclosed; `errorData` is the opt-in.
        expect(body).toContain('event: error\ndata: error');
        expect(body).not.toContain('HTTP 500');
        await api.close();
    });
});

describe('stitchOnError / stitchErrorResponse map a StitchError to HTTP', () => {
    test('a thrown StitchError becomes a 502 by default via the plugin onError', async () => {
        const api = seam({ baseUrl: 'https://api.test' });
        // The upstream 404 is thrown as a StitchError; the handler does NOT catch it.
        const app = new Elysia()
            .use(stitch({ seam: api }))
            .get('/boom', ({ stitch }) =>
                stitch.stitch({
                    path: '/missing',
                    adapter: jsonAdapter(404, { error: 'not found' }),
                })(),
            );

        const res = await app.handle(GET('/boom'));
        // 502 by default — the upstream 404 is NOT leaked to the client.
        expect(res.status).toBe(502);
        await api.close();
    });

    test('status override propagates the upstream status', async () => {
        const api = seam({ baseUrl: 'https://api.test' });
        const app = new Elysia()
            .use(
                stitch({
                    seam: api,
                    onError: { status: (e) => e.status ?? 502 },
                }),
            )
            .get('/boom', ({ stitch }) =>
                stitch.stitch({
                    path: '/missing',
                    adapter: jsonAdapter(404, { error: 'not found' }),
                })(),
            );

        const res = await app.handle(GET('/boom'));
        expect(res.status).toBe(404);
        await api.close();
    });

    test('onError:false registers no mapping (upstream error is not mapped to 502)', async () => {
        const api = seam({ baseUrl: 'https://api.test' });
        const app = new Elysia()
            .use(stitch({ seam: api, onError: false }))
            .get('/boom', ({ stitch }) =>
                stitch.stitch({
                    path: '/missing',
                    adapter: jsonAdapter(404, { error: 'not found' }),
                })(),
            );

        const res = await app.handle(GET('/boom'));
        // Elysia's default error handling renders an uncaught throw as 500 — not our 502 mapping.
        expect(res.status).not.toBe(502);
        await api.close();
    });

    test('onError:true registers the default mapping (the new P13 spelling, at runtime)', async () => {
        // `true` never type-checked before, so this asserts the RUNTIME honours it — not just
        // that the signature widened. It must behave exactly like omitting the key: register
        // the 502-by-default mapping, NOT pass `true` through to `stitchOnError`.
        const api = seam({ baseUrl: 'https://api.test' });
        const app = new Elysia()
            .use(stitch({ seam: api, onError: true }))
            .get('/boom', ({ stitch }) =>
                stitch.stitch({
                    path: '/missing',
                    adapter: jsonAdapter(404, { error: 'not found' }),
                })(),
            );

        const res = await app.handle(GET('/boom'));
        expect(res.status).toBe(502);
        await api.close();
    });

    test('the empty onError bag is rejected (compile-time, P20)', () => {
        const api = seam({ baseUrl: 'https://api.test' });
        // @ts-expect-error — `{}` is not a valid bag: enable-with-defaults is `true` (P13/P20)
        void stitch({ seam: api, onError: {} });
        expect(true).toBe(true);
    });

    test('stitchErrorResponse returns undefined for a non-Stitch error (caller falls through)', async () => {
        expect(stitchErrorResponse(new Error('plain'))).toBeUndefined();
        const mapped = stitchErrorResponse(
            Object.assign(new Error('upstream'), {
                name: 'StitchError',
                status: 503,
            }),
            { status: (e) => e.status ?? 502 },
        );
        expect(mapped?.status).toBe(503);
        // The default body is a generic phrase — the raw `upstream` message is NOT echoed.
        expect(await mapped?.json()).toEqual({ error: 'Error' });
    });

    // Regression: the default response body must not echo the raw upstream/transport message,
    // which can disclose internal network topology (a transport error names the host it failed
    // to reach) or the upstream's status semantics to an untrusted client.
    describe('does not leak the raw error message by default', () => {
        test('a transport failure with an internal hostname is not disclosed', async () => {
            // The exact shape core throws for a BYO-adapter/DNS failure: message carries the host.
            const res = stitchErrorResponse(
                Object.assign(
                    new Error('getaddrinfo ENOTFOUND payments.internal.corp'),
                    { name: 'StitchError' },
                ),
            );
            expect(res?.status).toBe(502); // status stays masked
            const body = await res!.text();
            expect(body).not.toContain('payments.internal.corp');
            expect(body).not.toContain('ENOTFOUND');
            expect(JSON.parse(body)).toEqual({ error: 'Bad Gateway' });
        });

        test("an upstream 401 does not surface as 'HTTP 401' in the body", async () => {
            // core builds `HTTP <status>` (packages/core/src/engine.ts) for an upstream error.
            const res = stitchErrorResponse(
                Object.assign(new Error('HTTP 401'), {
                    name: 'StitchError',
                    status: 401,
                }),
            );
            expect(res?.status).toBe(502);
            expect(await res!.text()).not.toContain('HTTP 401');
        });

        test('the `body` opt-in still includes the raw message', async () => {
            const res = stitchErrorResponse(
                Object.assign(
                    new Error('getaddrinfo ENOTFOUND payments.internal.corp'),
                    { name: 'StitchError' },
                ),
                { body: (e) => ({ error: e.message }) },
            );
            // The escape hatch is preserved — callers who want the message can still opt in.
            expect(await res!.json()).toEqual({
                error: 'getaddrinfo ENOTFOUND payments.internal.corp',
            });
        });
    });

    test('isStitchError discriminates by name', () => {
        const e = Object.assign(new Error('x'), { name: 'StitchError' });
        expect(isStitchError(e)).toBe(true);
        expect(isStitchError(new Error('plain'))).toBe(false);
        expect(isStitchError('nope')).toBe(false);
    });
});
