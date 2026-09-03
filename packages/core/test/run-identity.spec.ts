// Run identity (ADR 0007): each execute() mints an OTLP-aligned spanId + traceId,
// stamped on the `start` event and carried on the TraceSink ctx for EVERY event of the run.
// The OTLP sink reads them to build a real span tree (shared traceId, parentSpanId) instead of
// minting per-start and guessing by name; a child run inherits the parent's traceId and points
// parentSpanId at the parent's spanId. Ids are engine-minted, never caller-supplied (ADR 0002 §2).
import { multiplex, otlp, stitch } from '../src';
import type {
    OtelSpan,
    SpanExporter,
    StitchEvent,
    TraceContext,
    TraceSink,
} from '../src';
import { cookieSession } from '../src/auth';
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
    expect(start.spanId).toMatch(/^[0-9a-f]{16}$/); // = OTel spanId
    expect(start.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(start.parentSpanId).toBeUndefined(); // a root run

    // EVERY event of the run carries the SAME identity on the ctx (it is per-run-constant).
    expect(new Set(seen.map((s) => s.ctx.spanId))).toEqual(
        new Set([start.spanId]),
    );
    expect(new Set(seen.map((s) => s.ctx.traceId))).toEqual(
        new Set([start.traceId]),
    );
    expect(seen.every((s) => s.ctx.parentSpanId === undefined)).toBe(true);
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
            seen.filter((s) => s.ev.type === 'start').map((s) => s.ctx.spanId),
        ),
    ];
    expect(runIds).toHaveLength(2);
    expect(runIds[0]).not.toBe(runIds[1]);
});

test('newRunContext: a root mints fresh ids; a child inherits traceId and sets parentSpanId', () => {
    const root = newRunContext();
    expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(root.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(root.parentSpanId).toBeUndefined();

    const child = newRunContext(root);
    expect(child.traceId).toBe(root.traceId); // same tree
    expect(child.spanId).not.toBe(root.spanId); // its own span
    expect(child.parentSpanId).toBe(root.spanId); // linked to the parent
});

test('the OTLP sink builds a span tree from the ctx ids (traceId / spanId / parentSpanId)', () => {
    const { exporter, spans } = stubExporter();
    const sink = otlp.sink({ exporter });
    const parent = newRunContext();
    const child = newRunContext(parent); // shares traceId, parentSpanId = parent.spanId

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
            { type: 'result', data: {}, status: 200, attempts: 1, at: 2 },
            ctx,
        );
        sink.handle(
            { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 2 },
            ctx,
        );
    };
    emit('parentCall', parent);
    emit('childCall', child);

    expect(spans).toHaveLength(2);
    const ps = spans.find((s) => s.name.includes('parentCall'))!;
    const cs = spans.find((s) => s.name.includes('childCall'))!;
    expect(ps.traceId).toBe(parent.traceId);
    expect(ps.spanId).toBe(parent.spanId);
    expect(ps.parentSpanId).toBeUndefined();
    expect(cs.traceId).toBe(parent.traceId); // one tree
    expect(cs.spanId).toBe(child.spanId);
    expect(cs.parentSpanId).toBe(parent.spanId); // linked to its parent

    // …and parentSpanId is serialised onto the child span only.
    const out = otlp.json(spans) as {
        resourceSpans: {
            scopeSpans: {
                spans: { spanId: string; parentSpanId?: string }[];
            }[];
        }[];
    };
    const outSpans = out.resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(outSpans.find((s) => s.spanId === child.spanId)!.parentSpanId).toBe(
        parent.spanId,
    );
    expect(
        outSpans.find((s) => s.spanId === parent.spanId)!.parentSpanId,
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
        trace: multiplex(cap, otlp.sink({ exporter })),
    });

    await ping();

    const start = seen.find((s) => s.ev.type === 'start')!.ev as StartEvent;
    expect(spans).toHaveLength(1);
    expect(spans[0]!.traceId).toBe(start.traceId);
    expect(spans[0]!.spanId).toBe(start.spanId); // the span IS the run
});

test('a hand-fed OTLP sink (no ctx ids) still mints a valid span — back-compat', () => {
    const { exporter, spans } = stubExporter();
    const sink = otlp.sink({ exporter });
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
        { name }, // no spanId/traceId — the fallback path
    );
    sink.handle(
        { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 2 },
        { name },
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans[0]!.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spans[0]!.parentSpanId).toBeUndefined();
});

test('cookieSession runs its login as a traced CHILD of the call that triggered it', async () => {
    server.route('POST', '/login', {
        setCookie: { name: 'sid', value: 'GOOD' },
        body: { ok: true },
    });
    server.route('GET', '/me', {
        requireCookie: { name: 'sid' },
        body: { user: 'ada' },
    });
    // login + member share ONE sink (as seam members would), so the capturing sink sees both runs.
    const { sink, seen } = capturingSink();
    const signIn = stitch({
        name: 'login',
        method: 'POST',
        baseUrl: server.url,
        path: '/login',
        trace: sink,
    });
    const me = stitch({
        name: 'me',
        baseUrl: server.url,
        path: '/me',
        trace: sink,
        auth: cookieSession({ login: signIn, cookie: 'sid', tenancy: 'app' }),
    });

    await expect(me()).resolves.toEqual({ user: 'ada' });

    const meStart = seen.find(
        (s) => s.ctx.name === 'me' && s.ev.type === 'start',
    )!;
    const loginStart = seen.find(
        (s) => s.ctx.name === 'login' && s.ev.type === 'start',
    );
    // The login is no longer an invisible side-call: it is a child run under the `me` call.
    expect(loginStart).toBeDefined();
    expect(loginStart!.ctx.parentSpanId).toBe(meStart.ctx.spanId); // parent = the triggering run
    expect(loginStart!.ctx.traceId).toBe(meStart.ctx.traceId); // one trace tree
    expect(loginStart!.ctx.spanId).not.toBe(meStart.ctx.spanId); // its own span
    // …and the child run opens AND closes (start → done), so its span is complete.
    expect(
        seen.some((s) => s.ctx.name === 'login' && s.ev.type === 'done'),
    ).toBe(true);
});

test('OTLP: a retried call emits flat per-attempt child spans parented to the run', async () => {
    server.route('GET', '/flaky', { statuses: [503, 200], body: { ok: true } });
    const { exporter, spans } = stubExporter();
    const flaky = stitch({
        name: 'flaky',
        baseUrl: server.url,
        path: '/flaky',
        retry: { attempts: 3, on: [503], backoff: { curve: 'fixed', base: 1 } },
        trace: otlp.sink({ exporter }),
    });

    await flaky();

    const run = spans.find((s) => s.parentSpanId === undefined)!;
    const attempts = spans.filter((s) => s.name.startsWith('attempt '));
    expect(attempts).toHaveLength(2); // 503, then 200
    // Flat children of the run span — same trace, parented to the run, not nested in each other.
    expect(
        attempts.every(
            (a) => a.parentSpanId === run.spanId && a.traceId === run.traceId,
        ),
    ).toBe(true);
    // The first attempt failed and was retried; the second is the run's successful outcome.
    expect(attempts[0]!.status.code).toBe('ERROR');
    expect(attempts[1]!.status.code).toBe('OK');
});

test('OTLP: a paginated call emits flat per-page child spans parented to the run', async () => {
    server.route('GET', '/list', { body: [1, 2] });
    const { exporter, spans } = stubExporter();
    const list = stitch({
        name: 'list',
        baseUrl: server.url,
        path: '/list',
        paginate: {
            next: (_body, page) =>
                page < 3 ? { query: { page: page + 1 } } : undefined,
        },
        trace: otlp.sink({ exporter }),
    });

    await list();

    const run = spans.find((s) => s.parentSpanId === undefined)!;
    const pages = spans.filter((s) => s.name.startsWith('page '));
    expect(pages).toHaveLength(3);
    expect(
        pages.every(
            (p) => p.parentSpanId === run.spanId && p.traceId === run.traceId,
        ),
    ).toBe(true);
    // A non-paginated path would have produced `attempt` children — a paginated one shows pages.
    expect(spans.some((s) => s.name.startsWith('attempt '))).toBe(false);
});
