// Behavioural tests for @stitchapi/express, fully offline and dependency-free at runtime: instead of
// supertest we hand-build minimal mock `req`/`res` objects and call the middleware/handler/error
// middleware directly. The seam is built with a FAKE `adapter` (no network). Asserts the three public
// contracts: `stitch()` sets `req.stitch` (root + principal-bound), `streamStitchSse` writes the
// right SSE frames for a fake stream (delta / error / disconnect teardown), and `stitchErrorHandler`
// maps a StitchError to 502 (and `next(err)`s everything else).
import {
    currentStitch,
    isStitchError,
    stitch,
    stitchErrorHandler,
    streamStitchSse,
} from '../src';

import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { isSeam, seam } from 'stitchapi';
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
    StitchEvent,
} from 'stitchapi';
import { describe, expect, test } from 'vitest';

// A fake adapter: return a canned response for any request, recording what it saw.
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

// Minimal Express-ish request: just the fields the middleware/helpers touch, plus an EventEmitter so
// `req.on('close')` works for the SSE disconnect path. Cast to Request at the call site.
function mockReq(headers: Record<string, string> = {}): Request & EventEmitter {
    const req = new EventEmitter() as EventEmitter & {
        headers: Record<string, string>;
        stitch?: unknown;
    };
    req.headers = headers;
    return req as unknown as Request & EventEmitter;
}

// Minimal Express-ish response: an EventEmitter (for `res.on('close')`) that records every write so
// the SSE body can be asserted, and that fakes the `status().json()` chain + `writeHead`/`flushHeaders`.
interface MockRes extends EventEmitter {
    locals: Record<string, unknown>;
    headersSent: boolean;
    statusCode: number;
    headers: Record<string, unknown>;
    written: string[];
    ended: boolean;
    jsonBody: unknown;
    writeHead(code: number, headers?: Record<string, unknown>): MockRes;
    flushHeaders(): void;
    write(chunk: string): boolean;
    end(): void;
    status(code: number): MockRes;
    json(body: unknown): MockRes;
    body(): string;
}

function mockRes(): MockRes {
    const res = new EventEmitter() as MockRes;
    res.locals = {};
    res.headersSent = false;
    res.statusCode = 200;
    res.headers = {};
    res.written = [];
    res.ended = false;
    res.jsonBody = undefined;
    res.writeHead = (code, headers = {}) => {
        res.statusCode = code;
        res.headers = { ...res.headers, ...headers };
        res.headersSent = true;
        return res;
    };
    res.flushHeaders = () => {
        res.headersSent = true;
    };
    res.write = (chunk: string) => {
        res.written.push(chunk);
        return true;
    };
    res.end = () => {
        res.ended = true;
        res.emit('close');
    };
    res.status = (code: number) => {
        res.statusCode = code;
        return res;
    };
    res.json = (b: unknown) => {
        res.jsonBody = b;
        return res;
    };
    res.body = () => res.written.join('');
    return res;
}

describe('stitch() middleware puts a seam on req', () => {
    test('sets req.stitch + res.locals.stitch to the root seam and calls next', async () => {
        const { adapter } = fakeAdapter(() => ({
            status: 200,
            headers: {},
            body: { id: 'u1' },
        }));
        const api = seam({ baseUrl: 'https://api.test', adapter });
        const req = mockReq();
        const res = mockRes();
        let nexted = false;

        stitch({ seam: api })(req, res as unknown as Response, () => {
            nexted = true;
        });

        expect(nexted).toBe(true);
        expect(isSeam(req.stitch)).toBe(true);
        // res.locals mirrors the same handle, and currentStitch reads it back.
        expect(res.locals['stitch']).toBe(req.stitch);
        expect(currentStitch(req)).toBe(req.stitch);
        // The handle can build a member that resolves against the fake adapter.
        const me = req.stitch.stitch<{ id: string }>({ path: '/me' });
        await expect(me()).resolves.toEqual({ id: 'u1' });
        await api.close();
    });

    test('binds a request-scoped principal — a lifecycle-free PrincipalSeam', async () => {
        const api = seam({ baseUrl: 'https://api.test' });
        const mw = stitch({
            seam: api,
            principal: (r) => (r.headers['x-user'] as string) || undefined,
        });

        // With a principal header → a bound handle that lacks the root-only `close` lever (ADR 0002).
        const reqA = mockReq({ 'x-user': 'alice' });
        mw(reqA, mockRes() as unknown as Response, () => undefined);
        expect('close' in reqA.stitch).toBe(false);
        expect(reqA.stitch).not.toBe(api);

        // Without it → the root seam (has `close`), proving the binding is request-scoped.
        const reqB = mockReq();
        mw(reqB, mockRes() as unknown as Response, () => undefined);
        expect(reqB.stitch).toBe(api);
        await api.close();
    });

    test('currentStitch throws when the middleware did not run', () => {
        expect(() => currentStitch(mockReq())).toThrow(
            /req\.stitch is not set/,
        );
    });
});

describe('streamStitchSse writes SSE frames to res', () => {
    test('only delta events become data: frames; control events are not forwarded', async () => {
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
            yield { type: 'done', ok: true, ms: 1, attempts: 1, at: 3 };
        }
        const res = mockRes();
        await streamStitchSse(res as unknown as Response, events());

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('text/event-stream');
        expect(res.body()).toBe('data: hello\n\ndata: world\n\n');
        expect(res.ended).toBe(true);
    });

    test('an error event ends the stream with a named event: error frame', async () => {
        async function* events(): AsyncGenerator<StitchEvent<unknown>> {
            yield { type: 'delta', chunk: 'partial', at: 1 };
            yield {
                type: 'error',
                name: 'StitchError',
                message: 'upstream blew up',
                attempts: 1,
                at: 2,
            };
            // Never reached: the helper stops on `error`.
            yield { type: 'delta', chunk: 'unreachable', at: 3 };
        }
        const res = mockRes();
        await streamStitchSse(res as unknown as Response, events());

        expect(res.body()).toBe(
            'data: partial\n\nevent: error\ndata: upstream blew up\n\n',
        );
    });

    test('the data mapper + named event shape each delta frame', async () => {
        async function* events(): AsyncGenerator<StitchEvent<unknown>> {
            yield { type: 'delta', chunk: { text: 'a' }, at: 1 };
            yield { type: 'delta', chunk: { text: 'b' }, at: 2 };
        }
        const res = mockRes();
        await streamStitchSse(res as unknown as Response, events(), {
            event: 'token',
            data: (c) => (c as { text: string }).text,
        });
        expect(res.body()).toBe(
            'event: token\ndata: a\n\nevent: token\ndata: b\n\n',
        );
    });

    test('a client disconnect aborts the upstream iterator (iterator.return is called)', async () => {
        let returned = false;
        // A stream that blocks after the first delta until torn down — exactly the shape of a real
        // stitch `.stream()` generator: an in-flight `next()` only settles when `return()` is called,
        // so this verifies the disconnect path resolves the hanging read rather than leaking it.
        const source: AsyncIterable<StitchEvent<unknown>> = {
            [Symbol.asyncIterator]() {
                let sentFirst = false;
                let resolvePending:
                    | ((r: IteratorResult<StitchEvent<unknown>>) => void)
                    | undefined;
                return {
                    next() {
                        if (!sentFirst) {
                            sentFirst = true;
                            return Promise.resolve({
                                value: { type: 'delta', chunk: 'one', at: 1 },
                                done: false,
                            });
                        }
                        // Hang until `return()` settles the consumer's pending `next()`.
                        return new Promise((resolve) => {
                            resolvePending = resolve;
                        });
                    },
                    return() {
                        returned = true;
                        // A real generator's pending `next()` resolves `{ done: true }` on return().
                        resolvePending?.({ value: undefined, done: true });
                        return Promise.resolve({
                            value: undefined,
                            done: true,
                        });
                    },
                };
            },
        };

        const res = mockRes();
        const req = mockReq();
        const done = streamStitchSse(res as unknown as Response, source, {
            req,
        });
        // Let the first delta flush, then simulate the client dropping the connection.
        await Promise.resolve();
        await Promise.resolve();
        res.emit('close');
        await done;

        expect(returned).toBe(true);
        expect(res.body()).toBe('data: one\n\n');
    });
});

describe('stitchErrorHandler maps a StitchError to HTTP', () => {
    test('maps a StitchError to 502 by default and does not leak the upstream status', () => {
        const err = Object.assign(new Error('down'), {
            name: 'StitchError',
            status: 503,
        });
        const res = mockRes();
        let nextedWith: unknown = 'untouched';
        stitchErrorHandler()(
            err,
            mockReq() as unknown as Request,
            res as unknown as Response,
            (e?: unknown) => {
                nextedWith = e;
            },
        );

        expect(res.statusCode).toBe(502); // gateway default — upstream 503 is not leaked
        expect(res.jsonBody).toEqual({ error: 'down' });
        expect(nextedWith).toBe('untouched'); // mapped, so next() was not called
    });

    test('can propagate the upstream status', () => {
        const err = Object.assign(new Error('limited'), {
            name: 'StitchError',
            status: 429,
        });
        const res = mockRes();
        stitchErrorHandler({ status: (e) => e.status ?? 502 })(
            err,
            mockReq() as unknown as Request,
            res as unknown as Response,
            () => undefined,
        );
        expect(res.statusCode).toBe(429);
    });

    test('passes a non-stitch error to next(err) untouched', () => {
        const plain = new Error('not a stitch error');
        const res = mockRes();
        let nextedWith: unknown;
        stitchErrorHandler()(
            plain,
            mockReq() as unknown as Request,
            res as unknown as Response,
            (e?: unknown) => {
                nextedWith = e;
            },
        );
        expect(nextedWith).toBe(plain);
        expect(res.jsonBody).toBeUndefined(); // not handled here
    });

    test('isStitchError discriminates by name', () => {
        expect(
            isStitchError(
                Object.assign(new Error('x'), { name: 'StitchError' }),
            ),
        ).toBe(true);
        expect(isStitchError(new Error('plain'))).toBe(false);
        expect(isStitchError('nope')).toBe(false);
    });
});
