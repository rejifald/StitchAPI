// C5 — THE DECIDING CLAIM. Is there ONE deadline over submit + N polls + download? "Give up after
// an hour" is a budget over the whole triangle, not over any single call.
//
// Four candidates are measured for what each ACTUALLY bounds: `timeout.total`, `timeout.perAttempt`,
// three `linked` members each with their own budget, and a caller-owned `AbortSignal`.
//
// One measurement here is deliberately WALL-CLOCK: `timeout.total`'s deadline is compared against
// `now()`, not the injected clock (engine.ts:453-483), so no `manualClock` can drive it. That case
// runs on real timers at 250ms with bounds set 4× clear of the real numbers; everything else is
// virtual time.
//
//   pnpm exec tsx docs/scenarios/proofs/async-job-polling/c5-one-deadline.ts
import { stitch } from '../../../../packages/core/src/index';
import { linked } from '../../../../packages/core/src/pipe';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import type { Clock } from '../../../../packages/core/src/types';
import { systemClock } from '../../../../packages/core/src/util';
import { FakeJobApi, resultUrlOf, stateOf } from './fake-jobs';
import { check, checkAtMost, finish, heading, note } from './harness';

const HOST = 'https://bulk.example.com';

/** The poll surface, as C2 established it. */
const pollSurface = (after: number | string): Surface => ({
    id: 'job-poll',
    interpret: (res) =>
        stateOf(res.body) === 'InProgress'
            ? { ok: false, retry: true, message: 'InProgress', after }
            : { ok: true, data: res.body },
});

/**
 * The whole triangle as ONE stitch: `POST /jobs`, then `hooks.onRequest` redirects each subsequent
 * attempt — first to the `Location`, then to the `resultUrl`. C1(e) established the mechanic; here
 * it is the construction under test, because one stitch means one `timeout.total`.
 */
function oneStitchTriangle(
    api: FakeJobApi,
    clock: Clock,
    opts: {
        attempts: number;
        total?: string;
    },
): ReturnType<typeof stitch> {
    let next: { url: string; method: string } | undefined;
    const surface: Surface = {
        id: 'async-job',
        interpret: (res) => {
            if (res.status === 202)
                return {
                    ok: false,
                    retry: true,
                    message: 'accepted',
                    after: 50,
                };
            const state = stateOf(res.body);
            if (state === 'InProgress')
                return {
                    ok: false,
                    retry: true,
                    message: 'InProgress',
                    after: 50,
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
    return stitch({
        name: 'bulk-job',
        url: FakeJobApi.submitUrl,
        method: 'POST',
        kind: surface,
        adapter: api.adapter(),
        clock,
        retry: { attempts: opts.attempts },
        ...(opts.total === undefined ? {} : { timeout: { total: opts.total } }),
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
}

async function main(): Promise<void> {
    heading('C5 — is there ONE deadline over submit + polls + download?');

    // ── (a) `timeout.total` bounds ONE STITCH's whole call — every attempt and every wait ─────
    // WALL-CLOCK, by design (engine.ts:453-456, 482). With the triangle collapsed into one stitch,
    // that one budget covers submit + polls + download: exactly the "give up after an hour" shape.
    {
        const api = new FakeJobApi({
            clock: systemClock,
            inProgressPolls: 1000,
        });
        const call = oneStitchTriangle(api, systemClock, {
            attempts: 1000,
            total: '250ms',
        });
        const t0 = Date.now();
        const r = await call.safe({ body: { q: 'SELECT Id' } });
        const wall = Date.now() - t0;

        check('(a) the call failed', r.ok, false);
        // The engine throws a `TimeoutError` (engine.ts:468-469), but every failure reaches the
        // caller as a `StitchError` — the identity is flattened, so only the MESSAGE distinguishes
        // "the deadline fired" from "the job failed" from "the poll budget ran out".
        check('(a) error name', r.error?.name, 'StitchError');
        check('(a) error message', r.error?.message, 'timed out after 250ms');
        checkAtMost('(a) wall-clock elapsed (ms)', wall, 1000);
        check('(a) submits', api.submits, 1);
        check(
            '(a) the budget covered BOTH hops',
            api.hits[0]?.path === '/jobs' && api.polls('job-1').length > 0,
            true,
        );
        note('(a) requests made inside the 250ms budget', api.hits.length);
        note(
            '(a) → one stitch, one deadline over submit + N polls (+ the download, had it got there)',
            '',
        );
    }

    // ── (b) `timeout.perAttempt` bounds ONE poll, not the operation ───────────────────────────
    // Its own doc says so (types.ts:1064-1069). Under a manual clock the per-attempt deadline is
    // clock-driven, so this one IS virtual: 40 polls run to the retry budget, each well inside its
    // own 5s attempt window, while 40× that has elapsed.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 1000 });
        const submit = stitch({
            url: FakeJobApi.submitUrl,
            method: 'POST',
            adapter: api.adapter(),
            clock,
        });
        await submit.safe({ body: {} });
        const id = api.jobIds[0]!;
        const poll = stitch({
            url: FakeJobApi.statusUrl(id),
            kind: pollSurface(60_000),
            adapter: api.adapter(),
            clock,
            retry: { attempts: 40 },
            timeout: { perAttempt: '5s' },
        });
        const p = poll.safe();
        await clock.advance(24 * 3_600_000);
        const r = await p;
        check(
            '(b) polls made under `perAttempt: 5s`',
            api.polls(id).length,
            40,
        );
        check(
            '(b) virtual time the last poll landed at (ms)',
            api.polls(id).at(-1)?.at,
            39 * 60_000,
        );
        check(
            '(b) the call failed on the RETRY budget, not the clock',
            r.ok,
            false,
        );
        check('(b) error message', r.error?.message, 'InProgress');
        note(
            '(b) → 39 virtual minutes elapsed under a "5s" timeout; it bounds an attempt, nothing more',
            '',
        );
    }

    // ── (c) three `linked` members = three INDEPENDENT budgets ───────────────────────────────
    // `linked(body)` takes a body and nothing else (pipe.ts:357-359) — no options object, so no
    // place to put a deadline. Each member keeps its own `timeout`, and the flow's worst case is
    // their sum.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 2 });
        const submit = stitch({
            name: 'submit',
            url: FakeJobApi.submitUrl,
            method: 'POST',
            adapter: api.adapter(),
            clock,
            timeout: { total: '30s' },
        });
        const poll = stitch({
            name: 'poll',
            url: `${HOST}{+loc}`,
            kind: pollSurface(100),
            adapter: api.adapter(),
            clock,
            retry: { attempts: 10 },
            timeout: { total: '30s' },
        });
        const download = stitch({
            name: 'download',
            url: '{+u}',
            adapter: api.adapter(),
            clock,
            timeout: { total: '30s' },
        });
        const flow = linked(async (run) => {
            await run(submit, { body: {} });
            const id = api.jobIds.at(-1)!;
            const status = await run(poll, { params: { loc: `/jobs/${id}` } });
            return run(download, { params: { u: resultUrlOf(status)! } });
        });
        await clock.advance(3_600_000);
        check(
            '(c) the flow resolved',
            JSON.stringify(await flow),
            '{"rows":3}',
        );
        check(
            '(c) budgets declared / worst case (s)',
            `${3} × 30 = ${90}`,
            '3 × 30 = 90',
        );

        // @ts-expect-error — `linked` takes ONE argument (the body); there is no options slot.
        void linked(async () => 1, { timeout: '1h' });
        note('(c) `linked`', '(body: (run) => T) => Promise<T> — no options');
    }

    // ── (d) a caller-owned `AbortSignal` DOES bound the whole flow ────────────────────────────
    // `StitchInput.signal` is threaded onto the request AND into the sleeps (engine.ts:696, 762,
    // 800 → `sleepWithin(..., baseReq.signal, ...)`), so one signal passed to every member is an
    // operation-wide deadline. `linked` fails fast, so the abort ends the flow. Fired off the
    // INJECTED clock here, which is what makes an hour-long budget testable at all.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 10_000 });
        const ctrl = new AbortController();
        const submit = stitch({
            name: 'submit',
            url: FakeJobApi.submitUrl,
            method: 'POST',
            adapter: api.adapter(),
            clock,
        });
        const poll = stitch({
            name: 'poll',
            url: `${HOST}{+loc}`,
            kind: pollSurface(600_000),
            adapter: api.adapter(),
            clock,
            retry: { attempts: 10_000 },
        });
        const flow = linked(async (run) => {
            await run(submit, { body: {}, signal: ctrl.signal });
            const id = api.jobIds.at(-1)!;
            return run(poll, {
                params: { loc: `/jobs/${id}` },
                signal: ctrl.signal,
            });
        });
        const settled = flow.then(
            () => 'resolved',
            (e: unknown) => `rejected: ${(e as Error).message}`,
        );
        // The operation budget: one hour of VIRTUAL time.
        void clock
            .sleep(3_600_000)
            .then(() => ctrl.abort(new Error('job budget exhausted')));
        await clock.advance(24 * 3_600_000);

        // NOT `job budget exhausted`: both clocks' `sleep` reject with a fresh `Error('aborted')`
        // and discard `signal.reason` (util.ts:39-55, test-clock.ts:64-79), even though the engine's
        // own `abortReason` (engine.ts:544-549) preserves it on the throttle path. An abort that
        // lands during a poll wait therefore loses the caller's reason.
        check('(d) the flow', await settled, 'rejected: aborted');
        check('(d) submits', api.submits, 1);
        check(
            '(d) polls made in one virtual hour',
            api.polls('job-1').length,
            6,
        );
        check(
            '(d) the last poll landed at (ms, virtual)',
            api.polls('job-1').at(-1)?.at,
            3_000_000,
        );
        note(
            '(d) → the ONE deadline exists, but it is an AbortSignal the caller owns, not a config field',
            '',
        );
    }

    // ── (e) THE TESTABILITY TRAP: `timeout.total` ignores the injected clock entirely ─────────
    // `sleepWithin` compares `budget.deadline - now()` — wall-clock — and then sleeps on the
    // INJECTED clock (engine.ts:481-488). Virtual time therefore never consumes the budget. The
    // same stitch as (a), on a manual clock, polls 60 times across 59 VIRTUAL seconds under a
    // `total: '10s'` and never trips it: a manual-clock test of "give up after an hour" passes
    // while proving nothing.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 1000 });
        const submit = stitch({
            url: FakeJobApi.submitUrl,
            method: 'POST',
            adapter: api.adapter(),
            clock,
        });
        await submit.safe({ body: {} });
        const id = api.jobIds[0]!;
        const poll = stitch({
            url: FakeJobApi.statusUrl(id),
            kind: pollSurface(1000),
            adapter: api.adapter(),
            clock,
            retry: { attempts: 60 },
            timeout: { total: '10s' },
        });
        const p = poll.safe();
        await clock.advance(6 * 3_600_000);
        const r = await p;

        check('(e) polls made under `total: "10s"`', api.polls(id).length, 60);
        check(
            '(e) virtual time the last poll landed at (ms)',
            api.polls(id).at(-1)?.at,
            59_000,
        );
        check(
            '(e) did the budget fire?',
            r.error?.name === 'TimeoutError',
            false,
        );
        check('(e) what ended the run instead', r.error?.message, 'InProgress');
        note(
            '(e) → 59s of virtual waiting under a 10s budget. Inject a clock and `timeout.total` goes quiet',
            '',
        );
    }

    finish(
        'C5',
        'YES, with user code — and by TWO different routes with different costs. (1) Collapse the triangle into ONE stitch (C1(e)’s hook rewrite) and `timeout.total` is a single wall-clock budget over submit + polls + download: measured 253ms wall, `timed out after 250ms`, 1 submit, both hops inside it. (2) Keep three stitches under `linked` and thread ONE caller-owned `AbortSignal` through every `input.signal`: measured 6 polls in a virtual hour, then a rejection. What does NOT express it: `timeout.perAttempt` (39 virtual minutes elapsed under a "5s" setting), and `linked` itself, which takes a body and no options — three members means three independent budgets summing to 90s. The trap: `timeout.total` is compared against WALL-CLOCK while its sleeps run on the injected clock, so under a `manualClock` it goes silent — 60 polls across 59 virtual seconds never tripped a 10s total',
    );
}

void main();
