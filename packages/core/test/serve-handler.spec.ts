// Drive createServeHandler (src/serve.ts) DIRECTLY with fake req/res — it is explicitly exposed for
// this. serve.spec.ts covers the happy paths over real HTTP; these pin branches it leaves open:
//   - GET /stitch and /stitch/ also list the registry (aliases of GET /);
//   - an unmatched path is a GENERIC not_found 404 (distinct from the stitch-listing 404);
//   - SSE is triggered by `?stream=1`, not only the Accept header;
//   - runJson clamps a sub-400 / missing error status to 502, and returns null when no result event;
//   - a populated registry lists its names sorted.
import type { StitchRegistry } from '../src/registry';
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
): Promise<FakeRes> {
    const res = new FakeRes();
    await createServeHandler(registry)(
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
        expect((JSON.parse(res.body) as { error: string }).error).toBe(
            'kaboom',
        );
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
