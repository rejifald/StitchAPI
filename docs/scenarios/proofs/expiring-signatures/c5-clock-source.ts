// C5 — does SigV4 signing read the INJECTED clock, or `Date.now()`?
//
// When this audit first ran, the library LOST this claim, and it was the third instance of a
// pattern two earlier scenarios already found: scenario 4 measured `timeout.total` reading wall
// time and scenario 6 measured `cache.ttl` doing the same, each while the code beside them used the
// injected `clock`. `@stitchapi/aws-sigv4` made it three — `amzDateOf(new Date())`, with no `clock`
// anywhere in the package: 600 virtual seconds moved the shipped stamp 0 seconds, and 0 of 3 calls
// were accepted under a default `manualClock()`. Filed from this audit as #658; fixed by #667,
// riding the `AuthContext.clock` seam #664 added for `oauth2`. The signer now stamps
// `amzDateOf(new Date(clockNow(ctx)))` (aws-sigv4/src/index.ts:324), where `clockNow` (:266) is
// the same `ctx.clock?.now() ?? Date.now()` fallback core's `auth.ts` uses.
//
// So this script is now the REGRESSION PIN of the fixed behaviour:
//
//   • Part (a): advancing a `manualClock` by ten virtual minutes between two signings moves the
//     SHIPPED signer's timestamp by exactly 600 seconds — the stamp rides the injected clock.
//   • Part (b): `clockSigV4` — the ~20-line user-code signer that WAS the workaround — measures the
//     same 600 through the same rig. The fix made the workaround unnecessary; their agreement is
//     the check.
//   • Part (c): a SigV4 stitch under a default `manualClock()` (which starts at epoch 0) is now
//     testable: the fake validates against the same clock and accepts 3 of 3. The residual worth
//     knowing: epoch 0 signs `19700101T000000Z`, so seed the clock (`manualClock(Date.now())`)
//     when the stamp must be plausible to a real endpoint.
//   • Part (d): on the default `systemClock` nothing changed on the wire — `systemClock.now()` IS
//     `Date.now()`, and the request is accepted with sub-second skew.
//
//   pnpm exec tsx docs/scenarios/proofs/expiring-signatures/c5-clock-source.ts
import { stitch, systemClock } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { AuthStrategy } from '../../../../packages/core/src/types';
import { FakeAws, parseAmzDate } from './fake-aws';
import { check, checkAtMost, checkSeq, finish, heading, note } from './harness';
import { CREDS, clockSigV4, stampedSigV4 } from './signers';
import { runOut } from './virtual-time';

const URL_S3 = 'https://bucket.s3.us-east-1.amazonaws.com/key';
const T0 = Date.UTC(2026, 7, 5, 12, 0, 0);
const MIN = 60_000;

/**
 * Sign twice through a stitch, ten virtual minutes apart (a `rate` of 1/10m does the spacing), and
 * report how far the WIRE timestamp moved between them. A signer on the injected clock reports
 * exactly 600 — the grants land at exact virtual instants, so this is deterministic; one on
 * `Date.now()` would report ~0.
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
        const { drift, stamps } = await stampDriftSeconds((clock) =>
            stampedSigV4(CREDS, [], () => clock.now()),
        );
        checkSeq('(a) the two wire timestamps', stamps, [
            '20260805T120000Z',
            '20260805T121000Z',
        ]);
        check(
            '(a) SHIPPED awsSigV4 — seconds the timestamp moved across a 600s virtual gap',
            drift,
            600,
        );
        note(
            '(a) what it reads',
            '`amzDateOf(new Date(clockNow(ctx)))` — aws-sigv4/src/index.ts:324; `clockNow` (:266) is `ctx.clock?.now() ?? Date.now()` (#658, fixed by #667)',
        );
    }

    // ── (b) the pre-fix workaround signer, same rig ─────────────────────────────────────────
    {
        const { drift, stamps } = await stampDriftSeconds((clock) =>
            clockSigV4({ ...CREDS, clock }),
        );
        note('(b) the two wire timestamps', JSON.stringify(stamps));
        check(
            '(b) clock-reading user-code signer — seconds moved across the same gap (agreement)',
            drift,
            600,
        );
    }

    // ── (c) the consequence for anyone testing a SigV4 stitch ───────────────────────────────
    // `manualClock()` with no argument starts at epoch 0 — the documented default. Point the fake
    // server at that same clock (the ordinary thing to do) and, since #667, signer and validator
    // agree: zero skew, every request accepted. Before the fix this exact rig measured 0 of 3
    // accepted with ~20,670 days of apparent skew.
    {
        const clock = manualClock();
        const aws = new FakeAws({ clock });
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: stampedSigV4(CREDS, [], () => clock.now()),
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
            3,
        );
        checkSeq(
            '(c) status per call',
            aws.calls.map((c) => c.status),
            [200, 200, 200],
        );
        checkSeq(
            '(c) the wire timestamp — epoch 0, so seed the clock when the stamp must be plausible',
            aws.stamps(),
            ['19700101T000000Z', '19700101T000000Z', '19700101T000000Z'],
        );
        note(
            '(c) the skew the fake server measured',
            `${String(Math.round((aws.calls[0]?.skewMs ?? 0) / -86_400_000))} days — signer and validator share the virtual clock`,
        );
    }

    // ── (d) nothing changed on the wire ─────────────────────────────────────────────────────
    // On the default `systemClock` the stamp is wall-clock time, exactly as before the fix —
    // `systemClock.now()` IS `Date.now()`. The clock seam is a testability property, not a wire
    // change.
    {
        const aws = new FakeAws({ clock: systemClock });
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: stampedSigV4(CREDS, []),
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
        'the SHIPPED signer stamps from the INJECTED clock (#658, fixed by #667) — a 600-second virtual advance moved the wire timestamp exactly 600 seconds, a default manualClock() gets 3 of 3 accepted (signing 19700101T000000Z — seed it for plausible stamps), and the default systemClock path still stamps wall time',
    );
}

void main();
