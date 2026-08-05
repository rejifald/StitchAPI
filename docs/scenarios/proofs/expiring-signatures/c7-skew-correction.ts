// C7 — clock-skew correction. AWS's own SDKs read the server's `Date` off a skew failure, store the
// offset, and re-sign with a corrected clock. Is there any seam in StitchAPI that can do that?
//
// MEASURED: yes, and it is the seam the library already has for exactly this SHAPE of problem —
// `AuthStrategy.shouldRefresh` / `refresh` (types.ts:1273-1274, engine.ts:707-725). It was built for
// "the token expired, get a new one and redo this attempt", and a stale clock is the same story with
// a different noun. A drifting host measured: attempt 1 → 403 RequestTimeTooSkewed, the offset
// learned from the response's `Date` header, the attempt REDONE with a corrected clock, 200. One
// call, no retry budget spent.
//
// Three things about it are worth knowing before relying on it, and all three are measured here:
//
//   • `refresh(ctx)` does NOT receive the response. `shouldRefresh(res)` is the only auth hook that
//     sees it, so the `Date` header has to be smuggled from one to the other through a closure.
//   • It fires ONCE per run (the `refreshed` latch, engine.ts:615,709). Correct for this job — a
//     second failure after correcting is a real failure — but it is a latch, not a policy.
//   • The redone attempt does NOT count against `retry.attempts` (`attempt--`, engine.ts:723), and
//     it DOES re-acquire the throttle, so a corrected re-sign pays a second rate slot.
//
// Part (d) measures the alternative and finds it worse: `hooks.onResponse` also sees the response,
// but a hook cannot ask for another attempt — so correcting there requires putting 403 into
// `retry.on`, which is the thing C6 (b) showed you should not do.
//
//   pnpm exec tsx docs/scenarios/proofs/expiring-signatures/c7-skew-correction.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    AdapterResponse,
    AuthStrategy,
    Clock,
} from '../../../../packages/core/src/types';
import { FakeAws, isSkewError, outcomeOf } from './fake-aws';
import { check, checkSeq, finish, heading, note } from './harness';
import type { SkewOffset } from './signers';
import { CREDS, clockSigV4 } from './signers';
import { drain, runOut } from './virtual-time';

const URL_S3 = 'https://bucket.s3.us-east-1.amazonaws.com/key';
const T0 = Date.UTC(2026, 7, 5, 12, 0, 0);
const MIN = 60_000;
const DRIFT = 10 * MIN;

/**
 * SigV4 signing that corrects itself from the server's clock — the AWS-SDK mitigation, as an
 * `AuthStrategy`.
 *
 * `apply` is `clockSigV4` (which reads `offset.ms` before stamping). The correction is the two hooks
 * below it: `shouldRefresh` recognises a skew failure AND stashes the response, `refresh` reads the
 * `Date` header off the stashed response and writes the offset. The stash exists only because
 * `refresh(ctx)` is handed an `AuthContext` and nothing else.
 *
 * `offset` is passed in rather than owned so a caller can share ONE correction across many stitches
 * — which is what you want, since the drift is a property of the host, not of the endpoint.
 */
function selfCorrectingSigV4(
    opts: { clock: Clock; offset: SkewOffset },
    log: { corrections: number[] },
): AuthStrategy {
    const inner = clockSigV4({
        ...CREDS,
        clock: opts.clock,
        offset: opts.offset,
    });
    let lastSkewResponse: AdapterResponse | undefined;
    return {
        name: 'selfCorrectingSigV4',
        apply: inner.apply,
        shouldRefresh: (res) => {
            const skewed = res.status === 403 && isSkewError(res.body);
            if (skewed) lastSkewResponse = res;
            return skewed;
        },
        refresh: () => {
            const serverDate = Date.parse(
                lastSkewResponse?.headers['date'] ?? '',
            );
            if (Number.isNaN(serverDate)) return;
            opts.offset.ms = serverDate - opts.clock.now();
            log.corrections.push(opts.offset.ms);
        },
    };
}

async function main(): Promise<void> {
    heading(
        'C7 — can anything read the server’s `Date` on a failure and re-sign with a corrected clock?',
    );

    // ── (a) the seam, end to end ────────────────────────────────────────────────────────────
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, skewMs: DRIFT });
        const offset: SkewOffset = { ms: 0 };
        const log = { corrections: [] as number[] };
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: selfCorrectingSigV4({ clock, offset }, log),
            clock,
        });

        const pending = outcomeOf(() => call({}));
        await runOut(clock, MIN, 1_000);
        const outcome = await pending;

        check(
            '(a) the call SUCCEEDED despite a 10-minute host drift',
            outcome,
            'ok',
        );
        check('(a) requests that reached the wire', aws.calls.length, 2);
        checkSeq(
            '(a) status per request — the skew failure, then the corrected re-sign',
            aws.calls.map((c) => c.status),
            [403, 200],
        );
        checkSeq(
            '(a) the skew the server measured, per request (ms)',
            aws.calls.map((c) => c.skewMs),
            [DRIFT, 0],
        );
        checkSeq('(a) corrections learned (ms)', log.corrections, [DRIFT]);
        note(
            '(a) where the offset came from',
            'the `Date` header on the 403 — the only place the server tells you its time',
        );
    }

    // ── (b) what it costs against the retry budget ──────────────────────────────────────────
    // `attempt--` (engine.ts:723) means the corrected re-sign is FREE: a stitch with `attempts: 1`
    // still gets its second request. That is the difference between this seam and `retry.on`.
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, skewMs: DRIFT });
        const offset: SkewOffset = { ms: 0 };
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: selfCorrectingSigV4({ clock, offset }, { corrections: [] }),
            retry: { attempts: 1 },
            clock,
        });

        const pending = outcomeOf(() => call({}));
        await runOut(clock, MIN, 1_000);
        const outcome = await pending;

        check(
            '(b) with `retry: { attempts: 1 }` the call still succeeded',
            outcome,
            'ok',
        );
        check('(b) requests that reached the wire', aws.calls.length, 2);
        note(
            '(b) why',
            '`attempt--` before `continue` (engine.ts:723) — the redone attempt is not counted',
        );
    }

    // ── (c) the latch, and whether the correction survives the call ─────────────────────────
    // Two facts in one run: the refresh fires at most ONCE per run (so a still-wrong offset is not
    // re-corrected within the same call), and the offset — being the caller's object — persists, so
    // the NEXT call signs correctly on its first attempt.
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, skewMs: DRIFT });
        const offset: SkewOffset = { ms: 0 };
        const log = { corrections: [] as number[] };
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: selfCorrectingSigV4({ clock, offset }, log),
            clock,
        });

        const first = outcomeOf(() => call({}));
        await runOut(clock, MIN, 1_000);
        await first;
        const wireAfterFirst = aws.calls.length;

        const second = outcomeOf(() => call({}));
        await runOut(clock, MIN, 1_000);
        const secondOutcome = await second;

        check('(c) call 1 — requests', wireAfterFirst, 2);
        check('(c) call 2 — outcome', secondOutcome, 'ok');
        check(
            '(c) call 2 — requests (1 means it signed correctly first time)',
            aws.calls.length - wireAfterFirst,
            1,
        );
        check(
            '(c) corrections learned across BOTH calls',
            log.corrections.length,
            1,
        );
        checkSeq(
            '(c) skew per request across both calls (ms)',
            aws.calls.map((c) => c.skewMs),
            [DRIFT, 0, 0],
        );
    }

    // ── (d) the latch has a limit: a drift that CHANGES mid-run ────────────────────────────
    // `refreshed` is set for the life of the run, so if the correction is not enough (the host is
    // still drifting, or the server moved), the run fails. That is the right default — an
    // uncorrectable clock should fail rather than loop — but it is a latch, not a retry policy.
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, skewMs: DRIFT });
        const offset: SkewOffset = { ms: 0 };
        const log = { corrections: [] as number[] };
        // Drift AGAIN, by a different amount, the instant the first response is handed back — so
        // the offset learned from attempt 1's `Date` is already stale when attempt 2 arrives.
        // Wrapping the adapter makes it deterministic; nudging `skewMs` on a timer races the run.
        const inner = aws.adapter();
        const call = stitch({
            url: URL_S3,
            adapter: async (req) => {
                const res = await inner(req);
                if (aws.calls.length === 1) aws.skewMs = DRIFT + 20 * MIN;
                return res;
            },
            auth: selfCorrectingSigV4({ clock, offset }, log),
            clock,
        });

        const pending = outcomeOf(() => call({}));
        await runOut(clock, MIN, 1_000);
        const outcome = await pending;

        check(
            '(d) the server moved again after the correction — outcome',
            outcome,
            '403',
        );
        check('(d) corrections attempted', log.corrections.length, 1);
        check(
            '(d) requests that reached the wire (no second correction)',
            aws.calls.length,
            2,
        );
        note(
            '(d) the mechanism',
            '`refreshed` latches for the run (engine.ts:615,709), so one correction per call and no loop',
        );
    }

    // ── (e) the alternative seam, and why it is worse ──────────────────────────────────────
    // `hooks.onResponse` sees every response including the 403, so it can LEARN the offset. What it
    // cannot do is ask for another attempt — so the correction only lands if a retry happens anyway,
    // which means putting 403 in `retry.on`. That re-arms C6 (b): every OTHER 403 (a genuinely bad
    // credential) now burns the full retry budget too.
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, skewMs: DRIFT });
        const offset: SkewOffset = { ms: 0 };
        let learned = 0;
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: clockSigV4({ ...CREDS, clock, offset }),
            hooks: {
                onResponse: ({ res }) => {
                    if (res && res.status === 403 && isSkewError(res.body)) {
                        const d = Date.parse(res.headers['date'] ?? '');
                        if (!Number.isNaN(d)) {
                            offset.ms = d - clock.now();
                            learned++;
                        }
                    }
                },
            },
            retry: {
                attempts: 2,
                on: [403],
                backoff: { curve: 'fixed', base: '2s' },
            },
            clock,
        });

        const pending = outcomeOf(() => call({}));
        await runOut(clock, MIN, 1_000);
        const outcome = await pending;

        check(
            '(e) `hooks.onResponse` + `retry.on: [403]` — outcome',
            outcome,
            'ok',
        );
        check('(e) offsets learned', learned, 1);
        checkSeq(
            '(e) skew per request (ms)',
            aws.calls.map((c) => c.skewMs),
            [DRIFT, 0],
        );
        note(
            '(e) the price',
            'it works, but it needs 403 in `retry.on`, so every non-skew 403 now burns the retry budget too — the seam in (a) needs no such concession',
        );
    }

    await drain();
    finish(
        'C7',
        'clock-skew correction IS reachable — `AuthStrategy.shouldRefresh`/`refresh` learned a 600000ms offset from the 403’s `Date` header and re-signed the SAME attempt to a 200, costing no retry budget; but `refresh` cannot see the response (the offset must be smuggled through a closure) and the latch fires once per run',
    );
}

void main();
