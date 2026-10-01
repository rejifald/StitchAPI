// Drive createServeHandler (src/serve.ts) DIRECTLY with fake req/res — it is explicitly exposed for
// this. serve.spec.ts covers the happy paths over real HTTP; these pin branches it leaves open:
//   - GET /stitch and /stitch/ also list the registry (aliases of GET /);
//   - an unmatched path is a GENERIC not_found 404 (distinct from the stitch-listing 404);
//   - SSE is triggered by `?stream=1`, not only the Accept header;
//   - runJson clamps a sub-400 / missing error status to 502, and returns null when no result event;
//   - a populated registry lists its names sorted.
import type { StitchRegistry } from '../src/registry';
import { RateLimitError } from '../src/resilience';
import { createServeHandler } from '../src/serve';
import { failStitch, stubStitch } from '../src/test-stub';

import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

// An EventEmitter so the handler can register its client-disconnect 'close' listeners on it (the
// SSE-teardown path calls `res.on('close', …)` / `res.off(…)` and reads `writableEnded`/`destroyed`).
class FakeRes extends EventEmitter {
    statusCode = 0;
    headers: Record<string, string | string[]> = {};
    writableEnded = false;
    destroyed = false;
    private chunks: string[] = [];
    writeHead(status: number, headers?: Record<string, string>): this {
        this.statusCode = status;
        if (headers) Object.assign(this.headers, headers);
        return this;
    }
    write(chunk: string): boolean {
        this.chunks.push(chunk);
        return true;
    }
    end(chunk?: string): this {
        if (chunk !== undefined) this.chunks.push(chunk);
        this.writableEnded = true;
        return this;
    }
    get body(): string {
        return this.chunks.join('');
    }
}

const makeReq = (o: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
}): IncomingMessage => {
    const r = Readable.from([o.body ?? '']) as unknown as IncomingMessage;
    r.method = o.method;
    r.url = o.url;
    r.headers = o.headers ?? {};
    return r;
};

async function call(
    registry: StitchRegistry,
    reqOpts: Parameters<typeof makeReq>[0],
    options?: Parameters<typeof createServeHandler>[1],
): Promise<FakeRes> {
    const res = new FakeRes();
    await createServeHandler(registry, options)(
        makeReq(reqOpts),
        res as unknown as ServerResponse,
    );
    return res;
}

const reg = (): StitchRegistry => ({
    ping: stubStitch('OK'),
    boom: failStitch('kaboom'),
});

describe('createServeHandler routing', () => {
    test('GET /stitch and /stitch/ list the registry (aliases of /)', async () => {
        for (const url of ['/stitch', '/stitch/']) {
            const res = await call(reg(), { method: 'GET', url });
            expect(res.statusCode).toBe(200);
            expect(JSON.parse(res.body)).toEqual({
                stitches: ['boom', 'ping'],
            });
        }
    });

    test('an unmatched path is a generic not_found 404', async () => {
        const res = await call(reg(), { method: 'GET', url: '/nope' });
        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    });
});

describe('createServeHandler SSE + JSON outcomes', () => {
    test('?stream=1 forces SSE without an Accept header', async () => {
        const res = await call(reg(), {
            method: 'POST',
            url: '/stitch/ping?stream=1',
            body: '{}',
        });
        expect(res.headers['content-type']).toBe('text/event-stream');
        expect(res.body).toContain('event: result');
        expect(res.body).toContain('OK');
    });

    test('a result is returned as JSON for a non-SSE call', async () => {
        const res = await call(reg(), {
            method: 'POST',
            url: '/stitch/ping',
            body: '{}',
        });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toBe('OK');
    });

    test('a failure with no status clamps to 502', async () => {
        const res = await call(reg(), {
            method: 'POST',
            url: '/stitch/boom',
            body: '{}',
        });
        expect(res.statusCode).toBe(502);
        // The reason phrase for the status, not the failure's own message (#867).
        expect(JSON.parse(res.body)).toEqual({ error: 'Bad Gateway' });
    });

    test('a run with no result event returns null', async () => {
        const registry: StitchRegistry = {
            quiet: stubStitch('ignored', {
                events: () => [
                    {
                        type: 'start',
                        name: 'quiet',
                        method: 'GET',
                        url: '',
                        input: {},
                        at: 1,
                    },
                    { type: 'done', ok: true, elapsed: 0, attempts: 1, at: 1 },
                ],
            }),
        };
        const res = await call(registry, {
            method: 'POST',
            url: '/stitch/quiet',
            body: '{}',
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe('null');
    });
});

// #867: serve answered a failure with `{ error: failure.message }` — the raw upstream message the
// six host adapters withhold by default. It now answers with the status's reason phrase unless
// `disclose` is on, on every path a failure reaches the caller.
describe('createServeHandler withholds a failure message unless `disclose` is on', () => {
    const LEAK = 'getaddrinfo ENOTFOUND payments.internal.corp';
    const leaky = (): StitchRegistry => ({
        down: failStitch(LEAK),
        unauthorized: failStitch({ status: 401, message: 'HTTP 401' }),
        // A stream that throws instead of yielding an `error` event (the SSE catch frame).
        throws: stubStitch('ignored', {
            events: () => {
                throw new Error(LEAK);
            },
        }),
    });
    const post = (name: string, sse = false) => ({
        method: 'POST',
        url: `/stitch/${name}${sse ? '?stream=1' : ''}`,
        body: '{}',
    });

    test('JSON: the body carries the reason phrase for the response status', async () => {
        const down = await call(leaky(), post('down'));
        expect(down.statusCode).toBe(502);
        expect(JSON.parse(down.body)).toEqual({ error: 'Bad Gateway' });
        expect(down.body).not.toContain('ENOTFOUND');

        // The status mapping is unchanged (#707): a 401 still passes through, with its phrase.
        const unauthorized = await call(leaky(), post('unauthorized'));
        expect(unauthorized.statusCode).toBe(401);
        expect(JSON.parse(unauthorized.body)).toEqual({
            error: 'Unauthorized',
            status: 401,
        });
    });

    test('JSON: `disclose: true` sends the raw message', async () => {
        const res = await call(leaky(), post('down'), { disclose: true });
        expect(res.statusCode).toBe(502);
        expect(JSON.parse(res.body)).toEqual({ error: LEAK });
    });

    test('SSE: the `error` frame carries the reason phrase, not the message', async () => {
        const res = await call(leaky(), post('down', true));
        expect(res.body).toContain('event: error');
        expect(res.body).toContain('"message":"Bad Gateway"');
        expect(res.body).not.toContain('ENOTFOUND');

        const disclosed = await call(leaky(), post('down', true), {
            disclose: true,
        });
        expect(disclosed.body).toContain(LEAK);
    });

    test('SSE: the catch frame for a thrown stream is generic too', async () => {
        const res = await call(leaky(), post('throws', true));
        expect(res.body).toBe(
            'event: error\ndata: {"message":"Internal Server Error"}\n\n',
        );

        const disclosed = await call(leaky(), post('throws', true), {
            disclose: true,
        });
        expect(disclosed.body).toContain(LEAK);
    });
});

describe('createServeHandler sends Retry-After for a delegate-backoff RateLimitError', () => {
    const limited = (retryAfter?: number): StitchRegistry => ({
        limited: failStitch(
            new RateLimitError({
                status: 429,
                retryAfter,
                response: { status: 429, headers: {}, body: null },
                message: 'quota exceeded for tenant acme',
            }),
        ),
    });
    const post = { method: 'POST', url: '/stitch/limited', body: '{}' };

    test('the parsed `retryAfter` (ms) becomes a Retry-After header in whole seconds', async () => {
        const res = await call(limited(1500), post);
        expect(res.statusCode).toBe(429);
        expect(res.headers['retry-after']).toBe('2');
        expect(JSON.parse(res.body)).toEqual({
            error: 'Too Many Requests',
            status: 429,
        });
    });

    test('no header when the upstream sent no usable Retry-After', async () => {
        const res = await call(limited(undefined), post);
        expect(res.statusCode).toBe(429);
        expect(res.headers['retry-after']).toBeUndefined();
    });

    // A 22-digit upstream value parses to 1e24 ms; `String(1e21)` would send the invalid `1e+21`.
    test('a huge value is clamped to a day, so the header stays valid delta-seconds', async () => {
        const res = await call(limited(1e24), post);
        expect(res.statusCode).toBe(429);
        expect(res.headers['retry-after']).toBe('86400');
        expect(res.headers['retry-after']).toMatch(/^\d+$/);
    });

    test('a non-finite value sends no header', async () => {
        for (const value of [Infinity, NaN]) {
            const res = await call(limited(value), post);
            expect(res.statusCode).toBe(429);
            expect(res.headers['retry-after']).toBeUndefined();
        }
    });
});
