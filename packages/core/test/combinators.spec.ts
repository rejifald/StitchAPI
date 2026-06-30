// stitchapi/pipe — the parallel combinators all / any / race. Covers the result shapes, fail-fast /
// first-success / first-settle semantics, AUTO-CANCELLATION of members that can no longer affect the
// result (a blocker member observes its `req.signal`), and the sibling-child-run fan that a trace
// draws. The decider in each cancel test is delayed a beat so the blocker has attached its abort
// listener before the result is known (deterministic, not a race).
import { stitch } from '../src';
import type { StitchEvent, TraceContext, TraceSink } from '../src';
import { all, any, race } from '../src/pipe';

interface Res {
    status: number;
    headers: Record<string, string>;
    body: unknown;
}

// Resolve immediately to `body` (HTTP 200).
const ok = (body: unknown) =>
    stitch({
        name: 'ok',
        baseUrl: 'http://x',
        path: '/ok',
        adapter: async (): Promise<Res> => ({ status: 200, headers: {}, body }),
    });

// Resolve `body` after `ms` (HTTP 200).
const okAfter = (ms: number, body: unknown) =>
    stitch({
        name: 'ok',
        baseUrl: 'http://x',
        path: '/ok',
        adapter: (): Promise<Res> =>
            new Promise((res) => {
                setTimeout(() => {
                    res({ status: 200, headers: {}, body });
                }, ms);
            }),
    });

// Fail immediately with a non-retryable 400 → a `StitchError` with `.status` 400.
const boom = () =>
    stitch({
        name: 'boom',
        baseUrl: 'http://x',
        path: '/boom',
        adapter: async (): Promise<Res> => ({
            status: 400,
            headers: {},
            body: { e: 'x' },
        }),
    });

// Fail with a 400 after `ms`.
const boomAfter = (ms: number) =>
    stitch({
        name: 'boom',
        baseUrl: 'http://x',
        path: '/boom',
        adapter: (): Promise<Res> =>
            new Promise((res) => {
                setTimeout(() => {
                    res({ status: 400, headers: {}, body: { e: 'x' } });
                }, ms);
            }),
    });

// Never settles on its own — only when its request is aborted. Records the abort.
function blocker() {
    let aborted = false;
    const s = stitch({
        name: 'blocker',
        baseUrl: 'http://x',
        path: '/b',
        adapter: (req): Promise<Res> =>
            new Promise<Res>((_resolve, reject) => {
                const onAbort = () => {
                    aborted = true;
                    reject(new Error('aborted'));
                };
                if (req.signal?.aborted) onAbort();
                else req.signal?.addEventListener('abort', onAbort);
            }),
    });
    return { s, aborted: () => aborted };
}

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

test('all: resolves to a typed named object when every member succeeds', async () => {
    await expect(all({ a: ok({ n: 1 }), b: ok({ n: 2 }) })()).resolves.toEqual({
        a: { n: 1 },
        b: { n: 2 },
    });
});

test('all (array form): resolves to a positional tuple, in order', async () => {
    await expect(all([ok({ n: 1 }), ok({ n: 2 })])()).resolves.toEqual([
        { n: 1 },
        { n: 2 },
    ]);
});

test('all (argument-list form): bare members resolve to a positional tuple, in order', async () => {
    await expect(all(ok({ n: 1 }), ok({ n: 2 }))()).resolves.toEqual([
        { n: 1 },
        { n: 2 },
    ]);
});

test('all (argument-list form): a single bare member is a one-element tuple, not a bag', async () => {
    await expect(all(ok({ n: 1 }))()).resolves.toEqual([{ n: 1 }]);
});

test('all (array form): fail-fast — the first failure rejects and aborts the rest', async () => {
    const slow = blocker();
    await expect(all([boomAfter(10), slow.s])()).rejects.toMatchObject({
        status: 400,
    });
    expect(slow.aborted()).toBe(true);
});

test('all: fail-fast — the first failure rejects and aborts the rest', async () => {
    const slow = blocker();
    await expect(
        all({ bad: boomAfter(10), slow: slow.s })(),
    ).rejects.toMatchObject({ status: 400 });
    expect(slow.aborted()).toBe(true); // sibling auto-cancelled
});

test('any: resolves with the first success and cancels the losers', async () => {
    const slow = blocker();
    await expect(any([slow.s, okAfter(10, { ok: true })])()).resolves.toEqual({
        ok: true,
    });
    expect(slow.aborted()).toBe(true);
});

test('any: rejects with an AggregateError when every member fails', async () => {
    await expect(any([boom(), boom()])()).rejects.toBeInstanceOf(
        AggregateError,
    );
});

test('any (argument-list form): bare members behave like the array form', async () => {
    const slow = blocker();
    await expect(any(slow.s, okAfter(10, { ok: true }))()).resolves.toEqual({
        ok: true,
    });
    expect(slow.aborted()).toBe(true);
});

test('race (argument-list form): bare members behave like the array form', async () => {
    const slow = blocker();
    await expect(race(boomAfter(10), slow.s)()).rejects.toMatchObject({
        status: 400,
    });
    expect(slow.aborted()).toBe(true);
});

test('race: the first to settle wins — even a fast failure — and cancels the rest', async () => {
    const slow = blocker();
    await expect(race([boomAfter(10), slow.s])()).rejects.toMatchObject({
        status: 400,
    });
    expect(slow.aborted()).toBe(true);
});

test('all: members run as sibling child runs of one parent (trace fan)', async () => {
    const { sink, seen } = capturingSink();
    const mk = (name: string) =>
        stitch({
            name,
            baseUrl: 'http://x',
            path: `/${name}`,
            trace: sink,
            adapter: async (): Promise<Res> => ({
                status: 200,
                headers: {},
                body: {},
            }),
        });

    await all({ a: mk('a'), b: mk('b') })();

    const start = (name: string) =>
        seen.find((s) => s.ctx.name === name && s.ev.type === 'start')!;
    const a = start('a');
    const b = start('b');
    expect(a.ctx.parentSpanId).toBeDefined();
    expect(a.ctx.parentSpanId).toBe(b.ctx.parentSpanId); // same parent — the group run
    expect(a.ctx.traceId).toBe(b.ctx.traceId); // one trace tree
});
