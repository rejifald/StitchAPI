// Set the trace file before importing ../src so the JSONL sink is captured/quiet.
import { stitch } from '../src';
import type { StitchRegistry } from '../src/registry';
import { createServeHandler, serve } from '../src/serve';
import type { ServeHandle } from '../src/serve';
import { sse } from '../src/sse';
import { stubStitch } from '../src/test-stub';
import type { Stitch, StitchEvent } from '../src/types';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';
import { asValidator } from './support/schema';
import { streamOf } from './support/streams';

import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-serve-${process.pid}.jsonl`,
);

interface SseFrame {
    event: string;
    data: { type?: string; value?: unknown; [k: string]: unknown } | undefined;
}
function parseSse(text: string): SseFrame[] {
    return text
        .split('\n\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((block) => {
            const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
            const data = /^data: (.+)$/m.exec(block)?.[1];
            return { event, data: data ? JSON.parse(data) : undefined };
        });
}

let api: MockServer; // the backing API the stitches call
let handle: ServeHandle; // the stitch HTTP front door
let base: string;

beforeAll(async () => {
    api = await startMockServer();
    const getWidget = stitch({
        baseUrl: api.url,
        path: '/widgets/{id}',
        pick: 'data',
        output: asValidator(z.object({ id: z.number() })),
    });
    const ping = stitch({ baseUrl: api.url, path: '/ping' });
    handle = await serve({ getWidget, ping }, { port: 0 });
    base = handle.url;
});
afterAll(async () => {
    await handle.close();
    await api.close();
});
beforeEach(() => {
    api.reset();
});

test('serve binds an ephemeral port and reports it', () => {
    expect(handle.port).toBeGreaterThan(0);
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});

test('GET / lists the registered stitch names', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
        stitches: ['getWidget', 'ping'],
    });
});

test('POST /stitch/:name maps the JSON body to input and returns the result', async () => {
    api.route('GET', '/widgets/7', { body: { data: { id: 7 } } });
    const res = await fetch(`${base}/stitch/getWidget`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: { id: 7 }, query: { expand: 'full' } }),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: 7 }); // unwrapped + validated
    expect(api.calls('/widgets/7')[0]?.query).toEqual({ expand: 'full' });
});

test('Accept: text/event-stream returns the live event stream as SSE', async () => {
    api.route('GET', '/ping', { body: { ok: true } });
    const res = await fetch(`${base}/stitch/ping`, {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        body: '{}',
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const frames = parseSse(await res.text());
    const types = frames.map((f) => f.event);
    expect(types[0]).toBe('start');
    expect(types).toContain('result');
    expect(types.at(-1)).toBe('done');
    expect(frames.find((f) => f.event === 'result')?.data?.['data']).toEqual({
        ok: true,
    });
});

test('SSE start frame scrubs credential headers the caller echoed (serve is unauthenticated)', async () => {
    api.route('GET', '/ping', { body: { ok: true } });
    const res = await fetch(`${base}/stitch/ping`, {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        body: JSON.stringify({
            headers: { authorization: 'Bearer SECRET', 'x-keep': 'ok' },
        }),
    });
    const text = await res.text();
    const start = parseSse(text).find((f) => f.event === 'start');
    const echoed = (
        start?.data?.['input'] as
            { headers?: Record<string, string> } | undefined
    )?.headers;
    expect(echoed?.['authorization']).toBe('[REDACTED]'); // credential scrubbed before it leaves
    expect(echoed?.['x-keep']).toBe('ok'); // non-secret header preserved
    expect(text).not.toContain('Bearer SECRET'); // the secret never rides the wire
});

test('SSE start frame scrubs a secret query param the caller echoed (structured input.query)', async () => {
    api.route('GET', '/ping', { body: { ok: true } });
    const res = await fetch(`${base}/stitch/ping`, {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        body: JSON.stringify({ query: { api_key: 'SQLEAK', page: '2' } }),
    });
    const text = await res.text();
    const start = parseSse(text).find((f) => f.event === 'start');
    const echoed = (
        start?.data?.['input'] as
            { query?: Record<string, unknown> } | undefined
    )?.query;
    expect(echoed?.['api_key']).toBe('[REDACTED]'); // secret query value scrubbed before it leaves
    expect(echoed?.['page']).toBe('2'); // non-secret query param preserved
    expect(text).not.toContain('SQLEAK'); // the secret never rides the wire (url OR structured input)
});

test('SSE start frame deep-redacts a secret in the echoed request body & GraphQL variables (serve is unauthenticated)', async () => {
    api.route('GET', '/ping', { body: { ok: true } });
    const res = await fetch(`${base}/stitch/ping`, {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        // An OAuth password-grant-shaped body + a GraphQL login variable: credentials the caller
        // put in the request input, echoed back in the `start` frame.
        body: JSON.stringify({
            body: { password: 'BODYLEAK', client_secret: 'CSLEAK', keep: 'ok' },
            variables: { password: 'VARLEAK', user: 'alice' },
        }),
    });
    const text = await res.text();
    const start = parseSse(text).find((f) => f.event === 'start');
    const echoed = start?.data?.['input'] as
        | {
              body?: Record<string, unknown>;
              variables?: Record<string, unknown>;
          }
        | undefined;
    expect(echoed?.body?.['password']).toBe('REDACTED'); // secret body field scrubbed before it leaves
    expect(echoed?.body?.['client_secret']).toBe('REDACTED');
    expect(echoed?.body?.['keep']).toBe('ok'); // benign body field preserved
    expect(echoed?.variables?.['password']).toBe('REDACTED'); // secret GraphQL variable scrubbed
    expect(echoed?.variables?.['user']).toBe('alice'); // benign variable preserved
    expect(text).not.toContain('BODYLEAK'); // no body/variable secret rides the wire
    expect(text).not.toContain('CSLEAK');
    expect(text).not.toContain('VARLEAK');
});

test('an unknown stitch is a 404 with a listing message', async () => {
    const res = await fetch(`${base}/stitch/nope`, {
        method: 'POST',
        body: '{}',
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining('unknown stitch "nope"'),
    });
});

// #866: resolution is by the registry's OWN key — `Object.prototype` names are not stitches.
test.each(['constructor', 'toString', '__proto__'])(
    'the inherited key %s is a 404 unknown stitch, not a call',
    async (name) => {
        const res = await fetch(`${base}/stitch/${name}`, {
            method: 'POST',
            body: '{}',
        });
        expect(res.status).toBe(404);
        await expect(res.json()).resolves.toMatchObject({
            error: `unknown stitch "${name}". Available: getWidget, ping`,
        });
    },
);

test('a malformed JSON body is a 400', async () => {
    const res = await fetch(`${base}/stitch/ping`, {
        method: 'POST',
        body: '{ not json',
    });
    expect(res.status).toBe(400);
});

test('the wrong method on a stitch route is a 405', async () => {
    const res = await fetch(`${base}/stitch/ping`, { method: 'GET' });
    expect(res.status).toBe(405);
});

test('an upstream failure surfaces as a non-2xx JSON error', async () => {
    api.route('GET', '/ping', { statuses: [500] });
    const res = await fetch(`${base}/stitch/ping`, {
        method: 'POST',
        body: '{}',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    await expect(res.json()).resolves.toHaveProperty('error');
});

// #867: an unexpected throw in JSON mode escapes the handler to `serve`'s own last-resort 500,
// which echoed `e.message` — the same disclosure the failure body withholds. It follows `disclose`.
describe('serve withholds the message of an unexpected throw unless `disclose` is on', () => {
    const LEAK = 'getaddrinfo ENOTFOUND payments.internal.corp';
    const throws = stubStitch('ignored', {
        events: () => {
            throw new Error(LEAK);
        },
    });
    const run = async (disclose?: boolean): Promise<Response> => {
        const h = await serve(
            { throws },
            disclose === undefined ? { port: 0 } : { port: 0, disclose },
        );
        try {
            return await fetch(`${h.url}/stitch/throws`, {
                method: 'POST',
                body: '{}',
            });
        } finally {
            await h.close();
        }
    };

    test('by default the 500 body is the reason phrase', async () => {
        const res = await run();
        expect(res.status).toBe(500);
        await expect(res.json()).resolves.toEqual({
            error: 'Internal Server Error',
        });
    });

    test('`disclose: true` sends the raw message', async () => {
        const res = await run(true);
        expect(res.status).toBe(500);
        await expect(res.json()).resolves.toEqual({ error: LEAK });
    });
});

// #867: the SSE stream is the other door a failure's text leaves by. With `retry` on, each retried
// attempt's `progress.detail` is the raw transport error; a strategy's `info.detail` is free text;
// a `drift` finding's `detail` is a validator's issue message, which can echo the received value;
// and the `start` frame names the upstream URL and its route template. All of it follows `disclose`, like the `error`
// frame. The frames and their types stay either way.
describe('serve SSE withholds the trace fields that name the upstream unless `disclose` is on', () => {
    const HOST = 'payments.internal.corp';
    const LEAK = `getaddrinfo ENOTFOUND ${HOST}`;
    const SECRET = 'UPSTREAM-SECRET-VALUE-42';
    // A validator whose issue message echoes the value it received (valibot does, and so does
    // zod for an enum), so the hard `drift` finding's `detail` carries upstream data.
    const echoing = {
        '~standard': {
            version: 1 as const,
            vendor: 'test',
            validate: (v: unknown) => ({
                issues: [
                    {
                        message: `expected number, received ${String((v as { id: unknown }).id)}`,
                        path: ['id'],
                    },
                ],
            }),
        },
    };
    const registry = {
        // A templated route, retried once on a 503: `start.template` names the upstream route, and
        // the retry's `progress` frame carries a `status` and (for a throw) an `errorType`.
        // Named, because an unnamed stitch's event `name` defaults to its `path`.
        routed: stitch({
            name: 'ledger-read',
            baseUrl: 'https://upstream.test',
            path: '/internal/ledger/{id}',
            adapter: () =>
                Promise.resolve({ status: 503, headers: {}, body: {} }),
            retry: { attempts: 2, backoff: { curve: 'fixed', base: 1 } },
        }),
        // A response the output schema rejects: a hard `drift` finding whose `detail` echoes it.
        drifts: stitch({
            url: `https://${HOST}/x`,
            adapter: () =>
                Promise.resolve({
                    status: 200,
                    headers: {},
                    body: { id: SECRET },
                }),
            output: asValidator(echoing),
        }),
        // A soft finding with every field set: only `detail` is withheld.
        softDrift: stubStitch('ok', {
            events: () => [
                {
                    type: 'drift',
                    finding: {
                        level: 'warn',
                        path: 'items[].id',
                        change: 'coerced',
                        detail: `all 2 elements: string -> number (${SECRET})`,
                        sample: 'items[3].id',
                    },
                    at: 1,
                },
            ],
        }),
        // A transport that throws, retried once: `progress.detail` carries the raw error text.
        flaky: stitch({
            url: `https://${HOST}/x`,
            adapter: () => Promise.reject(new Error(LEAK)),
            retry: { attempts: 2, backoff: { curve: 'fixed', base: 1 } },
        }),
        // A strategy announcement whose free-text detail names an internal host.
        announces: stubStitch('ok', {
            events: () => [
                {
                    type: 'info',
                    topic: 'auth.refresh',
                    detail: `refreshing against ${HOST}`,
                    at: 1,
                },
            ],
        }),
    };
    const stream = async (
        name: keyof typeof registry,
        disclose?: boolean,
        input = '{}',
    ): Promise<string> => {
        const h = await serve(
            registry,
            disclose === undefined ? { port: 0 } : { port: 0, disclose },
        );
        try {
            const res = await fetch(`${h.url}/stitch/${name}?stream=1`, {
                method: 'POST',
                body: input,
            });
            return await res.text();
        } finally {
            await h.close();
        }
    };

    test('by default the stream carries neither the host nor the transport error text', async () => {
        const body = await stream('flaky');
        expect(body).not.toContain('ENOTFOUND');
        expect(body).not.toContain(HOST);
        // The frames stay; only the fields that name the upstream are dropped.
        expect(body).toContain('event: start');
        expect(body).toContain('event: progress');
        expect(body).toContain('"phase":"retry"');
        expect(body).toContain('event: error');
        expect(body).toContain('"message":"Bad Gateway"');
    });

    test('by default an `info` frame keeps its topic and drops its detail', async () => {
        const body = await stream('announces');
        expect(body).toContain('event: info');
        expect(body).toContain('"topic":"auth.refresh"');
        expect(body).not.toContain(HOST);
        expect(body).not.toContain('"detail"');
    });

    // Splits the stream into frames and returns the parsed `data` of every frame of one type.
    const framesOf = (body: string, type: string): Record<string, unknown>[] =>
        body
            .split('\n\n')
            .filter((block) => block.startsWith(`event: ${type}\n`))
            .map(
                (block) =>
                    JSON.parse(block.split('\ndata: ')[1] ?? '{}') as Record<
                        string,
                        unknown
                    >,
            );

    test('by default `start` drops the route template and keeps what the engine stamps', async () => {
        const body = await stream('routed', undefined, '{"params":{"id":7}}');
        expect(body).not.toContain('/internal/ledger');
        const [start] = framesOf(body, 'start');
        expect(start).toEqual(
            expect.objectContaining({
                surface: 'http',
                transport: 'http',
                spanId: expect.any(String),
            }),
        );
        expect(start).not.toHaveProperty('url');
        expect(start).not.toHaveProperty('template');
        // The retry's `progress` frame keeps its `status` and drops only `detail`.
        expect(framesOf(body, 'progress')).toContainEqual(
            expect.objectContaining({ phase: 'retry', status: 503 }),
        );
    });

    test('`disclose: true` sends the route template', async () => {
        const body = await stream('routed', true, '{"params":{"id":7}}');
        expect(framesOf(body, 'start')[0]).toEqual(
            expect.objectContaining({ template: '/internal/ledger/{id}' }),
        );
    });

    test('by default a `drift` finding keeps its level, path and change and drops its detail', async () => {
        const body = await stream('drifts');
        expect(body).not.toContain(SECRET);
        expect(framesOf(body, 'drift')).toEqual([
            expect.objectContaining({
                type: 'drift',
                finding: { level: 'error', path: 'id', change: 'invalid' },
            }),
        ]);
    });

    test('by default a soft `drift` finding keeps every field but `detail`', async () => {
        const body = await stream('softDrift');
        expect(body).not.toContain(SECRET);
        expect(framesOf(body, 'drift')).toEqual([
            expect.objectContaining({
                finding: {
                    level: 'warn',
                    path: 'items[].id',
                    change: 'coerced',
                    sample: 'items[3].id',
                },
            }),
        ]);
    });

    test('`disclose: true` sends the `drift` detail with the echoed upstream value', async () => {
        const body = await stream('drifts', true);
        expect(framesOf(body, 'drift')).toEqual([
            expect.objectContaining({
                finding: {
                    level: 'error',
                    path: 'id',
                    change: 'invalid',
                    detail: `expected number, received ${SECRET}`,
                },
            }),
        ]);
    });

    test('`disclose: true` sends the upstream url, the retry detail and the raw message', async () => {
        const body = await stream('flaky', true);
        expect(body).toContain(`"url":"https://${HOST}/x"`);
        expect(body).toContain(`"detail":"${LEAK}"`);
        expect(body).toContain(`"message":"${LEAK}"`);

        const info = await stream('announces', true);
        expect(info).toContain(`"detail":"refreshing against ${HOST}"`);
    });
});

describe('serve forwards a streaming surface as `event: delta` SSE frames', () => {
    let streamHandle: ServeHandle;
    beforeAll(async () => {
        // An sse() stitch whose adapter streams two token frames. serve forwards EVERY engine
        // event as SSE, so each `delta` rides out as its own `event: delta` frame for free.
        const tokens = sse({
            url: 'https://x.test/llm',
            adapter: (req) => {
                if (!req.stream)
                    throw new Error('expected a streaming request');
                return Promise.resolve({
                    status: 200,
                    headers: {},
                    body: streamOf([
                        'data: {"tok":"he"}\n\n',
                        'data: {"tok":"llo"}\n\n',
                    ]),
                });
            },
        });
        streamHandle = await serve({ tokens }, { port: 0 });
    });
    afterAll(async () => {
        await streamHandle.close();
    });

    test('each delta chunk arrives as a separate event: delta frame, then done', async () => {
        const res = await fetch(`${streamHandle.url}/stitch/tokens`, {
            method: 'POST',
            headers: { accept: 'text/event-stream' },
            body: '{}',
        });
        expect(res.headers.get('content-type')).toContain('text/event-stream');

        const frames = parseSse(await res.text());
        const deltas = frames.filter((f) => f.event === 'delta');
        expect(deltas.map((f) => f.data?.['chunk'])).toEqual([
            { data: { tok: 'he' } },
            { data: { tok: 'llo' } },
        ]);
        expect(frames[0]?.event).toBe('start');
        expect(frames.at(-1)?.event).toBe('done');
    });
});

describe('serve caps the request body (413), so an unauthenticated server cannot be OOM-ed', () => {
    // A dedicated server with a tiny cap: we can prove the bound with a small body instead of
    // shipping megabytes, and the assertion is that it *rejects* — not that a giant body OOMs.
    const CAP = 64;
    let capped: ServeHandle;
    beforeAll(async () => {
        const ping = stitch({ baseUrl: api.url, path: '/ping' });
        capped = await serve({ ping }, { port: 0, body: CAP });
    });
    afterAll(async () => {
        await capped.close();
    });

    test('a body over the cap is rejected with 413 (streamed, no Content-Length)', async () => {
        api.route('GET', '/ping', { body: { ok: true } });
        // A body well past the cap, streamed in fixed chunks — bounded, but sent WITHOUT a
        // Content-Length header (a stream body forces chunked transfer). This exercises the
        // mid-stream byte-accumulation guard specifically, not just the up-front header check.
        // Before the fix `readBody` buffered every chunk and answered 200; after the fix the
        // accumulator trips the cap mid-stream, the socket is destroyed, and the handler maps
        // the size error to 413.
        let sent = 0;
        const res = await fetch(`${capped.url}/stitch/ping`, {
            method: 'POST',
            body: new ReadableStream({
                pull(controller) {
                    if (sent >= CAP * 4) {
                        controller.close();
                        return;
                    }
                    sent += 16;
                    controller.enqueue(
                        new TextEncoder().encode('x'.repeat(16)),
                    );
                },
            }),
            // @ts-expect-error `duplex` is required by Node's fetch for a stream body.
            duplex: 'half',
        }).catch((e: unknown) => e as Error);
        // Either the server answered 413, or it destroyed the socket mid-upload (a client-visible
        // network error) — both are the cap doing its job (refusing to buffer unbounded). What it
        // must never be is a 200 (which is what the unbounded pre-fix `readBody` returned). The
        // 413 body + `exceeds` message is asserted deterministically by the Content-Length test below.
        const refused = res instanceof Error || res.status === 413;
        expect(refused).toBe(true);
    });

    test('a truthful Content-Length over the cap is rejected up front with 413', async () => {
        api.route('GET', '/ping', { body: { ok: true } });
        const res = await fetch(`${capped.url}/stitch/ping`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // JSON longer than CAP bytes; fetch sets an honest Content-Length.
            body: JSON.stringify({ query: { pad: 'y'.repeat(CAP) } }),
        });
        expect(res.status).toBe(413);
        await expect(res.json()).resolves.toMatchObject({
            error: expect.stringContaining('exceeds'),
        });
    });

    test('a body within the cap still succeeds (the server survived the rejections)', async () => {
        api.route('GET', '/ping', { body: { ok: true } });
        const res = await fetch(`${capped.url}/stitch/ping`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}), // 2 bytes, well under the cap
        });
        expect(res.status).toBe(200);
        await expect(res.json()).resolves.toEqual({ ok: true });
    });
});

describe('the body cap also accepts a size token (`size.parse`)', () => {
    // `'1kb'` must resolve to 1024 bytes. The probe body is ~1.1 KB — over a parsed `'1kb'`
    // but far under the 2 MiB default, so a 413 here can only mean the token was honoured
    // (an ignored/unparsed token would fall back to the default and answer 200).
    let capped: ServeHandle;
    beforeAll(async () => {
        const ping = stitch({ baseUrl: api.url, path: '/ping' });
        capped = await serve({ ping }, { port: 0, body: { max: '1kb' } });
    });
    afterAll(async () => {
        await capped.close();
    });

    test('a body over the token cap is rejected with 413', async () => {
        api.route('GET', '/ping', { body: { ok: true } });
        const res = await fetch(`${capped.url}/stitch/ping`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: { pad: 'y'.repeat(1100) } }),
        });
        expect(res.status).toBe(413);
        await expect(res.json()).resolves.toMatchObject({
            error: expect.stringContaining('1024'), // the parsed cap, in bytes
        });
    });

    test('a body under the token cap still succeeds', async () => {
        api.route('GET', '/ping', { body: { ok: true } });
        const res = await fetch(`${capped.url}/stitch/ping`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: { pad: 'y'.repeat(100) } }),
        });
        expect(res.status).toBe(200);
    });
});

// A fake `req`/`res` pair for driving `createServeHandler` without a socket, so a client
// disconnect can be simulated deterministically by emitting 'close'.
function fakeReqRes(body: string, headers: Record<string, string>) {
    // `writableEnded`/`destroyed` are read-only on the real `ServerResponse`, so we type the fake
    // as a loose mutable record and cast to the Node types only at the boundary.
    const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        url: '/stitch/infinite',
        headers,
        setEncoding: () => req, // no-op; body is fed as a Buffer below
        destroy: () => req,
    });
    const res = Object.assign(new EventEmitter(), {
        writableEnded: false,
        destroyed: false,
        writeHead: () => res,
        write: () => true, // a live socket; the loop must stop by other means, not a throw
        end: () => {
            res.writableEnded = true;
            return res;
        },
    });

    // Feed the request body on next tick, as a real socket would.
    queueMicrotask(() => {
        req.emit('data', Buffer.from(body, 'utf8'));
        req.emit('end');
    });
    return {
        req: req as unknown as IncomingMessage,
        res: res as unknown as ServerResponse,
        closeClient: () => {
            res.destroyed = true;
            req.emit('close');
            res.emit('close');
        },
    };
}

describe('serve tears down an SSE stream when the client disconnects (no runaway upstream)', () => {
    test('a client disconnect aborts the run signal and runs the source generator’s finally', async () => {
        let returned = false; // did the generator's finally run (i.e. iterator.return())?
        let seenSignal: AbortSignal | undefined; // the signal serve threaded into the run
        let emitted = 0; // how many events the generator yielded before teardown

        // A fake stitch whose .stream() is an INFINITE generator: `res.write` on a live socket
        // never throws, so before the fix this loop would run forever after the client left. The
        // finally records that `.return()` ran; the signal is captured so we can assert the abort.
        // It awaits a macrotask between yields (as a real I/O-backed stream does) so the loop
        // yields to timers — otherwise a tight synchronous `await` loop would starve setTimeout.
        const infinite: Stitch = {
            stream: async function* (input?: { signal?: AbortSignal }) {
                seenSignal = input?.signal;
                try {
                    for (let i = 0; ; i++) {
                        emitted++;
                        yield {
                            type: 'delta',
                            chunk: { n: i },
                            at: 0,
                        } as StitchEvent;
                        await new Promise((r) => setImmediate(r));
                    }
                } finally {
                    returned = true;
                }
            },
        } as unknown as Stitch;

        const registry: StitchRegistry = { infinite };
        const handler = createServeHandler(registry);
        const { req, res, closeClient } = fakeReqRes('{}', {
            accept: 'text/event-stream',
        });

        const done = handler(req, res); // starts streaming; would never resolve without teardown

        // Let a few frames stream, then simulate the client going away.
        await new Promise((r) => setTimeout(r, 10));
        expect(emitted).toBeGreaterThan(0); // proves the stream was live
        expect(seenSignal).toBeInstanceOf(AbortSignal); // serve threaded a cancellation signal
        expect(seenSignal?.aborted).toBe(false);

        closeClient();
        await done; // resolves only because teardown breaks the loop and ends the response

        expect(seenSignal?.aborted).toBe(true); // the run was cancelled on disconnect
        expect(returned).toBe(true); // the generator's finally ran (iterator.return fired)
        const settled = emitted;
        await new Promise((r) => setTimeout(r, 10));
        expect(emitted).toBe(settled); // and it stopped — no runaway production after teardown
    });
});
