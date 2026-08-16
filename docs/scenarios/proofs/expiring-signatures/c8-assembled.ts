// C8 — the best available answer, run against all three failure modes at once.
//
// The scenario names three ways to fall outside the five-minute window. Two of them the engine
// already handles and needs no user code at all:
//
//   • the signature ageing in YOUR OWN queue (C2/C3) — the throttle wait is at engine.ts:657 and
//     `cfg.auth.apply` at engine.ts:677, so the request is signed AFTER the wait, always;
//   • the retry replaying a stale signature (C1) — `cloneReq` gives each attempt fresh headers and
//     `auth.apply` re-runs per attempt.
//
// The third — the host clock is simply wrong — no client library can fix by ordering, and the
// mitigation the AWS SDKs ship (learn the offset from the server's `Date`, re-sign) is user code
// here. This is that code, assembled, with the classification C6 showed is needed to stop a local
// clock fault reading as a dependency outage.
//
// Run against a host ten minutes behind, six virtual minutes of rate-limited queueing, and a
// breaker watching: 4 of 4 calls succeeded, 0 circuit failures recorded, and the worst signature
// age on the wire was 0ms.
//
//   pnpm exec tsx docs/scenarios/proofs/expiring-signatures/c8-assembled.ts
import { stitch, verdictOf } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    AdapterResponse,
    AuthStrategy,
    Clock,
} from '../../../../packages/core/src/types';
import { FakeAws, isSkewError, outcomeOf } from './fake-aws';
import { check, checkSeq, finish, heading, note } from './harness';
import type { SkewOffset } from './signers';
import { CREDS, clockSigV4, presign, presignedSigV4 } from './signers';
import { drain, runOut } from './virtual-time';

const URL_S3 = 'https://bucket.s3.us-east-1.amazonaws.com/key';
const T0 = Date.UTC(2026, 7, 5, 12, 0, 0);
const MIN = 60_000;
const DRIFT = 10 * MIN;
const CALLS = 4;

// ── THE ANSWER ─────────────────────────────────────────────────────────────────────────────────
// Everything below this line is what a user writes. Everything above the line — per-attempt
// signing, signing after the queue, not retrying a 403 — is already the engine's behaviour.

/** Piece 1 — SigV4 on an injectable, correctable clock. The seam `@stitchapi/aws-sigv4` lacks (C5). */
function sigV4WithSkewCorrection(opts: {
    clock: Clock;
    offset: SkewOffset;
}): AuthStrategy {
    const inner = clockSigV4({
        ...CREDS,
        clock: opts.clock,
        offset: opts.offset,
    });
    let skewed: AdapterResponse | undefined;
    return {
        name: 'sigV4WithSkewCorrection',
        apply: inner.apply,
        // The only auth hook that sees the response — so it both decides AND captures.
        shouldRefresh: (res) => {
            const hit = res.status === 403 && isSkewError(res.body);
            if (hit) skewed = res;
            return hit;
        },
        // `refresh` gets an AuthContext and nothing else, hence the closure above.
        refresh: () => {
            const serverTime = Date.parse(skewed?.headers['date'] ?? '');
            if (!Number.isNaN(serverTime))
                opts.offset.ms = serverTime - opts.clock.now();
        },
    };
}

/** Piece 2 — a skew 403 is a real error, and NOT a dependency-health signal (C6). */
const skewAwareSurface: Surface = {
    id: 'http+skew',
    interpret: (res, cfg) => {
        const failed = verdictOf(res, cfg);
        if (failed) return failed;
        if (res.status === 403 && isSkewError(res.body))
            return { ok: false, message: 'RequestTimeTooSkewed', status: 403 };
        return { ok: true, data: res.body };
    },
};

// ── end of the answer: 2 declarations, 26 lines ────────────────────────────────────────────────

async function main(): Promise<void> {
    heading('C8 — drifting host + a six-minute queue + a breaker, all at once');

    // ── (a) the assembled construction ──────────────────────────────────────────────────────
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, skewMs: DRIFT });
        const offset: SkewOffset = { ms: 0 };
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            kind: skewAwareSurface,
            auth: sigV4WithSkewCorrection({ clock, offset }),
            verdict: { accept: [403] },
            throttle: { rate: '1/2m' },
            circuit: { failures: 2, cooldown: '30s' },
            clock,
        });

        const inFlight = Array.from({ length: CALLS }, () =>
            outcomeOf(() => call({})),
        );
        await runOut(clock, 20 * MIN);
        const spine = await Promise.all(inFlight);

        checkSeq('(a) outcome per call', spine, ['ok', 'ok', 'ok', 'ok']);
        check('(a) the offset learned from the server (ms)', offset.ms, DRIFT);
        check(
            '(a) WORST signature age on the wire (ms), across a 6-minute queue',
            Math.max(...aws.ages()),
            0,
        );
        // [2,4,6,8], not [0,2,4,6]: the correction probe took the t=0 slot and its corrected
        // re-sign took t=2m. A skew correction is a SECOND trip through the attempt loop, so it
        // re-acquires the throttle and spends another rate slot — worth knowing when the budget is
        // the scarce resource.
        checkSeq(
            '(a) grant time of each SUCCEEDING call (virtual min)',
            aws.calls
                .filter((c) => c.status === 200)
                .map((c) => (c.arrivedAt - T0) / MIN),
            [2, 4, 6, 8],
        );
        check(
            '(a) skew-failed requests — exactly one, the probe that taught the offset',
            aws.calls.filter((c) => c.status === 403).length,
            1,
        );
        note(
            '(a) requests to the wire',
            `${String(aws.calls.length)} for ${String(CALLS)} calls — one correction probe plus one per call`,
        );
        note(
            '(a) the breaker',
            'never opened: the one 403 was a SURFACE rejection, which records a circuit success (engine.ts:905-908)',
        );
    }

    // ── (b) the same workload with none of it ───────────────────────────────────────────────
    // Stock config, the shipped signer's ordering (per-attempt, post-queue) preserved by using the
    // clock signer WITHOUT correction, and no classification.
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, skewMs: DRIFT });
        // No `throttle` here: this part is about the drift and the breaker, and a rate budget would
        // force gaps between the calls longer than the breaker's own cooldown — at which point the
        // breaker is perpetually half-open and admits every call, which measures the cooldown
        // rather than the drift. (a) and (d) carry the queue.
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: clockSigV4({ ...CREDS, clock }),
            circuit: { failures: 2, cooldown: '30s' },
            clock,
        });

        // SEQUENTIAL, so each call sees the breaker state the previous one left. Part (d) runs the
        // same four calls concurrently and gets a different answer, for a reason worth its own
        // measurement.
        const spine: string[] = [];
        for (let i = 0; i < CALLS; i++) {
            spine.push(await outcomeOf(() => call({})));
            await drain();
        }

        checkSeq('(b) no user code — outcome per call', spine, [
            '403',
            '403',
            '503',
            '503',
        ]);
        check('(b) requests that reached the wire', aws.calls.length, 2);
        note(
            '(b) what the operator sees',
            'two auth failures then `circuit open` — a dependency outage, for a wrong clock in this process',
        );
    }

    // ── (c) and the hand-rolled version of the part the engine gives free ──────────────────
    // The engine's contribution is not a feature you can point at; it is the absence of a bug. This
    // measures its size: the same four calls, presigned before the queue — which is what a
    // hand-rolled `sign(); await limiter.acquire(); send()` does — against the same server.
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock });
        const headers = await presign(CREDS, URL_S3, T0);
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: presignedSigV4(headers),
            throttle: { rate: '1/2m' },
            clock,
        });

        const inFlight = Array.from({ length: CALLS }, () =>
            outcomeOf(() => call({})),
        );
        await runOut(clock, 20 * MIN);
        const spine = await Promise.all(inFlight);

        checkSeq(
            '(c) sign-then-queue, with a PERFECT clock — outcome per call',
            spine,
            ['ok', 'ok', 'ok', '403'],
        );
        checkSeq(
            '(c) signature age per call (virtual min)',
            aws.ages().map((a) => a / MIN),
            [0, 2, 4, 6],
        );
        note(
            '(c) the point',
            'no clock is wrong here. The only defect is WHERE the signing happened relative to the queue — and that is the defect the engine does not have',
        );
    }

    // ── (d) the breaker is checked BEFORE the queue, not after it ──────────────────────────
    // The same four failing calls as (b), fired together instead of one after another. Every one of
    // them reads the breaker's phase at t=0 — `attemptWithCircuit` calls `circuit.phase()`
    // (engine.ts:894) before `attemptLoop` reaches `acquireWithin` (engine.ts:657) — so all four
    // are already past the gate when the first failure opens it. The breaker cannot retract a
    // request it has already admitted to the queue.
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, skewMs: DRIFT });
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: clockSigV4({ ...CREDS, clock }),
            throttle: { rate: '1/2m' },
            circuit: { failures: 2, cooldown: '30s' },
            clock,
        });

        const inFlight = Array.from({ length: CALLS }, () =>
            outcomeOf(() => call({})),
        );
        await runOut(clock, 20 * MIN);
        const spine = await Promise.all(inFlight);

        checkSeq(
            '(d) the SAME four calls fired concurrently — outcome per call',
            spine,
            ['403', '403', '403', '403'],
        );
        check(
            '(d) requests that reached the wire (2 in (b), because the breaker stopped the rest)',
            aws.calls.length,
            4,
        );
        checkSeq(
            '(d) and they went out over six minutes, long after the breaker opened (virtual min)',
            aws.calls.map((c) => (c.arrivedAt - T0) / MIN),
            [0, 2, 4, 6],
        );
        note(
            '(d) the consequence',
            'a `circuit` does not shed a burst that is already queued behind a `throttle` — the phase check happens at enqueue, the wait happens after it',
        );
    }

    finish(
        'C8',
        'assembled: 4 of 4 calls succeeded through a 10-minute host drift and a 6-minute rate-limited queue, worst signature age 0ms, breaker never opened — 26 lines of user code in 2 declarations, all of it for the clock-drift half. The queue and retry halves needed none',
    );
}

void main();
