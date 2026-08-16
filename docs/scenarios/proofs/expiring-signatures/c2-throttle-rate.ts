// C2 — THE DECIDING CLAIM. Does the throttle's wait happen BEFORE the signing, or AFTER it?
//
// This is botocore#149 asked of StitchAPI. Sign, then hold the request behind a rate limiter, and
// the timestamp on the wire is however old the queue was. AWS's own answer to the bug report is to
// generate the timestamp per signing operation and to sign as late as possible; the question here is
// whether the engine already does that.
//
// MEASURED: it does. Four calls behind `throttle: { rate: '1/2m' }` were granted at 0, 2, 4 and 6
// virtual minutes, and every one of them carried a signature aged 0ms on arrival. The fourth waited
// SIX MINUTES — past the five-minute window — and was accepted, because it was signed at the moment
// its slot came up, not at the moment it was enqueued. `auth.apply` runs at engine.ts:677, INSIDE
// the attempt loop and AFTER the `acquireWithin` at engine.ts:657.
//
// Part (b) is the control, and it is what makes (a) evidence rather than an assertion: the same
// four calls with the headers pre-signed at t=0 measured ages of 0 / 2 / 4 / 6 minutes and a 403
// RequestTimeTooSkewed on the last. The instrument detects the bug; the library does not have it.
//
//   pnpm exec tsx docs/scenarios/proofs/expiring-signatures/c2-throttle-rate.ts
import { stitch, systemClock } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakeAws } from './fake-aws';
import { check, checkAtMost, checkSeq, finish, heading, note } from './harness';
import type { SignEvent } from './signers';
import {
    CREDS,
    clockSigV4,
    presign,
    presignedSigV4,
    stampedSigV4,
} from './signers';
import { runOut } from './virtual-time';

const URL_S3 = 'https://bucket.s3.us-east-1.amazonaws.com/key';
const T0 = Date.UTC(2026, 7, 5, 12, 0, 0);
const MIN = 60_000;
/** Four slots two minutes apart: the last one is granted at t+6m, PAST the five-minute window. */
const RATE = '1/2m';
const CALLS = 4;

async function main(): Promise<void> {
    heading(
        'C2 — a call queued behind `throttle: { rate }`: is its signature stale when it arrives?',
    );

    // ── (a) the library, on a virtual clock, over a queue longer than the window ───────────────
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock });
        const signed: SignEvent[] = [];
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: clockSigV4({ ...CREDS, clock }, signed),
            throttle: { rate: RATE },
            clock,
        });

        const inFlight = Array.from({ length: CALLS }, () => call({}).safe());
        await runOut(clock, 20 * MIN);
        const results = await Promise.all(inFlight);

        checkSeq(
            '(a) grant times (virtual min from t0) — the queue really was 6 minutes deep',
            aws.calls.map((c) => (c.arrivedAt - T0) / MIN),
            [0, 2, 4, 6],
        );
        checkSeq(
            '(a) SIGNATURE AGE ON ARRIVAL (ms), per call',
            aws.ages(),
            [0, 0, 0, 0],
        );
        checkSeq(
            '(a) when `auth.apply` ran (virtual min from t0)',
            signed.map((s) => (s.at - T0) / MIN),
            [0, 2, 4, 6],
        );
        checkSeq(
            '(a) status per call — the 6-minute-queued one included',
            aws.calls.map((c) => c.status),
            [200, 200, 200, 200],
        );
        check(
            '(a) calls that succeeded',
            results.filter((r) => r.ok).length,
            CALLS,
        );
        note(
            '(a) skew the SERVER saw on the last (6-min-queued) call',
            `${String(aws.calls[CALLS - 1]?.skewMs)}ms — the window is 300000ms`,
        );
    }

    // ── (b) THE CONTROL — the same four calls, pre-signed at t0 ───────────────────────────────
    // Without this the (a) numbers are unfalsifiable. Sign once up front, enqueue, and the ages
    // are the queue depth.
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock });
        const headers = await presign(CREDS, URL_S3, T0);
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: presignedSigV4(headers),
            throttle: { rate: RATE },
            clock,
        });

        const inFlight = Array.from({ length: CALLS }, () => call({}).safe());
        await runOut(clock, 20 * MIN);
        const results = await Promise.all(inFlight);

        checkSeq(
            '(b) control — SIGNATURE AGE ON ARRIVAL (virtual min), signed once at t0',
            aws.ages().map((a) => a / MIN),
            [0, 2, 4, 6],
        );
        checkSeq(
            '(b) control — status per call',
            aws.calls.map((c) => c.status),
            [200, 200, 200, 403],
        );
        check(
            '(b) control — the skew the server saw on the 6-minute-queued call (ms)',
            aws.calls[CALLS - 1]?.skewMs,
            6 * MIN,
        );
        check(
            '(b) control — calls that succeeded',
            results.filter((r) => r.ok).length,
            3,
        );
        note(
            '(b) control — one signature replayed by every call',
            `${String(aws.distinctSignatures())} distinct signature(s) across ${String(aws.calls.length)} requests`,
        );
    }

    // ── (c) the SHIPPED signer, on the real clock ─────────────────────────────────────────────
    // (a) uses `clockSigV4`, written when `awsSigV4` still stamped `new Date()` (C5's original
    // finding, fixed by #667) — so (a) measures the ENGINE's ordering with an independent
    // strategy. This part keeps the corroborating run: the real `@stitchapi/aws-sigv4`, real time,
    // a real ~2.4-second queue. Both instruments run through the same seam (`cfg.auth.apply`), so
    // if the ordering held only for one of them, this is where it would show.
    {
        const aws = new FakeAws({ clock: systemClock });
        const signed: SignEvent[] = [];
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: stampedSigV4(CREDS, signed),
            throttle: { rate: '1/800ms' },
        });

        const t0 = Date.now();
        const results = await Promise.all(
            Array.from({ length: CALLS }, () => call({}).safe()),
        );
        const spread = (aws.calls[CALLS - 1]?.arrivedAt ?? t0) - t0;

        checkAtMost(
            '(c) real clock — queue was at least 2s deep, so a t0 signature would be visibly old',
            2000,
            spread,
        );
        // The precise gap: `auth.apply` entry → transport entry, in real ms. The `ageMs` column
        // cannot be used here because `x-amz-date` has ONE-SECOND resolution, so it reports up to
        // 999ms of pure truncation on a signature that is actually microseconds old.
        const gaps = aws.calls.map(
            (c, i) => c.arrivedAt - (signed[i]?.at ?? NaN),
        );
        note(
            '(c) real clock — arrival times (ms from t0)',
            JSON.stringify(aws.calls.map((c) => c.arrivedAt - t0)),
        );
        note(
            '(c) real clock — sign→wire gap per call (ms)',
            JSON.stringify(gaps),
        );
        checkAtMost(
            '(c) real clock — WORST sign→wire gap across the whole queue (ms)',
            Math.max(...gaps),
            250,
        );
        check(
            '(c) real clock — every request accepted',
            results.filter((r) => r.ok).length,
            CALLS,
        );
        note(
            '(c) real clock — distinct signatures',
            `${String(aws.distinctSignatures())} of ${String(aws.calls.length)}`,
        );
    }

    // ── (d) the one seam that CAN reintroduce the bug ────────────────────────────────────────
    // `hooks.onRequest` runs at engine.ts:680 — AFTER `cfg.auth.apply` at 677 and before the
    // transport. Everything the engine does with the request happens before signing; this hook is
    // the single place a user's own code runs after it. A hook that WAITS therefore ages the
    // signature by exactly its wait, and the natural reason to put a wait there — pacing the call
    // by some rule `throttle` cannot express — is precisely the case this scenario is about.
    //
    // Nothing warns. The config that produces it reads as a throttle and behaves as the opposite.
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock });
        const signed: SignEvent[] = [];
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: clockSigV4({ ...CREDS, clock }, signed),
            hooks: {
                // A hand-rolled gate: "one call every six minutes", implemented where it seems
                // natural rather than where the engine's own wait lives.
                onRequest: async () => {
                    await clock.sleep(6 * MIN);
                },
            },
            clock,
        });

        const pending = call({}).safe();
        await runOut(clock, 20 * MIN);
        const result = await pending;

        check(
            '(d) a 6-minute wait inside `hooks.onRequest` — signature AGE on arrival (virtual min)',
            (aws.ages()[0] ?? NaN) / MIN,
            6,
        );
        check('(d) the request was rejected', aws.calls[0]?.status, 403);
        check('(d) the call failed', result.ok, false);
        note(
            '(d) the ordering',
            'auth.apply engine.ts:677 → hooks.onRequest engine.ts:680 → transport. A hook is the ONLY user code that runs after signing',
        );
    }

    finish(
        'C2',
        'the throttle wait happens BEFORE signing — a rate-limited queue does NOT age the signature (0ms after a 6-minute wait), while the same calls pre-signed measured 6 minutes and a 403. The one exception is `hooks.onRequest`, which runs AFTER signing: a 6-minute wait there aged the signature 6 minutes and got a 403',
    );
}

void main();
