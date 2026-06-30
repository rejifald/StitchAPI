/**
 * A2 — trace-collector unit proofs (no browser, no installed deps).
 *
 * Drives `createTraceCollector` with a FAKE core `stitch` that pumps synthetic
 * `StitchEvent`s through the injected trace sink — exactly what the real engine's
 * `tee` does on the await/.stream() paths. Proves real lifecycle events become
 * `StitchTraceEntry` DAG nodes + stream `chunk` events on the progress sink.
 *
 * Run with:  npx -y tsx docs/sandbox/runtime/trace-collector.test.ts
 */
import type { RunEvent } from '../component/runner';
import { createTraceCollector } from './trace-collector';
import type { ProgressSink } from './worker-entry';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: unknown): void {
    if (condition) {
        console.log(`  PASS  ${label}`);
        passed++;
    } else {
        console.error(`  FAIL  ${label}`, detail ?? '');
        failed++;
    }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * A fake core `stitch`: returns a callable that, when invoked, drives the given
 * synthetic events through the trace sink the collector injected into `config`,
 * then resolves `value`. `onConfig` captures the config the collector passed.
 */
function fakeCore(opts: {
    events: () => any[];
    value?: unknown;
    onConfig?: (config: any) => void;
    spanId?: string;
}): (config: unknown) => unknown {
    return (config: any) => {
        opts.onConfig?.(config);
        const sink = config.trace as {
            handle: (e: any, ctx: any) => void;
        };
        const name = config.name ?? config.path ?? 'stitch';
        return (_input?: unknown) => {
            // Mimic the real engine `tee` (ADR 0007): one run identity per call, on the ctx of
            // EVERY event. The collector keys entries by `ctx.spanId`.
            const ctx = {
                name,
                spanId: opts.spanId ?? 'run-1',
                traceId: 'trace-1',
            };
            for (const ev of opts.events()) sink.handle(ev, ctx);
            return Promise.resolve(opts.value ?? { ok: true });
        };
    };
}

const startEv = (over: any = {}) => ({
    type: 'start',
    name: 'getUser',
    method: 'GET',
    url: 'https://demo/users/2',
    input: {},
    at: 0,
    ...over,
});

async function runTests(): Promise<void> {
    console.log('\n--- A2 trace-collector: real events → DAG entries ---\n');

    /* 1 — a successful call → one trace entry with request + response ------- */
    {
        const events: RunEvent[] = [];
        const collector = createTraceCollector(
            fakeCore({
                events: () => [
                    startEv(),
                    {
                        type: 'result',
                        value: {},
                        status: 200,
                        attempts: 1,
                        at: 3,
                    },
                    { type: 'done', ok: true, ms: 12, attempts: 1, at: 12 },
                ],
            }),
        );
        collector.bindProgress((e) => events.push(e));
        const s = collector.stitch({
            name: 'getUser',
        }) as () => Promise<unknown>;
        await s();

        const traceEvents = events.filter((e) => e.type === 'trace');
        assert('1 emitted exactly one trace event', traceEvents.length === 1);
        const entry = (traceEvents[0] as Extract<RunEvent, { type: 'trace' }>)
            ?.entry;
        assert(
            '1 entry has id, label, request method/url',
            entry?.id === 'run-1' &&
                entry?.label === 'getUser' &&
                entry?.request.method === 'GET' &&
                entry?.request.url === 'https://demo/users/2',
            entry,
        );
        assert(
            '1 entry response is ok with status + duration',
            entry?.response?.status === 200 &&
                entry?.response?.ok === true &&
                entry?.response?.durationMs === 12,
            entry?.response,
        );
        assert(
            '1 no error, no stream on success',
            !entry?.error && !entry?.stream,
        );
    }

    /* 2 — an HTTP error (status known) → error + response(ok:false) --------- */
    {
        const events: RunEvent[] = [];
        const collector = createTraceCollector(
            fakeCore({
                events: () => [
                    startEv(),
                    {
                        type: 'error',
                        name: 'StitchHTTP',
                        message: 'gateway timeout',
                        status: 504,
                        attempts: 1,
                        at: 5,
                    },
                    { type: 'done', ok: false, ms: 30, attempts: 1, at: 30 },
                ],
            }),
        );
        collector.bindProgress((e) => events.push(e));
        const s = collector.stitch({ name: 'x' }) as () => Promise<unknown>;
        await s();
        const entry = (
            events.find((e) => e.type === 'trace') as
                | Extract<RunEvent, { type: 'trace' }>
                | undefined
        )?.entry;
        assert(
            '2 entry carries the error name/message',
            entry?.error?.name === 'StitchHTTP' &&
                entry?.error?.message === 'gateway timeout',
            entry?.error,
        );
        assert(
            '2 entry response is not-ok with the error status',
            entry?.response?.status === 504 && entry?.response?.ok === false,
            entry?.response,
        );
    }

    /* 3 — a transport error (no status) → error, no response ---------------- */
    {
        const events: RunEvent[] = [];
        const collector = createTraceCollector(
            fakeCore({
                events: () => [
                    startEv(),
                    {
                        type: 'error',
                        name: 'StitchError',
                        message: 'network down',
                        attempts: 1,
                        at: 2,
                    },
                    { type: 'done', ok: false, ms: 8, attempts: 1, at: 8 },
                ],
            }),
        );
        collector.bindProgress((e) => events.push(e));
        await (collector.stitch({ name: 'x' }) as () => Promise<unknown>)();
        const entry = (
            events.find((e) => e.type === 'trace') as
                | Extract<RunEvent, { type: 'trace' }>
                | undefined
        )?.entry;
        assert(
            '3 error entry has no response when status is unknown',
            !!entry?.error && entry?.response === undefined,
            entry,
        );
    }

    /* 4 — streaming deltas → chunk events then a trace with stream count ---- */
    {
        const events: RunEvent[] = [];
        const collector = createTraceCollector(
            fakeCore({
                events: () => [
                    startEv(),
                    { type: 'delta', chunk: 'Hel', at: 1 },
                    { type: 'delta', chunk: 'lo', at: 2 },
                    { type: 'done', ok: true, ms: 5, attempts: 1, at: 5 },
                ],
            }),
        );
        collector.bindProgress((e) => events.push(e));
        await (collector.stitch({ name: 'x' }) as () => Promise<unknown>)();
        const types = events.map((e) => e.type);
        assert(
            '4 order is chunk, chunk, trace',
            JSON.stringify(types) ===
                JSON.stringify(['chunk', 'chunk', 'trace']),
            types,
        );
        const chunks = events.filter((e) => e.type === 'chunk') as Extract<
            RunEvent,
            { type: 'chunk' }
        >[];
        assert(
            '4 chunks carry the entry id + ordered text',
            chunks[0]?.traceId === 'run-1' &&
                chunks[0]?.text === 'Hel' &&
                chunks[1]?.text === 'lo',
            chunks,
        );
        const entry = (
            events.find((e) => e.type === 'trace') as
                | Extract<RunEvent, { type: 'trace' }>
                | undefined
        )?.entry;
        assert(
            '4 trace entry records stream chunk count',
            entry?.stream?.chunks === 2,
            entry,
        );
    }

    /* 5 — sensitive request headers surface as headersRedacted -------------- */
    {
        const events: RunEvent[] = [];
        const collector = createTraceCollector(
            fakeCore({
                events: () => [
                    startEv({
                        input: {
                            headers: {
                                Authorization: 'Bearer s3cret',
                                'content-type': 'application/json',
                            },
                        },
                    }),
                    {
                        type: 'result',
                        value: {},
                        status: 200,
                        attempts: 1,
                        at: 1,
                    },
                    { type: 'done', ok: true, ms: 4, attempts: 1, at: 4 },
                ],
            }),
        );
        collector.bindProgress((e) => events.push(e));
        await (collector.stitch({ name: 'x' }) as () => Promise<unknown>)();
        const entry = (
            events.find((e) => e.type === 'trace') as
                | Extract<RunEvent, { type: 'trace' }>
                | undefined
        )?.entry;
        assert(
            '5 only the sensitive header name is flagged',
            JSON.stringify(entry?.request.headersRedacted) ===
                JSON.stringify(['Authorization']),
            entry?.request.headersRedacted,
        );
    }

    /* 6 — a user-supplied trace sink is preserved (multiplexed) ------------- */
    {
        const events: RunEvent[] = [];
        const userSeen: string[] = [];
        const userSink = {
            handle: (e: any) => userSeen.push(e.type as string),
        };
        const collector = createTraceCollector(
            fakeCore({
                events: () => [
                    startEv(),
                    {
                        type: 'result',
                        value: {},
                        status: 200,
                        attempts: 1,
                        at: 1,
                    },
                    { type: 'done', ok: true, ms: 6, attempts: 1, at: 6 },
                ],
            }),
        );
        collector.bindProgress((e) => events.push(e));
        await (
            collector.stitch({
                name: 'x',
                trace: userSink,
            }) as () => Promise<unknown>
        )();
        assert(
            '6 user sink still received the raw lifecycle events',
            userSeen.includes('start') && userSeen.includes('done'),
            userSeen,
        );
        assert(
            '6 DAG trace still emitted alongside the user sink',
            events.some((e) => e.type === 'trace'),
            events,
        );
    }

    /* 7 — string shorthand is normalised to a path, not shattered ---------- */
    {
        let received: any;
        const collector = createTraceCollector(
            fakeCore({
                events: () => [],
                onConfig: (c) => {
                    received = c;
                },
            }),
        );
        collector.bindProgress(() => {});
        await (
            collector.stitch('https://demo/users/2') as () => Promise<unknown>
        )();
        assert(
            '7 string config became { path } with an injected trace sink',
            received?.path === 'https://demo/users/2' &&
                typeof received?.trace === 'object' &&
                received['0'] === undefined,
            received,
        );
    }

    /* 8 — no bound sink → no emit, no throw, value still returned ----------- */
    {
        const collector = createTraceCollector(
            fakeCore({
                events: () => [
                    startEv(),
                    { type: 'done', ok: true, ms: 1, attempts: 1, at: 1 },
                ],
                value: { ok: true, id: 2 },
            }),
        );
        // deliberately NOT binding a progress sink (or unbind immediately):
        const unbind = collector.bindProgress((_e: RunEvent) => {
            throw new Error('should not be called after unbind');
        });
        unbind();
        let threw = false;
        let value: unknown;
        try {
            value = await (
                collector.stitch({ name: 'x' }) as () => Promise<unknown>
            )();
        } catch {
            threw = true;
        }
        assert('8 no throw when no active sink', !threw);
        assert(
            '8 value still returned with the sink unbound',
            !!value && (value as { id: number }).id === 2,
            value,
        );
    }

    /* 9 — a CHILD run (parentSpanId) becomes a dependsOn edge, even interleaved --- */
    {
        // The cookieSession login case: a child run's events arrive on the SAME sink, NESTED
        // inside the parent's (start parent → start/result/done child → result/done parent). The
        // run-id keying must attribute each event to the right entry (a FIFO would not) and turn
        // the child's parentSpanId into a `dependsOn` edge (ADR 0007).
        const events: RunEvent[] = [];
        let dag!: { handle: (e: any, ctx: any) => void };
        const collector = createTraceCollector(
            fakeCore({ events: () => [], onConfig: (c) => (dag = c.trace) }),
        );
        collector.bindProgress((e) => events.push(e));
        collector.stitch({ name: 'parent' }); // realize the dag sink via onConfig
        const parent = { name: 'parent', spanId: 'p1', traceId: 't1' };
        const child = {
            name: 'login',
            spanId: 'c1',
            traceId: 't1',
            parentSpanId: 'p1',
        };
        dag.handle(startEv({ name: 'parent' }), parent);
        dag.handle(startEv({ name: 'login' }), child); // child opens mid-parent
        dag.handle(
            { type: 'result', value: {}, status: 200, attempts: 1, at: 1 },
            child,
        );
        dag.handle(
            { type: 'done', ok: true, ms: 2, attempts: 1, at: 2 },
            child,
        );
        dag.handle(
            { type: 'result', value: {}, status: 200, attempts: 1, at: 3 },
            parent,
        );
        dag.handle(
            { type: 'done', ok: true, ms: 4, attempts: 1, at: 4 },
            parent,
        );

        const entries = events
            .filter((e) => e.type === 'trace')
            .map((e) => (e as Extract<RunEvent, { type: 'trace' }>).entry);
        const childEntry = entries.find((en) => en.id === 'c1');
        const parentEntry = entries.find((en) => en.id === 'p1');
        assert(
            '9 child run draws a dependsOn edge to its parent',
            JSON.stringify(childEntry?.dependsOn) === JSON.stringify(['p1']),
            childEntry,
        );
        assert(
            '9 parent run has no dependsOn',
            !!parentEntry && parentEntry.dependsOn === undefined,
            parentEntry,
        );
        assert(
            '9 interleaved runs attributed by id, not order',
            childEntry?.label === 'login' && parentEntry?.label === 'parent',
            entries,
        );
    }

    /* 10 — retry / paginate progress events annotate the entry with counts ---- */
    {
        const events: RunEvent[] = [];
        const collector = createTraceCollector(
            fakeCore({
                events: () => [
                    startEv(),
                    { type: 'progress', phase: 'request', attempt: 1, at: 0 },
                    { type: 'progress', phase: 'retry', attempt: 1, at: 1 },
                    { type: 'progress', phase: 'request', attempt: 2, at: 2 },
                    {
                        type: 'result',
                        value: {},
                        status: 200,
                        attempts: 2,
                        at: 3,
                    },
                    { type: 'done', ok: true, ms: 3, attempts: 2, at: 3 },
                ],
            }),
        );
        collector.bindProgress((e) => events.push(e));
        await (collector.stitch({ name: 'x' }) as () => Promise<unknown>)();
        const entry = (
            events.find((e) => e.type === 'trace') as
                | Extract<RunEvent, { type: 'trace' }>
                | undefined
        )?.entry;
        assert(
            '10 a retried run is annotated with its attempt count',
            entry?.attempts === 2 && entry?.pages === undefined,
            entry,
        );
    }

    /* 11 — a single-attempt run carries no attempts/pages annotation --------- */
    {
        const events: RunEvent[] = [];
        const collector = createTraceCollector(
            fakeCore({
                events: () => [
                    startEv(),
                    { type: 'progress', phase: 'request', attempt: 1, at: 0 },
                    {
                        type: 'result',
                        value: {},
                        status: 200,
                        attempts: 1,
                        at: 1,
                    },
                    { type: 'done', ok: true, ms: 1, attempts: 1, at: 1 },
                ],
            }),
        );
        collector.bindProgress((e) => events.push(e));
        await (collector.stitch({ name: 'x' }) as () => Promise<unknown>)();
        const entry = (
            events.find((e) => e.type === 'trace') as
                | Extract<RunEvent, { type: 'trace' }>
                | undefined
        )?.entry;
        assert(
            '11 a single clean attempt gets no count annotation',
            entry?.attempts === undefined && entry?.pages === undefined,
            entry,
        );
    }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed === 0) {
        console.log('A2 OK');
    } else {
        console.error('A2 FAILED');
        process.exit(1);
    }
}

// satisfy the ProgressSink type import (documents the bound-sink shape).
const _typecheck: ProgressSink = () => {};
void _typecheck;

runTests().catch((err) => {
    console.error('Unexpected test runner error:', err);
    process.exit(1);
});
