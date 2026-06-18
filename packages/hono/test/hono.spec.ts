// @stitchapi/hono integration tests. Everything runs over Hono's `app.request()` test client and a
// FAKE adapter (no socket): a stitch's `adapter` is just `(req) => Promise<AdapterResponse>`, so we
// inject canned responses — buffered JSON for the middleware/error paths, a live `ReadableStream`
// for the SSE path (mirroring core's test/support/streams.ts, inlined here to avoid a cross-package
// import). Asserts the three public surfaces: seam-on-context (+ principal binding), the SSE bridge,
// and the Stitch-error → HTTP mapping.
import { type StitchEnv, stitch } from '../src';
import { stitchError, stitchOnError } from '../src';
import { streamStitchSse } from '../src';

import { Hono } from 'hono';
import { seam } from 'stitchapi';
import type { Adapter } from 'stitchapi';
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
            controller.enqueue(enc.encode(chunks[i++] as string));
        },
    });
}

/** A buffered adapter that returns the same canned JSON for any request. */
function jsonAdapter(status: number, body: unknown): Adapter {
    return () => Promise.resolve({ status, headers: {}, body });
}

/** A streaming adapter that hands back `body` as the live (`req.stream`) response body. */
function sseAdapter(chunks: string[]): Adapter {
    return (req) => {
        if (!req.stream)
            return Promise.reject(new Error('expected req.stream to be set'));
        return Promise.resolve({
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: streamOf(chunks),
        });
    };
}

describe('stitch() middleware puts a seam on the context', () => {
    test('handlers read the seam via c.get("stitch") and it resolves a call', async () => {
        const api = seam({ baseUrl: 'https://api.test' });
        const app = new Hono<StitchEnv>();
        app.use(stitch({ seam: api }));
        app.get('/me', async (c) => {
            const s = c.get('stitch');
            const data = await s.stitch({
                path: '/me',
                adapter: jsonAdapter(200, { id: 'u1' }),
            })();
            return c.json(data);
        });

        const res = await app.request('/me');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: 'u1' });
        await api.close();
    });

    test('principal binds the request seam — it is the lifecycle-free PrincipalSeam', async () => {
        const api = seam({ baseUrl: 'https://api.test' });
        const app = new Hono<StitchEnv>();
        app.use(
            stitch({ seam: api, principal: (c) => c.req.header('x-user') }),
        );

        let boundIsPrincipal = false;
        let boundIsRoot = false;
        app.get('/whoami', (c) => {
            const s = c.get('stitch');
            // A principal handle is lifecycle-free: it lacks `close` (a root-only lever, ADR 0002).
            boundIsPrincipal = !('close' in s);
            boundIsRoot = 'close' in s;
            return c.text('ok');
        });

        // With a principal header → bound PrincipalSeam (no `close`).
        await app.request('/whoami', { headers: { 'x-user': 'alice' } });
        expect(boundIsPrincipal).toBe(true);
        expect(boundIsRoot).toBe(false);

        // Without it → the root seam (has `close`), proving the binding is request-scoped.
        await app.request('/whoami');
        expect(boundIsRoot).toBe(true);
        await api.close();
    });

    test('the bound principal cannot be named in a call argument (closure-only)', async () => {
        // The principal lives in the `.as(id)` closure, never in StitchInput — there is no call
        // argument a handler (or attacker) could set to impersonate another identity.
        const api = seam();
        const app = new Hono<StitchEnv>();
        app.use(stitch({ seam: api, principal: () => 'svc' }));
        app.get('/x', (c) => {
            const s = c.get('stitch');
            // `as` exists (re-bind), but the principal is not surfaced as data on the handle.
            return c.json({ hasAs: typeof s.as === 'function' });
        });
        const res = await app.request('/x');
        expect(await res.json()).toEqual({ hasAs: true });
        await api.close();
    });
});

describe('streamStitchSse bridges a stitch stream to an SSE body', () => {
    test('each delta becomes a data: message in the SSE response body', async () => {
        const api = seam({ baseUrl: 'https://api.test' });
        const app = new Hono<StitchEnv>();
        app.use(stitch({ seam: api }));
        app.get('/events', (c) => {
            const events = c.get('stitch').stitch({
                kind: sseSurface,
                path: '/events',
                adapter: sseAdapter(['data: one\n\n', 'data: two\n\n']),
            });
            return streamStitchSse(c, events.stream(), {
                // The sse surface parses each frame to `{ data: 'one' }`; pull the text back out.
                data: (chunk) => (chunk as { data: string }).data,
            });
        });

        const res = await app.request('/events');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        const body = await res.text();
        expect(body).toContain('data: one');
        expect(body).toContain('data: two');
    });

    test('a mid-stream / upstream error ends with an event: error frame', async () => {
        const api = seam({ baseUrl: 'https://api.test' });
        const app = new Hono<StitchEnv>();
        app.use(stitch({ seam: api }));
        app.get('/events', (c) => {
            const events = c.get('stitch').stitch({
                kind: sseSurface,
                path: '/events',
                // A >=400 open fails before any delta → the stream yields an `error` event.
                adapter: (req) => {
                    if (!req.stream)
                        return Promise.reject(new Error('expected stream'));
                    return Promise.resolve({
                        status: 500,
                        headers: {},
                        body: streamOf(['data: nope\n\n']),
                    });
                },
            });
            return streamStitchSse(c, events.stream());
        });

        const res = await app.request('/events');
        const body = await res.text();
        expect(body).toContain('event: error');
    });
});

describe('stitchError / stitchOnError map a StitchError to HTTP', () => {
    test('a thrown StitchError becomes a 502 by default via the onError handler', async () => {
        const api = seam({ baseUrl: 'https://api.test' });
        const app = new Hono<StitchEnv>();
        app.use(stitch({ seam: api }));
        app.onError(stitchOnError());
        app.get('/boom', async (c) => {
            // The upstream 404 is thrown as a StitchError; the handler does NOT catch it.
            const data = await c.get('stitch').stitch({
                path: '/missing',
                adapter: jsonAdapter(404, { error: 'not found' }),
            })();
            return c.json(data);
        });

        const res = await app.request('/boom');
        // 502 by default — the upstream 404 is NOT leaked to the client.
        expect(res.status).toBe(502);
        await api.close();
    });

    test('status override propagates the upstream status', async () => {
        const api = seam({ baseUrl: 'https://api.test' });
        const app = new Hono<StitchEnv>();
        app.use(stitch({ seam: api }));
        app.onError(stitchOnError({ status: (e) => e.status ?? 502 }));
        app.get('/boom', async (c) => {
            const data = await c.get('stitch').stitch({
                path: '/missing',
                adapter: jsonAdapter(404, { error: 'not found' }),
            })();
            return c.json(data);
        });

        const res = await app.request('/boom');
        expect(res.status).toBe(404);
        await api.close();
    });

    test('stitchError returns undefined for a non-Stitch error (caller rethrows)', () => {
        expect(stitchError(new Error('plain'))).toBeUndefined();
        const mapped = stitchError(
            Object.assign(new Error('upstream'), {
                name: 'StitchError',
                status: 503,
            }),
            { status: (e) => e.status ?? 502 },
        );
        expect(mapped?.status).toBe(503);
    });
});
