// C5 — does SigV4 signing read the INJECTED clock, or `Date.now()`?
//
// This is the one claim in the set that the library LOSES, and it is the third instance of a
// pattern two earlier scenarios already found: scenario 4 measured `timeout.total` reading wall
// time and scenario 6 measured `cache.ttl` doing the same, each while the code beside them used the
// injected `clock`. `@stitchapi/aws-sigv4` makes it three — `amzDateOf(new Date())`, aws-sigv4/
// src/index.ts:301, with no `clock` anywhere in the package.
//
// MEASURED: advancing a `manualClock` by ten virtual minutes between two signings moved the shipped
// signer's timestamp by 0 SECONDS. The same two signings through a clock-reading signer moved by
// exactly 600. So the shipped strategy is unaffected by `clock`, and:
//
//   • Part (c): a SigV4 stitch under `manualClock()` — the default `manualClock()` starts at epoch
//     0 — signs with the real wall time while every fake in the test runs in 1970. Everything is
//     403. Measured: 0 of 3 calls accepted, and the failure is a pure artifact of the test clock.
//   • This is also WHY C1–C4 are measured the way they are. A virtual queue is invisible to a
//     signer on wall time, so those claims run twice: once with a clock-reading substitute at
//     virtual intervals big enough to cross the five-minute window, and once with the shipped
//     strategy on the real clock at intervals small enough to run in seconds.
//
// The narrow good news in (d): because the timestamp comes from `new Date()` at the moment `apply`
// runs, it is at least always CURRENT. The bug is a testability bug, not a correctness one — no
// production request goes out with a wrong timestamp because of it.
//
//   pnpm exec tsx docs/scenarios/proofs/expiring-signatures/c5-clock-source.ts
import { stitch, systemClock } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { AuthStrategy } from '../../../../packages/core/src/types';
import { FakeAws, parseAmzDate } from './fake-aws';
import { check, checkAtMost, checkSeq, finish, heading, note } from './harness';
import type { SignEvent } from './signers';
import { CREDS, clockSigV4, stampedSigV4 } from './signers';
import { runOut } from './virtual-time';

const URL_S3 = 'https://bucket.s3.us-east-1.amazonaws.com/key';
const T0 = Date.UTC(2026, 7, 5, 12, 0, 0);
const MIN = 60_000;

/**
 * Sign twice through a stitch, ten virtual minutes apart (a `rate` of 1/10m does the spacing), and
 * report how far the WIRE timestamp moved between them. A signer on the injected clock reports 600
 * seconds; one on `Date.now()` reports ~0.
 */
async function stampDriftSeconds(
    strategyFor: (clock: ReturnType<typeof manualClock>) => AuthStrategy,
): Promise<{ drift: number; stamps: string[] }> {
    const clock = manualClock(T0);
    const aws = new FakeAws({ clock, windowMs: Number.MAX_SAFE_INTEGER });
    const call = stitch({
        url: URL_S3,
        adapter: aws.adapter(),
        auth: strategyFor(clock),
        throttle: { rate: '1/10m' },
        clock,
    });
    const inFlight = [call({}).safe(), call({}).safe()];
    await runOut(clock, 30 * MIN);
    await Promise.all(inFlight);
    const stamps = aws.stamps();
    const drift =
        (parseAmzDate(stamps[1] ?? '') - parseAmzDate(stamps[0] ?? '')) / 1000;
    return { drift, stamps };
}

async function main(): Promise<void> {
    heading(
        'C5 — advance a manualClock by 10 minutes: does the signature’s timestamp move?',
    );

    // ── (a) the shipped strategy ────────────────────────────────────────────────────────────
    {
        const log: SignEvent[] = [];
        const { drift, stamps } = await stampDriftSeconds(() =>
            stampedSigV4(CREDS, log),
        );
        note('(a) the two wire timestamps', JSON.stringify(stamps));
        // At most 1, not exactly 0: the two signings are milliseconds apart in REAL time, and if
        // those milliseconds straddle a wall-clock second the stamp ticks by one. That tick is the
        // claim restated — the timestamp tracks wall time, not the 600 virtual seconds that passed
        // between the two grants.
        checkAtMost(
            '(a) SHIPPED awsSigV4 — seconds the timestamp moved across a 600s virtual gap',
            drift,
            1,
        );
        note(
            '(a) what it read instead',
            '`amzDateOf(new Date())` — aws-sigv4/src/index.ts:301; the package imports no Clock at all',
        );
    }

    // ── (b) a clock-reading signer, same rig ────────────────────────────────────────────────
    {
        const { drift, stamps } = await stampDriftSeconds((clock) =>
            clockSigV4({ ...CREDS, clock }),
        );
        note('(b) the two wire timestamps', JSON.stringify(stamps));
        check(
            '(b) clock-reading signer — seconds the timestamp moved across the same gap',
            drift,
            600,
        );
    }

    // ── (c) the consequence for anyone testing a SigV4 stitch ───────────────────────────────
    // `manualClock()` with no argument starts at epoch 0 — the documented default. Point the fake
    // server at that same clock (the ordinary thing to do) and every request is ~56 years skewed.
    {
        const clock = manualClock();
        const aws = new FakeAws({ clock });
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: stampedSigV4(CREDS, []),
            clock,
        });
        const results = await Promise.all([
            call({}).safe(),
            call({}).safe(),
            call({}).safe(),
        ]);
        await runOut(clock, 1000);

        check(
            '(c) calls accepted with a default `manualClock()` and the SHIPPED signer',
            results.filter((r) => r.ok).length,
            0,
        );
        checkSeq(
            '(c) status per call',
            aws.calls.map((c) => c.status),
            [403, 403, 403],
        );
        note(
            '(c) the skew the fake server measured',
            `${String(Math.round((aws.calls[0]?.skewMs ?? 0) / -86_400_000))} days — the wall clock against a virtual epoch of 0`,
        );
    }

    // ── (d) the limit of the damage ─────────────────────────────────────────────────────────
    // On the real clock the shipped signer is CORRECT: it stamps the instant `apply` runs. So this
    // is a testability defect, not a wire defect — worth stating plainly, because "the signer
    // ignores the clock" reads much worse than it is.
    {
        const aws = new FakeAws({ clock: systemClock });
        const log: SignEvent[] = [];
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: stampedSigV4(CREDS, log),
        });
        const r = await call({}).safe();
        const skew = Math.abs(aws.calls[0]?.skewMs ?? Infinity);

        check('(d) on the real clock the request is accepted', r.ok, true);
        checkAtMost(
            '(d) skew the server measured, ms (1000 = `x-amz-date`’s one-second resolution)',
            skew,
            1000,
        );
    }

    finish(
        'C5',
        'the SHIPPED signer reads `new Date()`, NOT the injected clock — 0 seconds of movement across a 600-second virtual advance, and 0 of 3 calls accepted under a default manualClock; a clock-reading signer moved 600s. It is a testability defect, not a wire defect: on real time the stamp is correct',
    );
}

void main();
