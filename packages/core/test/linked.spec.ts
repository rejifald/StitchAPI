// `linked` opens a run SCOPE so a body of plain `await`s shares one trace tree (stitchapi/pipe). Proves:
// (1) it resolves to the body's return and chains the runs into the same causal chain `pipe` draws;
// (2) it FAILS FAST — a rejected call rejects the scope and stops the body; (3) a combinator (`all`)
// run through `run` nests its fan inside the same trace. See src/pipe.ts.
import { stitch } from '../src';
import type { StitchEvent, TraceContext, TraceSink } from '../src';
import { all, linked } from '../src/pipe';

interface Res {
    status: number;
    headers: Record<string, string>;
    body: unknown;
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

// A 200 stitch that resolves to `body`, wired to `sink`.
const mk = (name: string, sink: TraceSink, body: unknown) =>
    stitch({
        name,
        baseUrl: 'http://x',
        path: `/${name}`,
        trace: sink,
        adapter: async (): Promise<Res> => ({ status: 200, headers: {}, body }),
    });

// A non-retryable 400 → a `StitchError` with `.status` 400.
const boom = (name: string, sink: TraceSink) =>
    stitch({
        name,
        baseUrl: 'http://x',
        path: `/${name}`,
        trace: sink,
        adapter: async (): Promise<Res> => ({
            status: 400,
            headers: {},
            body: { e: 'x' },
        }),
    });

test('linked: resolves to the body return and chains the runs into one trace', async () => {
    const { sink, seen } = capturingSink();
    const order = mk('order', sink, { id: 1, shipmentId: 's1', region: 'EU' });
    const shipment = mk('shipment', sink, {
        carrier: 'dhl',
        trackingCode: 'TC',
    });
    const tracking = mk('tracking', sink, { events: ['delivered'] });

    const out = await linked(async (run) => {
        await run(order);
        await run(shipment);
        return run(tracking);
    });
    expect(out).toEqual({ events: ['delivered'] });

    const start = (name: string) =>
        seen.find((e) => e.ctx.name === name && e.ev.type === 'start')!;
    const o = start('order');
    const s = start('shipment');
    const t = start('tracking');

    expect(o.ctx.traceId).toBeDefined();
    expect(s.ctx.traceId).toBe(o.ctx.traceId);
    expect(t.ctx.traceId).toBe(o.ctx.traceId); // one trace tree
    expect(o.ctx.parentSpanId).toBeUndefined(); // order is the scope root
    expect(s.ctx.parentSpanId).toBe(o.ctx.spanId); // shipment a child of order
    expect(t.ctx.parentSpanId).toBe(s.ctx.spanId); // tracking a child of shipment
});

test('linked: fails fast — a rejected call rejects the scope and stops the body', async () => {
    const { sink, seen } = capturingSink();
    const order = mk('order', sink, { id: 1 });
    const bad = boom('bad', sink);
    let reachedAfter = false;
    const after = mk('after', sink, { never: true });

    await expect(
        linked(async (run) => {
            await run(order);
            await run(bad); // rejects here
            reachedAfter = true;
            return run(after);
        }),
    ).rejects.toMatchObject({ status: 400 });

    expect(reachedAfter).toBe(false); // the body stopped at the failure
    expect(seen.some((e) => e.ctx.name === 'after')).toBe(false); // never ran
});

test('linked: a combinator run through `run` nests its fan inside the scope trace', async () => {
    const { sink, seen } = capturingSink();
    const order = mk('order', sink, { id: 1 });
    const a = mk('a', sink, { a: 1 });
    const b = mk('b', sink, { b: 2 });
    const tracking = mk('tracking', sink, { ok: true });

    const out = await linked(async (run) => {
        await run(order);
        const both = await run(all({ a, b })); // a combinator as a node
        expect(both).toEqual({ a: { a: 1 }, b: { b: 2 } });
        return run(tracking);
    });
    expect(out).toEqual({ ok: true });

    const start = (name: string) =>
        seen.find((e) => e.ctx.name === name && e.ev.type === 'start')!;
    const o = start('order');
    const sa = start('a');
    const sb = start('b');
    const t = start('tracking');

    // The whole fan is in the order's trace tree.
    expect(sa.ctx.traceId).toBe(o.ctx.traceId);
    expect(sb.ctx.traceId).toBe(o.ctx.traceId);
    // `a` and `b` are siblings under the `all` group (a child of the scope), not direct children of
    // the order — and the chain continues under that same group run for `tracking`.
    expect(sa.ctx.parentSpanId).toBe(sb.ctx.parentSpanId);
    expect(sa.ctx.parentSpanId).not.toBe(o.ctx.spanId);
    expect(t.ctx.parentSpanId).toBe(sa.ctx.parentSpanId);
});
