// Set the trace file before importing ../src so the JSONL sink is captured/quiet.
import { stitch } from '../src';
import { serve } from '../src/serve';
import type { ServeHandle } from '../src/serve';
import { sse } from '../src/sse';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';
import { asValidator } from './support/schema';
import { streamOf } from './support/streams';

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
        unwrap: 'data',
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
    expect(frames.find((f) => f.event === 'result')?.data?.value).toEqual({
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
            | { headers?: Record<string, string> }
            | undefined
    )?.headers;
    expect(echoed?.['authorization']).toBe('[REDACTED]'); // credential scrubbed before it leaves
    expect(echoed?.['x-keep']).toBe('ok'); // non-secret header preserved
    expect(text).not.toContain('Bearer SECRET'); // the secret never rides the wire
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
