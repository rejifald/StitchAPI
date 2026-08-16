// C3 — the same question as C2, for the OTHER half of `throttle`: a request held behind a busy
// concurrency pool.
//
// The two halves are separate code paths inside one `acquire` (resilience.ts:133-161): the
// concurrency slot is taken first and its waiters are served FIFO (`takeSlot`,
// resilience.ts:124-131), then the rate spacing is paced WITHIN the held slot. So a request can be
// blocked by either, and scenario 9 measured the concurrency half being the sharper of the two — a
// quiet caller behind a busy pool is not slowed proportionally, it is queued LAST.
//
// MEASURED: same answer. Four calls behind `throttle: { concurrency: 1 }` against an upstream that
// holds each request for two virtual minutes were granted at 0, 2, 4 and 6 minutes, and every one
// carried a signature aged 0ms. The whole `acquire` — both halves — sits at engine.ts:657, above
// the `cfg.auth.apply` at engine.ts:677.
//
// Part (c) is worth more than it looks: the two limiters STACK, so a call can be held by the
// concurrency pool and then paced again by the rate budget, and the signature is still minted after
// BOTH.
//
//   pnpm exec tsx docs/scenarios/proofs/expiring-signatures/c3-throttle-concurrency.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import { FakeAws } from './fake-aws';
import { check, checkSeq, finish, heading, note } from './harness';
import type { SignEvent } from './signers';
import { CREDS, clockSigV4, presign, presignedSigV4 } from './signers';
import { runOut } from './virtual-time';

const URL_S3 = 'https://bucket.s3.us-east-1.amazonaws.com/key';
const T0 = Date.UTC(2026, 7, 5, 12, 0, 0);
const MIN = 60_000;
const CALLS = 4;
/** Each in-flight request occupies the single slot for two virtual minutes. */
const HOLD = 2 * MIN;

async function main(): Promise<void> {
    heading(
        'C3 — a call held behind a busy `throttle: { concurrency }` pool: is its signature stale?',
    );

    // ── (a) the library ──────────────────────────────────────────────────────────────────────
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, holdMs: HOLD });
        const signed: SignEvent[] = [];
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: clockSigV4({ ...CREDS, clock }, signed),
            throttle: { concurrency: 1 },
            clock,
        });

        const inFlight = Array.from({ length: CALLS }, () => call({}).safe());
        await runOut(clock, 20 * MIN);
        const results = await Promise.all(inFlight);

        checkSeq(
            '(a) arrival per call (virtual min) — the 4th waited 6 minutes for the pool',
            aws.calls.map((c) => (c.arrivedAt - T0) / MIN),
            [0, 2, 4, 6],
        );
        checkSeq('(a) SIGNATURE AGE ON ARRIVAL (ms)', aws.ages(), [0, 0, 0, 0]);
        checkSeq(
            '(a) when `auth.apply` ran (virtual min)',
            signed.map((s) => (s.at - T0) / MIN),
            [0, 2, 4, 6],
        );
        checkSeq(
            '(a) status per call',
            aws.calls.map((c) => c.status),
            [200, 200, 200, 200],
        );
        check(
            '(a) calls that succeeded',
            results.filter((r) => r.ok).length,
            CALLS,
        );
        check('(a) DISTINCT signatures', aws.distinctSignatures(), CALLS);
    }

    // ── (b) THE CONTROL ─────────────────────────────────────────────────────────────────────
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, holdMs: HOLD });
        const headers = await presign(CREDS, URL_S3, T0);
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: presignedSigV4(headers),
            throttle: { concurrency: 1 },
            clock,
        });

        const inFlight = Array.from({ length: CALLS }, () => call({}).safe());
        await runOut(clock, 20 * MIN);
        const results = await Promise.all(inFlight);

        checkSeq(
            '(b) control — SIGNATURE AGE ON ARRIVAL (virtual min)',
            aws.ages().map((a) => a / MIN),
            [0, 2, 4, 6],
        );
        checkSeq(
            '(b) control — status per call',
            aws.calls.map((c) => c.status),
            [200, 200, 200, 403],
        );
        check(
            '(b) control — calls that succeeded',
            results.filter((r) => r.ok).length,
            3,
        );
    }

    // ── (c) both limiters at once ───────────────────────────────────────────────────────────
    // `concurrency: 1` with a 2-minute hold paces at 2 minutes; a `rate` of 1/3m is tighter, so the
    // rate budget wins and grants land 3 minutes apart. The point is not which one wins — it is
    // that signing happens after BOTH, so a call gated twice is still minted fresh.
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, holdMs: HOLD });
        const signed: SignEvent[] = [];
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: clockSigV4({ ...CREDS, clock }, signed),
            throttle: { concurrency: 1, rate: '1/3m' },
            clock,
        });

        const inFlight = Array.from({ length: 3 }, () => call({}).safe());
        await runOut(clock, 20 * MIN);
        const results = await Promise.all(inFlight);

        checkSeq(
            '(c) concurrency AND rate — arrival per call (virtual min)',
            aws.calls.map((c) => (c.arrivedAt - T0) / MIN),
            [0, 3, 6],
        );
        checkSeq(
            '(c) SIGNATURE AGE after both gates (ms)',
            aws.ages(),
            [0, 0, 0],
        );
        check(
            '(c) calls that succeeded',
            results.filter((r) => r.ok).length,
            3,
        );
        note(
            '(c) skew the server saw on the doubly-gated 6-minute call',
            `${String(aws.calls[2]?.skewMs)}ms`,
        );
    }

    finish(
        'C3',
        'a request held six virtual minutes behind a busy concurrency pool still arrived with a 0ms-old signature; the concurrency wait, the rate wait, and both stacked all happen BEFORE `auth.apply`',
    );
}

void main();
