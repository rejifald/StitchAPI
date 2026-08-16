// C2 — can a custom `Surface` express the poll loop? `interpret` reads `state`: `InProgress` →
// `{ ok: false, retry: true, after }`, `JobComplete` → `{ ok: true }`, `Failed` → a real failure
// that does NOT retry. Every one of those arrives at HTTP 200, so nothing status-driven can tell
// them apart.
//
// Measured: the poll count, the gaps between polls on the injected clock, that `Failed` stops the
// loop dead, and what the caller is handed when the poll budget runs out first.
//
//   pnpm exec tsx docs/scenarios/proofs/async-job-polling/c2-poll-surface.ts
import { stitch } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import { verdictOf } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    AdapterResponse,
    Clock,
    ResolvedStitchConfig,
    StitchEvent,
} from '../../../../packages/core/src/types';
import { FakeJobApi, errorMessageOf, stateOf } from './fake-jobs';
import { check, finish, heading, note } from './harness';

/** The poll loop, as a surface. `after` fixed so the gaps are exact virtual time. */
const pollSurface = (after: number): Surface => ({
    id: 'job-poll',
    interpret: (res, cfg) => {
        const failed = verdictOf(res, cfg);
        if (failed) return failed;
        const state = stateOf(res.body);
        if (state === 'InProgress')
            return { ok: false, retry: true, message: 'InProgress', after };
        if (state === 'Failed')
            return {
                ok: false,
                message: `job failed: ${errorMessageOf(res.body)}`,
                status: res.status,
            };
        return { ok: true, data: res.body };
    },
});

/** Submit a job through a plain stitch and hand back its id. */
async function submitJob(api: FakeJobApi, clock: Clock): Promise<string> {
    const submit = stitch({
        url: FakeJobApi.submitUrl,
        method: 'POST',
        adapter: api.adapter(),
        clock,
    });
    await submit.safe({ body: {} });
    return api.jobIds.at(-1)!;
}

async function main(): Promise<void> {
    heading('C2 — can a `Surface` express the poll loop?');

    // ── (a) InProgress → retry, JobComplete → done ────────────────────────────────────────────
    // The body-aware retry arm (surface.ts:36, engine.ts:775-806) re-enters the attempt loop, so
    // "not done yet" IS a retry — and `retry.attempts` is the poll bound.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 4 });
        const id = await submitJob(api, clock);
        const poll = stitch({
            url: FakeJobApi.statusUrl(id),
            kind: pollSurface(30_000),
            adapter: api.adapter(),
            clock,
            retry: { attempts: 10 },
        });
        const evts: StitchEvent[] = [];
        const consume = (async (): Promise<void> => {
            for await (const e of poll.stream()) evts.push(e);
        })();
        await clock.advance(3_600_000);
        await consume;

        check('(a) polls made', api.polls(id).length, 5);
        check(
            '(a) gaps between polls (ms, virtual)',
            api.gaps(id).join(','),
            '30000,30000,30000,30000',
        );
        const result = evts.find((e) => e.type === 'result');
        check(
            '(a) terminal state returned',
            stateOf(result && 'data' in result ? result.data : undefined),
            'JobComplete' as const,
        );
        check(
            '(a) attempts the engine reported',
            result && 'attempts' in result ? result.attempts : undefined,
            5,
        );
        check(
            '(a) `retry` progress events (one per re-poll)',
            evts.filter((e) => e.type === 'progress' && e.phase === 'retry')
                .length,
            4,
        );
        const firstRetry = evts.find(
            (e) => e.type === 'progress' && e.phase === 'retry',
        );
        check(
            '(a) the retry detail names the BODY, not a status',
            firstRetry?.type === 'progress' ? firstRetry.detail : undefined,
            'interpret: InProgress',
        );
        note(
            '(a) virtual time the last poll landed at (ms)',
            api.polls(id).at(-1)?.at,
        );
    }

    // ── (b) `Failed` is a real failure and does NOT retry ─────────────────────────────────────
    // The third arm of `SurfaceOutcome` (no `retry` key) falls through to the ordinary failure
    // handling. Measured: the loop stops on the FIRST Failed body with poll budget still unspent.
    {
        const clock = manualClock();
        const api = new FakeJobApi({
            clock,
            inProgressPolls: 2,
            terminal: 'Failed',
        });
        const id = await submitJob(api, clock);
        const poll = stitch({
            url: FakeJobApi.statusUrl(id),
            kind: pollSurface(30_000),
            adapter: api.adapter(),
            clock,
            retry: { attempts: 20 },
        });
        const p = poll.safe();
        await clock.advance(3_600_000);
        const r = await p;

        check(
            '(b) polls made (2 InProgress + 1 Failed)',
            api.polls(id).length,
            3,
        );
        check('(b) the call failed', r.ok, false);
        check(
            '(b) error message',
            r.error?.message,
            'job failed: InvalidBatch : Field name not found',
        );
        check('(b) poll budget left unspent', 20 - api.polls(id).length, 17);
        check(
            '(b) virtual time the terminal poll landed at (ms)',
            api.polls(id).at(-1)?.at,
            60_000,
        );
    }

    // ── (c) running out of poll budget is NOT distinguishable from a job failure ──────────────
    // Both arrive as a plain `StitchError` whose `message` is whatever the surface said. There is
    // no "still running when I gave up" error type, and `status` is undefined on both.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock, inProgressPolls: 50 });
        const id = await submitJob(api, clock);
        const poll = stitch({
            url: FakeJobApi.statusUrl(id),
            kind: pollSurface(1000),
            adapter: api.adapter(),
            clock,
            retry: { attempts: 3 },
        });
        const p = poll.safe();
        await clock.advance(3_600_000);
        const r = await p;

        check('(c) polls made', api.polls(id).length, 3);
        check('(c) the call failed', r.ok, false);
        check('(c) error name', r.error?.name, 'StitchError');
        check('(c) error message', r.error?.message, 'InProgress');
        check(
            '(c) error status',
            (r.error as { status?: number } | undefined)?.status,
            undefined,
        );
        note(
            '(c) → "the job is still running" and "the job failed" differ only by the string the surface chose',
            '',
        );
    }

    // ── (d) `interpret` is not told which attempt it is on ────────────────────────────────────
    // `(res, cfg)` — surface.ts:61-64. A surface cannot vary its wait by poll number, cap the poll
    // count itself, or know it is on the last one.
    {
        const threeArg: Surface = {
            id: 'x',
            // @ts-expect-error — `interpret` takes (res, cfg); there is no attempt argument.
            interpret: (
                res: AdapterResponse,
                _cfg: ResolvedStitchConfig,
                _attempt: number,
            ) => ({ ok: true as const, data: res.body }),
        };
        void threeArg;
        note('(d) `Surface.interpret`', '(res, cfg) => SurfaceOutcome');
    }

    // ── (e) a surface that skips `verdictOf` turns HTTP errors into successes ─────────────────
    // `interpret` REPLACES the default rather than layering on it (surface.ts:174-178). Omit the
    // composition and a 404 comes back `ok: true` with the error page as the value.
    {
        const clock = manualClock();
        const api = new FakeJobApi({ clock });
        const naive: Surface = {
            id: 'naive',
            interpret: (res) =>
                stateOf(res.body) === 'InProgress'
                    ? {
                          ok: false,
                          retry: true,
                          message: 'InProgress',
                          after: 1,
                      }
                    : { ok: true, data: res.body },
        };
        const gone = 'https://bulk.example.com/jobs/job-does-not-exist';
        const bad = stitch({
            url: gone,
            kind: naive,
            adapter: api.adapter(),
            clock,
        });
        const rb = await bad.safe();
        check('(e) naive surface, HTTP 404 → ok', rb.ok, true);
        check(
            '(e) naive surface, the value handed back',
            JSON.stringify(rb.data),
            '{"message":"unknown job job-does-not-exist"}',
        );
        const good = stitch({
            url: gone,
            kind: pollSurface(1),
            adapter: api.adapter(),
            clock,
        });
        const rg = await good.safe();
        check('(e) `verdictOf`-composed surface, HTTP 404 → ok', rg.ok, false);
        check('(e) …error message', rg.error?.message, 'HTTP 404');
    }

    finish(
        'C2',
        'YES — a `Surface` expresses the whole poll loop. `InProgress` → `{ ok: false, retry: true, after }` polled 5 times at exactly 30s virtual spacing and returned the `JobComplete` body with `attempts: 5`; `Failed` stopped on the first terminal body (3 polls) with 17 of 20 poll attempts unspent. Two costs: the surface must compose `verdictOf` or a 404 comes back as a SUCCESS, and "I gave up waiting" is a plain `StitchError` carrying the surface’s own string — indistinguishable in type from the job having failed',
    );
}

void main();
