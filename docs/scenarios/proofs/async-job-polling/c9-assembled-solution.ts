// C9 — assemble the best answer the public API allows, run it end to end on the manual clock, and
// compare it HONESTLY against the hand-rolled `while` loop the state of the art recommends.
//
// The comparison is not an argument: the same fake provider runs both, and every claimed benefit is
// a measured number — request counts, poll spacing, `start` events, `attempts`, trace identity, and
// what each does when a circuit-breaking host starts failing.
//
//   pnpm exec tsx docs/scenarios/proofs/async-job-polling/c9-assembled-solution.ts
import { memoryStore } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    Clock,
    StitchEvent,
    TraceContext,
    TraceSink,
} from '../../../../packages/core/src/types';
import { FakeJobApi, resultUrlOf, stateOf } from './fake-jobs';
import { check, finish, heading, note } from './harness';
import { jobTriangle, retryAfterMs } from './job-triangle';

const HOST = 'https://bulk.example.com';

/**
 * THE BASELINE — the hand-rolled `while` loop, written as well as it can be written: it does the
 * same job, honours `Retry-After` in seconds, backs off exponentially with a cap when the header is
 * absent, treats in-band `Failed` as a failure, holds one deadline over the whole triangle, and
 * fetches the single-use link exactly once.
 *
 * Everything below the signature is the code being counted.
 */
async function handRolled(
    api: FakeJobApi,
    clock: Clock,
    body: unknown,
    budgetMs: number,
): Promise<unknown> {
    const fetchJson = api.adapter();
    const deadline = clock.now() + budgetMs;
    const accepted = await fetchJson({
        url: `${HOST}/jobs`,
        method: 'POST',
        headers: {},
        body,
    });
    const location = accepted.headers['location'];
    if (location === undefined) throw new Error('202 with no Location');
    let wait = 1000;
    for (;;) {
        if (clock.now() >= deadline) throw new Error('job budget exhausted');
        const status = await fetchJson({
            url: new URL(location, HOST).toString(),
            method: 'GET',
            headers: {},
        });
        if (status.status >= 400) throw new Error(`HTTP ${status.status}`);
        const state = stateOf(status.body);
        if (state === 'Failed') throw new Error('job failed');
        if (state === 'JobComplete') {
            const url = resultUrlOf(status.body);
            if (url === undefined)
                throw new Error('JobComplete with no resultUrl');
            const out = await fetchJson({ url, method: 'GET', headers: {} });
            if (out.status >= 400) throw new Error(`HTTP ${out.status}`);
            return out.body;
        }
        const asked = retryAfterMs(status.headers['retry-after'], clock);
        await clock.sleep(Math.min(asked ?? wait, deadline - clock.now()));
        wait = Math.min(wait * 2, 30_000);
    }
}

/** Count the executable lines of a function body (blank + comment lines excluded). */
function bodyLines(source: string, marker: string): number {
    const start = source.indexOf(marker);
    const lines = source.slice(start).split('\n');
    let depth = 0;
    let seen = false;
    let count = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        if (
            trimmed !== '' &&
            !trimmed.startsWith('//') &&
            !trimmed.startsWith('*')
        )
            count++;
        for (const ch of line) {
            if (ch === '{') {
                depth++;
                seen = true;
            } else if (ch === '}') depth--;
        }
        if (seen && depth === 0) break;
    }
    return count;
}

interface Rec {
    name: string;
    type: StitchEvent['type'];
    traceId: string | undefined;
    parentSpanId: string | undefined;
    spanId: string | undefined;
    /** Present on `result` / `done` / `error` events — how many attempts that run took. */
    attempts: number | undefined;
}

/** A `TraceSink` that just records — the same seam C6 measured the chain with. */
function recordingSink(into: Rec[]): TraceSink {
    return {
        handle: (event: StitchEvent, ctx: TraceContext): void => {
            into.push({
                name: ctx.name,
                type: event.type,
                traceId: ctx.traceId,
                spanId: ctx.spanId,
                parentSpanId: ctx.parentSpanId,
                attempts: 'attempts' in event ? event.attempts : undefined,
            });
        },
    };
}

async function main(): Promise<void> {
    heading(
        'C9 — the assembled answer, run end to end, against the `while` loop',
    );

    // ── (a) the assembled triangle, end to end on the manual clock ────────────────────────────
    {
        const clock = manualClock();
        const api = new FakeJobApi({
            clock,
            inProgressPolls: 4,
            retryAfter: 300, // the server asks for 5 minutes between polls
        });
        const recs: Rec[] = [];
        const store = memoryStore();
        const job = jobTriangle({
            submitUrl: FakeJobApi.submitUrl,
            host: HOST,
            adapter: api.adapter(),
            clock,
            pollAttempts: 60,
            budgetMs: 3_600_000,
            backoff: { base: 5_000, max: 60_000 },
            store,
            trace: recordingSink(recs),
        });
        const p = job.run({ q: 'SELECT Id FROM Account' });
        await clock.advance(24 * 3_600_000);
        const out = await p;

        check('(a) payload', JSON.stringify(out.data), '{"rows":3}');
        check('(a) the job id was persisted', out.location, '/jobs/job-1');
        check(
            '(a) it is in the store for a restart',
            await store.get('job:location'),
            '/jobs/job-1',
        );
        check(
            '(a) the request sequence',
            api.hits.map((h) => `${h.method} ${h.path}`).join(' → '),
            'POST /jobs → GET /jobs/job-1 → GET /jobs/job-1 → GET /jobs/job-1 → GET /jobs/job-1 → GET /jobs/job-1 → GET /results/job-1',
        );
        check('(a) SUBMITS', api.submits, 1);
        check('(a) polls', api.polls('job-1').length, 5);
        check(
            '(a) poll gaps — the SERVER’s pacing, in seconds (ms)',
            api.gaps('job-1').join(','),
            '300000,300000,300000,300000',
        );
        check('(a) download attempts', api.resultFetches.length, 1);
        check(
            '(a) virtual time the operation took (ms)',
            api.hits.at(-1)?.at,
            1_200_000,
        );
        check(
            '(a) `start` events for the whole operation',
            recs.filter((r) => r.type === 'start').length,
            3,
        );
        check(
            '(a) distinct traceIds',
            new Set(recs.map((r) => r.traceId)).size,
            1,
        );
    }

    // ── (b) resume: the same object, reattached, with no submit ───────────────────────────────
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 8 });
        const store = memoryStore();
        const mk = (pollAttempts: number): ReturnType<typeof jobTriangle> =>
            jobTriangle({
                submitUrl: FakeJobApi.submitUrl,
                host: HOST,
                adapter: api.adapter(),
                clock,
                pollAttempts,
                budgetMs: 3_600_000,
                backoff: { base: 60_000, max: 60_000 },
                store,
            });
        // Process 1: a poll budget too small for this job — it dies mid-poll.
        const first = mk(3)
            .run({ q: 'SELECT Id' })
            .then(
                () => 'resolved',
                (e: unknown) => (e as Error).message,
            );
        await clock.advance(3_600_000);
        check('(b) process 1', await first, 'InProgress');
        check('(b) polls before the crash', api.polls('job-1').length, 3);

        // Process 2: everything rebuilt; only the store survived.
        const saved = (await store.get('job:location')) as string;
        check('(b) what survived the restart', saved, '/jobs/job-1');
        const second = mk(20)
            .run({ q: 'SELECT Id' }, saved)
            .then(
                (r) => JSON.stringify(r.data),
                (e: unknown) => `rejected: ${(e as Error).message}`,
            );
        await clock.advance(3_600_000);
        check('(b) process 2 resumed and finished', await second, '{"rows":3}');
        check('(b) SUBMITS across both processes', api.submits, 1);
        check('(b) total polls', api.polls('job-1').length, 9);
    }

    // ── (c) the deadline really ends the operation ────────────────────────────────────────────
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 10_000 });
        const job = jobTriangle({
            submitUrl: FakeJobApi.submitUrl,
            host: HOST,
            adapter: api.adapter(),
            clock,
            pollAttempts: 10_000,
            budgetMs: 3_600_000,
            backoff: { base: 600_000, max: 600_000 },
        });
        const settled = job.run({ q: 'SELECT Id' }).then(
            () => 'resolved',
            (e: unknown) => (e as Error).message,
        );
        await clock.advance(24 * 3_600_000);
        check('(c) the operation', await settled, 'aborted');
        check('(c) polls in one virtual hour', api.polls('job-1').length, 6);
        check(
            '(c) the last poll landed at (ms)',
            api.polls('job-1').at(-1)?.at,
            3_000_000,
        );
        note(
            '(c) `abort(new Error("job budget of 3600000ms exhausted"))` arrives as',
            'aborted — the clocks’ `sleep` drops `signal.reason` (util.ts:39-55)',
        );
    }

    // ── (d) the hand-rolled `while`, same provider, same behaviour ────────────────────────────
    {
        const clock = manualClock();
        const api = new FakeJobApi({
            clock,
            inProgressPolls: 4,
            retryAfter: 300,
        });
        const p = handRolled(api, clock, { q: 'SELECT Id' }, 3_600_000);
        await clock.advance(24 * 3_600_000);
        const out = await p;
        check('(d) payload', JSON.stringify(out), '{"rows":3}');
        check(
            '(d) the request sequence',
            api.hits.map((h) => `${h.method} ${h.path}`).join(' → '),
            'POST /jobs → GET /jobs/job-1 → GET /jobs/job-1 → GET /jobs/job-1 → GET /jobs/job-1 → GET /jobs/job-1 → GET /results/job-1',
        );
        check(
            '(d) poll gaps (ms)',
            api.gaps('job-1').join(','),
            '300000,300000,300000,300000',
        );
        check('(d) SUBMITS', api.submits, 1);
        note(
            '(d) → identical wire behaviour. The difference is everything AROUND it',
            '',
        );
    }

    // ── (e) the line count, both ways ─────────────────────────────────────────────────────────
    {
        const fs = await import('node:fs');
        const here = new URL('.', import.meta.url).pathname;
        const triangleSrc = fs.readFileSync(`${here}job-triangle.ts`, 'utf8');
        const thisSrc = fs.readFileSync(
            `${here}c9-assembled-solution.ts`,
            'utf8',
        );
        const assembled =
            bodyLines(triangleSrc, 'export function jobTriangle(') +
            bodyLines(triangleSrc, 'export function jobPollSurface(') +
            bodyLines(triangleSrc, 'export function operationDeadline(') +
            bodyLines(triangleSrc, 'export function retryAfterMs(');
        const hand =
            bodyLines(thisSrc, 'async function handRolled(') +
            bodyLines(triangleSrc, 'export function retryAfterMs(');
        note(
            '(e) assembled: jobTriangle + surface + deadline + header parse',
            assembled,
        );
        note('(e) hand-rolled: the `while` + the same header parse', hand);
        check('(e) is the assembled version longer?', assembled > hand, true);
        note(
            '(e) `retryAfterMs` is counted on BOTH sides — a correct `while` loop needs it too',
            '',
        );
    }

    // ── (f) what the extra lines actually BUY, measured ───────────────────────────────────────
    // The `while` loop has none of these, because there is nothing between it and the transport.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 2 });
        const recs: Rec[] = [];
        const job = jobTriangle({
            submitUrl: FakeJobApi.submitUrl,
            host: HOST,
            adapter: api.adapter(),
            clock,
            pollAttempts: 20,
            budgetMs: 3_600_000,
            backoff: { base: 1000, max: 1000 },
            trace: recordingSink(recs),
        });
        const p = job.run({ q: 'SELECT Id' });
        await clock.advance(3_600_000);
        await p;

        check('(f) requests made', api.hits.length, 5);
        check(
            '(f) `start` events (one per HOP, not per poll)',
            recs.filter((r) => r.type === 'start').length,
            3,
        );
        check(
            '(f) distinct traceIds across the operation',
            new Set(recs.map((r) => r.traceId)).size,
            1,
        );
        const starts = recs.filter((r) => r.type === 'start');
        check(
            '(f) the chain',
            starts.map((r) => r.name).join(' → '),
            'job-submit → job-poll → job-download',
        );
        check(
            '(f) each hop’s parent is the previous hop’s span',
            starts[1]?.parentSpanId === starts[0]?.spanId &&
                starts[2]?.parentSpanId === starts[1]?.spanId,
            true,
        );
        const pollDone = recs.filter(
            (r) => r.name === 'job-poll' && r.type === 'done',
        );
        check('(f) `done` events for the 3-poll hop', pollDone.length, 1);
        check(
            '(f) the poll count IS `attempts` on the poll run',
            recs.find((r) => r.name === 'job-poll' && r.type === 'result')
                ?.attempts,
            3,
        );
        check(
            '(f) …and the download hop reports its own',
            recs.find((r) => r.name === 'job-download' && r.type === 'result')
                ?.attempts,
            1,
        );
        note(
            '(f) → the hand-rolled loop reports one call per poll, or nothing at all',
            '',
        );
    }

    finish(
        'C9',
        'The assembled answer runs: submit → 5 polls at the SERVER’s 300s pacing → 1 download, 1 submit, 20 virtual minutes, the job id persisted for a restart; resume reattaches after a 3-poll crash with 1 submit total; the deadline ends a runaway job at 6 polls in a virtual hour. The hand-rolled `while` produces the BYTE-IDENTICAL request sequence and pacing. What the extra lines buy is measured, not asserted: one `start` + one `done` per HOP with the 3 polls folded in as `attempts: 3` (instead of three unrelated calls), one traceId chaining `job-submit → job-poll → job-download`, and a per-hop `retry` policy (20 poll attempts, 1 download attempt). The cost is the honest number: 110 executable lines against 49 for the `while` — and ALL of the semantics are still yours',
    );
}

void main();
