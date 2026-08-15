// C1 — is the request signed PER ATTEMPT, or once per call and replayed?
//
// Failure mode 3 from the capture: if signing is hoisted above the retry loop, attempt 2 carries
// attempt 1's timestamp plus whatever the backoff was. A long backoff — or a `Retry-After` the
// server asked for — then guarantees the retry is stale, and the retry that was supposed to rescue
// the call is the thing that kills it.
//
// MEASURED: signed per attempt. Three attempts six virtual minutes apart produced three DISTINCT
// timestamps, three DISTINCT signatures, and an age of 0ms on every one — including attempt 3,
// eighteen minutes after the call started. `cloneReq` (engine.ts:270-273) hands each attempt a
// FRESH header object copied from the unsigned base request, so last attempt's `x-amz-date` cannot
// survive into this one even by accident, and `cfg.auth.apply` (engine.ts:677) re-runs inside the
// loop.
//
// Part (d) is the one that is NOT free: a server-directed `Retry-After: 600` is honoured
// unboundedly, and it is still fine here — but only because signing is per attempt. Under the
// control it is a guaranteed 403.
//
//   pnpm exec tsx docs/scenarios/proofs/expiring-signatures/c1-sign-per-attempt.ts
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
const ATTEMPTS = 3;
/**
 * Longer than the five-minute window, so attempt 2 is ALREADY doomed if the signature is reused.
 *
 * `max` is NOT decoration. `backoffDelay` clamps every computed delay to `backoff.max`, which
 * defaults to **10 seconds** (resilience.ts:51,60) — so `base: '6m'` alone yields a 10-second wait,
 * measured. That default is a quiet piece of protection for this scenario (a COMPUTED backoff can
 * never park a call long enough to expire a signature), and part (d) shows the hole in it: a
 * server-directed `Retry-After` skips `backoffDelay` entirely and is unbounded by design.
 */
const BACKOFF = { curve: 'fixed', base: '6m', max: '10m' } as const;

async function main(): Promise<void> {
    heading(
        'C1 — three attempts, six minutes apart: does attempt 2 carry attempt 1’s timestamp?',
    );

    // ── (a) the library — retry with a backoff longer than the skew window ────────────────────
    // The server fails every request with 503 (in `retry.on`'s default set), so all three attempts
    // run. A stale signature would arrive as a 403 instead, which is NOT retried — so under the
    // broken ordering the run would also STOP a retry early. Both effects are visible in the ledger.
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, failWith: 503 });
        const signed: SignEvent[] = [];
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: clockSigV4({ ...CREDS, clock }, signed),
            retry: { attempts: ATTEMPTS, backoff: BACKOFF },
            clock,
        });

        const pending = call({}).safe();
        await runOut(clock, 30 * MIN);
        const result = await pending;

        check('(a) attempts that reached the wire', aws.calls.length, ATTEMPTS);
        checkSeq(
            '(a) arrival time per attempt (virtual min from t0)',
            aws.calls.map((c) => (c.arrivedAt - T0) / MIN),
            [0, 6, 12],
        );
        checkSeq('(a) WIRE TIMESTAMP per attempt', aws.stamps(), [
            '20260805T120000Z',
            '20260805T120600Z',
            '20260805T121200Z',
        ]);
        checkSeq('(a) SIGNATURE AGE per attempt (ms)', aws.ages(), [0, 0, 0]);
        check(
            '(a) DISTINCT signatures — equal to the attempt count means no replay',
            aws.distinctSignatures(),
            ATTEMPTS,
        );
        checkSeq(
            '(a) status per attempt — 503 throughout, never a skew 403',
            aws.calls.map((c) => c.status),
            [503, 503, 503],
        );
        check('(a) the call still failed (503 is real)', result.ok, false);
        note(
            '(a) `auth.apply` invocations',
            `${String(signed.length)} for ${String(ATTEMPTS)} attempts`,
        );
    }

    // ── (b) THE CONTROL — signed once, before the retry loop ─────────────────────────────────
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, failWith: 503 });
        const headers = await presign(CREDS, URL_S3, T0);
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: presignedSigV4(headers),
            retry: { attempts: ATTEMPTS, backoff: BACKOFF },
            clock,
        });

        const pending = call({}).safe();
        await runOut(clock, 30 * MIN);
        await pending;

        checkSeq(
            '(b) control — SIGNATURE AGE per attempt (virtual min)',
            aws.ages().map((a) => a / MIN),
            [0, 6],
        );
        checkSeq(
            '(b) control — status per attempt',
            aws.calls.map((c) => c.status),
            [503, 403],
        );
        check(
            '(b) control — attempts that reached the wire (the 403 is terminal, so retry 3 never ran)',
            aws.calls.length,
            2,
        );
        check(
            '(b) control — DISTINCT signatures across those attempts',
            aws.distinctSignatures(),
            1,
        );
    }

    // ── (c) the SHIPPED signer on the real clock ─────────────────────────────────────────────
    {
        const aws = new FakeAws({ clock: systemClock, failWith: 503 });
        const signed: SignEvent[] = [];
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: stampedSigV4(CREDS, signed),
            retry: {
                attempts: ATTEMPTS,
                backoff: { curve: 'fixed', base: '1100ms' },
            },
        });

        const t0 = Date.now();
        await call({}).safe();
        const gaps = aws.calls.map(
            (c, i) => c.arrivedAt - (signed[i]?.at ?? NaN),
        );

        check('(c) real clock — attempts', aws.calls.length, ATTEMPTS);
        check(
            '(c) real clock — DISTINCT signatures from the SHIPPED awsSigV4',
            aws.distinctSignatures(),
            ATTEMPTS,
        );
        check(
            '(c) real clock — DISTINCT wire timestamps',
            new Set(aws.stamps()).size,
            ATTEMPTS,
        );
        note(
            '(c) real clock — arrival per attempt (ms from t0)',
            JSON.stringify(aws.calls.map((c) => c.arrivedAt - t0)),
        );
        note(
            '(c) real clock — sign→wire gap per attempt (ms)',
            JSON.stringify(gaps),
        );
        checkAtMost(
            '(c) real clock — WORST sign→wire gap (ms)',
            Math.max(...gaps),
            250,
        );
    }

    // ── (d) a server-directed `Retry-After` longer than the window ───────────────────────────
    // `retry.respect` defaults ON and is deliberately unbounded (engine.ts:775-798), so a server
    // saying `Retry-After: 600` parks the call for TEN MINUTES — twice the skew window — before the
    // next attempt. That is only survivable because the next attempt re-signs.
    {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, failWith: 503 });
        const base = aws.adapter();
        const call = stitch({
            url: URL_S3,
            // Wrap the fake so it also asks for a 10-minute wait, the way a throttled S3 would.
            adapter: async (req) => {
                const res = await base(req);
                return {
                    ...res,
                    headers: { ...res.headers, 'retry-after': '600' },
                };
            },
            auth: clockSigV4({ ...CREDS, clock }),
            retry: { attempts: 2 },
            clock,
        });

        const pending = call({}).safe();
        await runOut(clock, 30 * MIN);
        await pending;

        checkSeq(
            '(d) `Retry-After: 600` honoured — arrival per attempt (virtual min)',
            aws.calls.map((c) => (c.arrivedAt - T0) / MIN),
            [0, 10],
        );
        checkSeq(
            '(d) SIGNATURE AGE after a 10-minute server-directed wait (ms)',
            aws.ages(),
            [0, 0],
        );
        note(
            '(d) skew the server saw on attempt 2',
            `${String(aws.calls[1]?.skewMs)}ms after a 600000ms wait`,
        );
    }

    finish(
        'C1',
        'the request is signed PER ATTEMPT — 3 attempts 6 virtual minutes apart produced 3 distinct signatures aged 0ms each, and a 10-minute `Retry-After` wait still arrived fresh; the same call signed once measured 6 minutes and a terminal 403 on attempt 2',
    );
}

void main();
