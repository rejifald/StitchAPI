// C6 — does `linked` (pipe.ts:357) produce ONE trace chain across the three endpoints, and is a
// mid-operation failure attributable to the operation as a whole?
//
// Measured off a real `TraceSink`: the `traceId` / `spanId` / `parentSpanId` each run reports, what
// a bare sequence of awaits reports instead, and what the trace says when the poll fails between a
// successful submit and a download that never happens.
//
//   pnpm exec tsx docs/scenarios/proofs/async-job-polling/c6-linked-trace.ts
import { stitch } from '../../../../packages/core/src/index';
import { linked } from '../../../../packages/core/src/pipe';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    StitchEvent,
    TraceContext,
    TraceSink,
} from '../../../../packages/core/src/types';
import { FakeJobApi, resultUrlOf, stateOf } from './fake-jobs';
import { check, finish, heading, note } from './harness';

const HOST = 'https://bulk.example.com';

/** One trace record: the stitch name, the event, and the run identity it arrived under. */
interface Rec {
    name: string;
    type: StitchEvent['type'];
    /** Present on `progress` events only — `request` / `retry` / `throttled` / … */
    phase: string | undefined;
    traceId: string | undefined;
    spanId: string | undefined;
    parentSpanId: string | undefined;
}

/** A sink that just records. `TraceSink` is the documented seam (types.ts:1957-1960). */
function recordingSink(into: Rec[]): TraceSink {
    return {
        handle(event: StitchEvent, ctx: TraceContext): void {
            into.push({
                name: ctx.name,
                type: event.type,
                phase: event.type === 'progress' ? event.phase : undefined,
                traceId: ctx.traceId,
                spanId: ctx.spanId,
                parentSpanId: ctx.parentSpanId,
            });
        },
    };
}

const pollSurface = (after: number): Surface => ({
    id: 'job-poll',
    interpret: (res) => {
        const state = stateOf(res.body);
        if (state === 'InProgress')
            return { ok: false, retry: true, message: 'InProgress', after };
        if (state === 'Failed')
            return { ok: false, message: 'job failed', status: res.status };
        return { ok: true, data: res.body };
    },
});

async function main(): Promise<void> {
    heading('C6 — does `linked` draw ONE trace chain across the triangle?');

    // ── (a) three stitches under `linked` share one traceId and chain their spans ─────────────
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 2 });
        const recs: Rec[] = [];
        const trace = recordingSink(recs);
        const submit = stitch({
            name: 'submit',
            url: FakeJobApi.submitUrl,
            method: 'POST',
            adapter: api.adapter(),
            clock,
            trace,
        });
        const poll = stitch({
            name: 'poll',
            url: `${HOST}{+loc}`,
            kind: pollSurface(30_000),
            adapter: api.adapter(),
            clock,
            retry: { attempts: 10 },
            trace,
        });
        const download = stitch({
            name: 'download',
            url: '{+u}',
            adapter: api.adapter(),
            clock,
            trace,
        });
        const flow = linked(async (run) => {
            await run(submit, { body: {} });
            const id = api.jobIds.at(-1)!;
            const status = await run(poll, { params: { loc: `/jobs/${id}` } });
            return run(download, { params: { u: resultUrlOf(status)! } });
        });
        await clock.advance(3_600_000);
        check(
            '(a) the flow resolved',
            JSON.stringify(await flow),
            '{"rows":3}',
        );

        const starts = recs.filter((r) => r.type === 'start');
        check(
            '(a) `start` events (one per stitch, not per poll)',
            starts.length,
            3,
        );
        check(
            '(a) distinct traceIds across the whole operation',
            new Set(recs.map((r) => r.traceId)).size,
            1,
        );
        check(
            '(a) distinct spanIds (one run per member)',
            new Set(recs.map((r) => r.spanId)).size,
            3,
        );
        const chain = starts.map((s) => s.name).join(' → ');
        check('(a) the chain, in order', chain, 'submit → poll → download');
        check(
            '(a) submit is the ROOT (no parent)',
            starts[0]?.parentSpanId,
            undefined,
        );
        check(
            '(a) poll’s parent IS submit’s span',
            starts[1]?.parentSpanId === starts[0]?.spanId,
            true,
        );
        check(
            '(a) download’s parent IS poll’s span',
            starts[2]?.parentSpanId === starts[1]?.spanId,
            true,
        );
        check(
            '(a) `request` progress events inside poll’s span (one per poll)',
            recs.filter((r) => r.name === 'poll' && r.phase === 'request')
                .length,
            3,
        );
        check(
            '(a) `retry` progress events inside poll’s span',
            recs.filter((r) => r.name === 'poll' && r.phase === 'retry').length,
            2,
        );
    }

    // ── (b) the same three awaits WITHOUT `linked` are three unrelated roots ──────────────────
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 2 });
        const recs: Rec[] = [];
        const trace = recordingSink(recs);
        const submit = stitch({
            name: 'submit',
            url: FakeJobApi.submitUrl,
            method: 'POST',
            adapter: api.adapter(),
            clock,
            trace,
        });
        const poll = stitch({
            name: 'poll',
            url: `${HOST}{+loc}`,
            kind: pollSurface(30_000),
            adapter: api.adapter(),
            clock,
            retry: { attempts: 10 },
            trace,
        });
        const download = stitch({
            name: 'download',
            url: '{+u}',
            adapter: api.adapter(),
            clock,
            trace,
        });
        await submit.safe({ body: {} });
        const id = api.jobIds.at(-1)!;
        const pp = poll.safe({ params: { loc: `/jobs/${id}` } });
        await clock.advance(3_600_000);
        const status = await pp;
        await download.safe({ params: { u: resultUrlOf(status.data)! } });

        check(
            '(b) distinct traceIds',
            new Set(recs.map((r) => r.traceId)).size,
            3,
        );
        check(
            '(b) runs with a parent',
            recs.filter((r) => r.parentSpanId !== undefined).length,
            0,
        );
        note(
            '(b) → same code, same calls; the only difference is calling through `run`',
            '',
        );
    }

    // ── (c) a mid-operation failure: attributable to the STEP, not to the operation ───────────
    // `linked` fails fast (pipe.ts:335-337), so the download never starts. The trace carries the
    // failing step's `error`/`done` under the shared traceId — but there is no operation-level
    // event: nothing says "the bulk-export operation failed", only "the `poll` stitch failed".
    {
        const clock = manualClock();
        const api = new FakeJobApi({
            clock,
            inProgressPolls: 2,
            terminal: 'Failed',
        });
        const recs: Rec[] = [];
        const trace = recordingSink(recs);
        const submit = stitch({
            name: 'submit',
            url: FakeJobApi.submitUrl,
            method: 'POST',
            adapter: api.adapter(),
            clock,
            trace,
        });
        const poll = stitch({
            name: 'poll',
            url: `${HOST}{+loc}`,
            kind: pollSurface(30_000),
            adapter: api.adapter(),
            clock,
            retry: { attempts: 10 },
            trace,
        });
        const download = stitch({
            name: 'download',
            url: '{+u}',
            adapter: api.adapter(),
            clock,
            trace,
        });
        const flow = linked(async (run) => {
            await run(submit, { body: {} });
            const id = api.jobIds.at(-1)!;
            const status = await run(poll, { params: { loc: `/jobs/${id}` } });
            return run(download, { params: { u: resultUrlOf(status)! } });
        });
        const settled = flow.then(
            () => 'resolved',
            (e: unknown) => `rejected: ${(e as Error).message}`,
        );
        await clock.advance(3_600_000);
        check('(c) the flow', await settled, 'rejected: job failed');

        check(
            '(c) traceIds (the failure is still on the operation’s trace)',
            new Set(recs.map((r) => r.traceId)).size,
            1,
        );
        check(
            '(c) which stitch the `error` event names',
            recs
                .filter((r) => r.type === 'error')
                .map((r) => r.name)
                .join(','),
            'poll',
        );
        check(
            '(c) `start` events (download never ran)',
            recs
                .filter((r) => r.type === 'start')
                .map((r) => r.name)
                .join(','),
            'submit,poll',
        );
        check(
            '(c) `done` events, and whether any reports the OPERATION',
            recs
                .filter((r) => r.type === 'done')
                .map((r) => r.name)
                .join(','),
            'submit,poll',
        );
        check('(c) requests the download made', api.resultFetches.length, 0);
        note(
            '(c) → the trace is one tree, but the operation itself has no span: `linked` emits nothing of its own',
            '',
        );
    }

    // ── (d) the ONE-STITCH construction reports the triangle as a single run ─────────────────
    // C5(a)'s shape: one `start`, one `done`, and the hops are `retry` progress events, so the run
    // report's `attempts` counts them.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 2 });
        const recs: Rec[] = [];
        let next: { url: string; method: string } | undefined;
        const surface: Surface = {
            id: 'async-job',
            interpret: (res) => {
                if (res.status === 202)
                    return {
                        ok: false,
                        retry: true,
                        message: 'accepted',
                        after: 1000,
                    };
                const state = stateOf(res.body);
                if (state === 'InProgress')
                    return {
                        ok: false,
                        retry: true,
                        message: 'InProgress',
                        after: 1000,
                    };
                if (state === 'JobComplete')
                    return {
                        ok: false,
                        retry: true,
                        message: 'downloading',
                        after: 0,
                    };
                return { ok: true, data: res.body };
            },
        };
        const call = stitch({
            name: 'bulk-job',
            url: FakeJobApi.submitUrl,
            method: 'POST',
            kind: surface,
            adapter: api.adapter(),
            clock,
            retry: { attempts: 12 },
            trace: recordingSink(recs),
            hooks: {
                onRequest: (ctx) => {
                    if (ctx.req && next) {
                        ctx.req.url = next.url;
                        ctx.req.method = next.method;
                        ctx.req.body = undefined;
                    }
                },
                onResponse: (ctx) => {
                    const res = ctx.res;
                    if (!res) return;
                    const loc = res.headers['location'];
                    if (loc)
                        next = {
                            url: new URL(loc, HOST).toString(),
                            method: 'GET',
                        };
                    const done = resultUrlOf(res.body);
                    if (done !== undefined) next = { url: done, method: 'GET' };
                },
            },
        });
        const p = call.safe({ body: {} });
        await clock.advance(3_600_000);
        const r = await p;

        check('(d) the call resolved', JSON.stringify(r.data), '{"rows":3}');
        check(
            '(d) `start` events for the whole triangle',
            recs.filter((r) => r.type === 'start').length,
            1,
        );
        check(
            '(d) `done` events',
            recs.filter((r) => r.type === 'done').length,
            1,
        );
        check(
            '(d) distinct spanIds',
            new Set(recs.map((r) => r.spanId)).size,
            1,
        );
        check('(d) requests the one run actually made', api.hits.length, 5);
        note(
            '(d) → the triangle is ONE span with `attempts: 5`; the three endpoints are invisible in the trace',
            '',
        );
    }

    finish(
        'C6',
        'YES — `linked` draws exactly one trace chain: 3 `start` events, 1 traceId, 3 spanIds, `submit → poll → download` with each member’s `parentSpanId` equal to the previous member’s `spanId`, and the three polls folded into the poll span as 3 `request` + 2 `retry` progress events. The same three awaits WITHOUT `run` produce 3 traceIds and 0 parents. A mid-operation failure IS on the operation’s trace (one traceId, the `error` event naming `poll`, the download never started) — but it is attributable to the STEP, not the operation: `linked` emits no span of its own, so nothing in the stream says the bulk-export operation failed. The one-stitch alternative is the opposite trade: 1 start, 1 done, 1 span, `attempts: 5` — and the three endpoints are invisible',
    );
}

void main();
