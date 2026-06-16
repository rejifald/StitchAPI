// stitchapi/pipe — linear composition (ADR 0008 Stage D). Steps run in order, each result feeds the
// next, and each step is a CHILD run of the previous (ADR 0007) so a shared trace links the chain.
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

test('runs steps in order, mapping each result into the next, and resolves to the last', async () => {
    server.route('GET', '/user', { body: { id: 7 } });
    server.route('GET', '/posts', { body: { posts: ['p1'] } });
    const fetchUser = stitch({
        name: 'user',
        baseUrl: server.url,
        path: '/user',
    });
    const fetchPosts = stitch({
        name: 'posts',
        baseUrl: server.url,
        path: '/posts',
    });

    const flow = pipe(fetchUser, {
        stitch: fetchPosts,
        input: (u) => ({ query: { userId: String((u as { id: number }).id) } }),
    });

    await expect(flow()).resolves.toEqual({ posts: ['p1'] });
    // The mapper fed step 1's `id` into step 2's request.
    expect(server.calls('/posts')[0]?.query['userId']).toBe('7');
});

test('each step is a CHILD run of the previous — the trace links the chain', async () => {
    server.route('GET', '/a', { body: { n: 1 } });
    server.route('GET', '/b', { body: { n: 2 } });
    const { sink, seen } = capturingSink();
    const a = stitch({
        name: 'a',
        baseUrl: server.url,
        path: '/a',
        trace: sink,
    });
    const b = stitch({
        name: 'b',
        baseUrl: server.url,
        path: '/b',
        trace: sink,
    });

    await pipe(a, b)();

    const aStart = seen.find(
        (s) => s.ctx.name === 'a' && s.ev.type === 'start',
    )!;
    const bStart = seen.find(
        (s) => s.ctx.name === 'b' && s.ev.type === 'start',
    )!;
    expect(aStart.ctx.parentId).toBeUndefined(); // the first step is a root run
    expect(bStart.ctx.parentId).toBe(aStart.ctx.runId); // b is a child of a
    expect(bStart.ctx.traceId).toBe(aStart.ctx.traceId); // one trace tree
});

test('fail-fast: a step error rejects the pipeline and stops it', async () => {
    server.route('GET', '/ok', { body: { ok: true } });
    let laterRan = false;
    const ok = stitch({
        name: 'ok',
        baseUrl: server.url,
        path: '/ok',
        adapter: async () => ({ status: 500, headers: {}, body: { e: 'x' } }),
    });
    const later = stitch({
        name: 'later',
        baseUrl: server.url,
        path: '/ok',
        adapter: async () => {
            laterRan = true;
            return { status: 200, headers: {}, body: {} };
        },
    });

    await expect(pipe(ok, later)()).rejects.toMatchObject({ status: 500 });
    expect(laterRan).toBe(false); // the pipe stopped at the failing step
});
