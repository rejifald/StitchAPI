// Run identity (ADR 0007): each execute() mints an OTLP-aligned runId (=spanId) + traceId,
// stamped on the `start` event and carried on the TraceSink ctx for EVERY event of the run.
// The OTLP sink reads them to build a real span tree (shared traceId, parentSpanId) instead of
// minting per-start and guessing by name; a child run inherits the parent's traceId and points
// parentId at the parent's runId. Ids are engine-minted, never caller-supplied (ADR 0002 §2).
import { multiplex, otlpTrace, stitch, toOtlpJson } from '../src';
import type {
    OtelSpan,
    SpanExporter,
    StitchEvent,
    TraceContext,
    TraceSink,
} from '../src';
import { newRunContext } from '../src/util';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

type StartEvent = Extract<StitchEvent, { type: 'start' }>;

// A sink that records every (event, ctx) pair, so a test can assert what identity the engine
// stamps and that it is constant across a run.
function capturingSink(): {
    sink: TraceSink;
    seen: { ev: StitchEvent; ctx: TraceContext }[];
} {
    const seen: { ev: StitchEvent; ctx: TraceContext }[] = [];
    return {
        seen,
        sink: {
            handle(ev, ctx) {
                // Snapshot the ctx — the engine reuses one object per run, so copy it.
                seen.push({ ev, ctx: { ...ctx } });
            },
        },
    };
}

function stubExporter(): { exporter: SpanExporter; spans: OtelSpan[] } {
    const spans: OtelSpan[] = [];
    return {
        spans,
        exporter: { export: (batch) => void spans.push(...batch) },
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

test('a call stamps OTLP-aligned run identity on `start` and shares it across the run', async () => {
    server.route('GET', '/thing', { body: { ok: true } });
    const { sink, seen } = capturingSink();
    const thing = stitch({
        name: 'thing',
        baseUrl: server.url,
        path: '/thing',
        trace: sink,
    });

    for await (const _ev of thing.stream()) void _ev; // drain

    const start = seen.find((s) => s.ev.type === 'start')!.ev as StartEvent;
    expect(start.runId).toMatch(/^[0-9a-f]{16}$/); // = OTel spanId
    expect(start.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(start.parentId).toBeUndefined(); // a root run

    // EVERY event of the run carries the SAME identity on the ctx (it is per-run-constant).
    expect(new Set(seen.map((s) => s.ctx.runId))).toEqual(
        new Set([start.runId]),
    );
    expect(new Set(seen.map((s) => s.ctx.traceId))).toEqual(
        new Set([start.traceId]),
    );
    expect(seen.every((s) => s.ctx.parentId === undefined)).toBe(true);
});

test('each call of one stitch is its own run with a distinct id', async () => {
    server.route('GET', '/thing', { body: { ok: true } });
    const { sink, seen } = capturingSink();
    const thing = stitch({
        name: 'thing',
        baseUrl: server.url,
        path: '/thing',
        trace: sink,
    });

    await thing();
    await thing();

    const runIds = [
        ...new Set(
            seen.filter((s) => s.ev.type === 'start').map((s) => s.ctx.runId),
        ),
    ];
    expect(runIds).toHaveLength(2);
    expect(runIds[0]).not.toBe(runIds[1]);
});

test('newRunContext: a root mints fresh ids; a child inherits traceId and sets parentId', () => {
    const root = newRunContext();
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.runId).toMatch(/^[0-9a-f]{16}$/);
    expect(root.parentId).toBeUndefined();

    const child = newRunContext(root);
    expect(child.traceId).toBe(root.traceId); // same tree
    expect(child.runId).not.toBe(root.runId); // its own span
    expect(child.parentId).toBe(root.runId); // linked to the parent
});

test('the OTLP sink builds a span tree from the ctx ids (traceId / spanId / parentSpanId)', () => {
    const { exporter, spans } = stubExporter();
    const sink = otlpTrace({ exporter });
    const parent = newRunContext();
    const child = newRunContext(parent); // shares traceId, parentId = parent.runId

    const emit = (name: string, run: typeof parent) => {
        const ctx: TraceContext = { name, ...run };
        sink.handle(
            {
                type: 'start',
                name,
                method: 'GET',
                url: 'http://api.example.com/x',
                input: {},
                at: 1,
            },
            ctx,
        );
        sink.handle(
            { type: 'result', value: {}, status: 200, attempts: 1, at: 2 },
            ctx,
        );
        sink.handle({ type: 'done', ok: true, ms: 1, attempts: 1, at: 2 }, ctx);
    };
    emit('parentCall', parent);
    emit('childCall', child);

    expect(spans).toHaveLength(2);
    const ps = spans.find((s) => s.name.includes('parentCall'))!;
    const cs = spans.find((s) => s.name.includes('childCall'))!;
    expect(ps.traceId).toBe(parent.traceId);
    expect(ps.spanId).toBe(parent.runId);
    expect(ps.parentSpanId).toBeUndefined();
    expect(cs.traceId).toBe(parent.traceId); // one tree
    expect(cs.spanId).toBe(child.runId);
    expect(cs.parentSpanId).toBe(parent.runId); // linked to its parent

    // …and parentSpanId is serialised onto the child span only.
    const out = toOtlpJson(spans) as {
        resourceSpans: {
            scopeSpans: {
                spans: { spanId: string; parentSpanId?: string }[];
            }[];
        }[];
    };
    const outSpans = out.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(outSpans.find((s) => s.spanId === child.runId)!.parentSpanId).toBe(
        parent.runId,
    );
    expect(
        outSpans.find((s) => s.spanId === parent.runId)!.parentSpanId,
    ).toBeUndefined();
});

test('end-to-end: a real call feeds the OTLP sink the same ids it stamped on `start`', async () => {
    server.route('GET', '/ping', { body: { ok: true } });
    const { exporter, spans } = stubExporter();
    const { sink: cap, seen } = capturingSink();
    const ping = stitch({
        name: 'ping',
        baseUrl: server.url,
        path: '/ping',
        trace: multiplex(cap, otlpTrace({ exporter })),
    });

    await ping();

    const start = seen.find((s) => s.ev.type === 'start')!.ev as StartEvent;
    expect(spans).toHaveLength(1);
    expect(spans[0]!.traceId).toBe(start.traceId);
    expect(spans[0]!.spanId).toBe(start.runId); // the span IS the run
});

test('a hand-fed OTLP sink (no ctx ids) still mints a valid span — back-compat', () => {
    const { exporter, spans } = stubExporter();
    const sink = otlpTrace({ exporter });
    const name = 'legacy';
    sink.handle(
        {
            type: 'start',
            name,
            method: 'GET',
            url: 'http://api.example.com/x',
            input: {},
            at: 1,
        },
        { name }, // no runId/traceId — the fallback path
    );
    sink.handle(
        { type: 'done', ok: true, ms: 1, attempts: 1, at: 2 },
        { name },
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans[0]!.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spans[0]!.parentSpanId).toBeUndefined();
});
