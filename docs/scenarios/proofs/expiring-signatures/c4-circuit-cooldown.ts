// C4 — does a circuit-breaker cooldown hold a signed request the way a queue would?
//
// The capture groups the breaker with the rate limiter as a place a signature could age. It is a
// different shape and the difference is the finding: the breaker does not QUEUE anything. It
// fast-fails. `attemptWithCircuit` (engine.ts:877-923) reads the phase BEFORE calling
// `attemptLoop`, so an open breaker throws `CircuitOpenError` at engine.ts:902 without ever
// reaching the throttle, the transport, or `cfg.auth.apply`.
//
// MEASURED: a call that fast-failed on an open breaker performed ZERO signings — the signing ledger
// is empty for it. There is no held signature to expire, because nothing was signed. And the
// half-open trial admitted after a six-minute cooldown carried a signature aged 0ms.
//
// Part (c) is where the real hazard lives, and it is not a StitchAPI hazard: the cooldown is a wait
// the CALLER does, outside the call. Anyone who pre-signs and then waits out a breaker has the bug
// regardless of what the engine does.
//
//   pnpm exec tsx docs/scenarios/proofs/expiring-signatures/c4-circuit-cooldown.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakeAws, outcomeOf } from './fake-aws';
import { check, checkSeq, finish, heading, note } from './harness';
import type { SignEvent } from './signers';
import { CREDS, clockSigV4, presign, presignedSigV4 } from './signers';
import { drain, runOut } from './virtual-time';

const URL_S3 = 'https://bucket.s3.us-east-1.amazonaws.com/key';
const T0 = Date.UTC(2026, 7, 5, 12, 0, 0);
const MIN = 60_000;
/** Longer than the five-minute window, so a signature minted before the cooldown would expire in it. */
const CIRCUIT = { failures: 2, cooldown: '6m' } as const;

async function main(): Promise<void> {
    heading(
        'C4 — a circuit cooldown: does it hold a signed request, the way a rate limiter would?',
    );

    // ── (a) the breaker opens; does a fast-failed call sign anything? ────────────────────────
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, failWith: 500 });
        const signed: SignEvent[] = [];
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: clockSigV4({ ...CREDS, clock }, signed),
            circuit: CIRCUIT,
            clock,
        });

        // Two failures trip it (`failures: 2`), then three more calls inside the cooldown.
        const spine: string[] = [];
        for (let i = 0; i < 5; i++) {
            spine.push(await outcomeOf(() => call({})));
            await drain();
        }

        checkSeq(
            '(a) outcome per call — 500, 500, then the breaker fast-fails',
            spine,
            ['500', '500', '503', '503', '503'],
        );
        check('(a) requests that reached the wire', aws.calls.length, 2);
        // Signings == wire requests, across FIVE calls. The three that fast-failed contributed
        // nothing to either: they never reached `cfg.auth.apply`, so there was no signature for a
        // cooldown to age.
        check(
            '(a) SIGNINGS across all 5 calls (== the 2 that reached the wire)',
            signed.length,
            2,
        );
        check(
            '(a) signings performed by the 3 fast-failed calls',
            signed.length - aws.calls.length,
            0,
        );
        note(
            '(a) the fast-fail error',
            'CircuitOpenError, status 503, thrown at engine.ts:902 before the throttle and before auth',
        );
    }

    // ── (b) the half-open trial after a six-minute cooldown ─────────────────────────────────
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, failWith: 500 });
        const signed: SignEvent[] = [];
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: clockSigV4({ ...CREDS, clock }, signed),
            circuit: CIRCUIT,
            clock,
        });

        await outcomeOf(() => call({}));
        await outcomeOf(() => call({})); // breaker now open, armed at t0
        await drain();
        const blocked = await outcomeOf(() => call({}));
        // Ride out the cooldown, then take the trial.
        await runOut(clock, 6 * MIN);
        aws.skewMs = 0;
        const trial = await outcomeOf(() => call({}));
        await drain();

        check('(b) inside the cooldown', blocked, '503');
        check('(b) the half-open trial reached the wire', aws.calls.length, 3);
        checkSeq(
            '(b) arrival per wire request (virtual min)',
            aws.calls.map((c) => (c.arrivedAt - T0) / MIN),
            [0, 0, 6],
        );
        checkSeq(
            '(b) SIGNATURE AGE — including the trial admitted after a 6-minute cooldown',
            aws.ages(),
            [0, 0, 0],
        );
        // NOT `distinctSignatures()`: the two pre-cooldown attempts happen in the same virtual
        // SECOND, and `x-amz-date` has one-second resolution, so SigV4 over identical inputs
        // correctly yields a byte-identical signature. Two equal signatures are evidence of a
        // replay only when the requests are more than a second apart — which is exactly what
        // distinguishes the trial.
        check(
            '(b) the trial carries the post-cooldown timestamp, not the one from before it',
            aws.stamps()[2],
            '20260805T120600Z',
        );
        check(
            '(b) and its signature differs from the pre-cooldown ones',
            aws.calls[2]?.signature !== aws.calls[0]?.signature,
            true,
        );
        note('(b) the trial outcome', `${trial} (the upstream is still 500)`);
    }

    // ── (c) the caller-side hazard the engine cannot help with ──────────────────────────────
    // A breaker cooldown is time the CALLER spends not calling. If the request was signed before
    // that wait — pre-signed, or handed between services — the engine never gets the chance to
    // re-sign it, because the signature arrives as data.
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, failWith: 500 });
        const headers = await presign(CREDS, URL_S3, T0);
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: presignedSigV4(headers),
            circuit: CIRCUIT,
            clock,
        });

        await outcomeOf(() => call({}));
        await outcomeOf(() => call({}));
        await drain();
        await runOut(clock, 6 * MIN);
        const trial = await outcomeOf(() => call({}));
        await drain();

        check('(c) control — the trial after the cooldown', trial, '403');
        checkSeq(
            '(c) control — SIGNATURE AGE per wire request (virtual min)',
            aws.ages().map((a) => a / MIN),
            [0, 0, 6],
        );
        note(
            '(c) control — what the trial actually reported',
            'RequestTimeTooSkewed, not the 500 that opened the breaker — the recovery probe reports the wrong fault',
        );
    }

    finish(
        'C4',
        'the breaker does NOT queue a signed request — it fast-fails before signing (3 blocked calls, 0 signings), and the half-open trial after a 6-minute cooldown was signed fresh (age 0ms)',
    );
}

void main();
