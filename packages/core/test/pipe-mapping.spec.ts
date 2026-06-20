// stitchapi/pipe (ADR 0008) — branches pipe.spec.ts leaves open. That suite drives ordered mapping
// with an EXPLICIT `input` mapper, the two-step run-identity chain, and fail-fast. These cover:
//   - the DEFAULT mapping (no `input`): the previous result is passed as the next call's `body`;
//   - the FIRST step receiving the pipe's own initial input;
//   - an EMPTY pipe resolving to undefined;
//   - run identity chaining TRANSITIVELY across three steps (a → b → c).
import { stitch } from '../src';
import type { StitchEvent, TraceContext, TraceSink } from '../src';
import { pipe } from '../src/pipe';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

function capturingSink(): {
    sink: TraceSink;
    seen: { ev: StitchEvent; ctx: TraceContext }[];
} {
    const seen: { ev: StitchEvent; ctx: TraceContext }[] = [];
    return {
        seen,
        sink: { handle: (ev, ctx) => void seen.push({ ev, ctx: { ...ctx } }) },
    };
}

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});

describe('pipe default mapping + initial input', () => {
    test('with no input mapper, the previous result is passed as the next call body', async () => {
        server.route('GET', '/produce', { body: { id: 7 } });
        server.route('POST', '/echo', { body: { ok: true } });
        const produce = stitch({
            name: 'produce',
            baseUrl: server.url,
            path: '/produce',
        });
        const echo = stitch({
            name: 'echo',
            baseUrl: server.url,
            path: '/echo',
            method: 'POST',
            bodyType: 'json',
        });

        // echo has no `input` mapper → it receives `{ body: <produce's result> }`, so the request
        // it sends carries produce's result as the body.
        await expect(pipe(produce, echo)()).resolves.toEqual({ ok: true });
        expect(server.calls('/echo')[0]?.body).toEqual({ id: 7 });
    });

    test('the first step receives the pipe’s initial input', async () => {
        server.route('POST', '/echo', { body: { ok: true } });
        const echo = stitch({
            name: 'echo',
            baseUrl: server.url,
            path: '/echo',
            method: 'POST',
            bodyType: 'json',
        });

        await pipe(echo)({ body: { hi: 1 } });
        expect(server.calls('/echo')[0]?.body).toEqual({ hi: 1 });
    });

    test('an empty pipe resolves to undefined', async () => {
        await expect(pipe()()).resolves.toBeUndefined();
    });
});

describe('pipe run identity chains transitively', () => {
    test('across three steps, each is a child of the one before it', async () => {
        server.route('GET', '/a', { body: { n: 1 } });
        server.route('GET', '/b', { body: { n: 2 } });
        server.route('GET', '/c', { body: { n: 3 } });
        const { sink, seen } = capturingSink();
        const mk = (name: string, path: string) =>
            stitch({ name, baseUrl: server.url, path, trace: sink });

        await pipe(mk('a', '/a'), mk('b', '/b'), mk('c', '/c'))();

        const start = (name: string) =>
            seen.find((s) => s.ctx.name === name && s.ev.type === 'start')!;
        const a = start('a');
        const b = start('b');
        const c = start('c');
        expect(a.ctx.parentId).toBeUndefined(); // root
        expect(b.ctx.parentId).toBe(a.ctx.runId); // b ← a
        expect(c.ctx.parentId).toBe(b.ctx.runId); // c ← b (transitive)
        expect(
            new Set([a.ctx.traceId, b.ctx.traceId, c.ctx.traceId]).size,
        ).toBe(1); // one trace tree
    });
});
