// C6 — a `RequestTimeTooSkewed` 403 is the failure most likely to be retried and the one retry
// cannot fix. Is it retried by default? Can it be classified as terminal WITHOUT swallowing it?
//
// MEASURED, and the answers split three ways:
//
//   (a) NOT retried by default — `retry.on` defaults to `[429, 502, 503, 504]` (engine.ts:640) and
//       403 is not in it. One request, one failure. The library gets this right by default.
//   (b) But `retry` does not HELP either, and the reason is worth stating: with a drifting host the
//       engine re-signs on every attempt (C1) and every fresh signature carries the SAME wrong
//       clock. Four attempts, four distinct signatures, four identical skews of 600000ms. Signing
//       per attempt is necessary and completely insufficient.
//   (c) With `circuit` configured, a skew 403 IS counted as a dependency failure: it throws at
//       engine.ts:855-863 and `attemptWithCircuit` records it (engine.ts:910-922). Measured: a
//       misconfigured host clock opened the breaker and the next calls reported `503 circuit open`.
//       A local clock problem now reads as "S3 is down".
//   (d) THE FOOTGUN. `verdict: { accept: [403], flag: 'ok' }` — the pure-config classification that
//       worked in scenario 9 — SWALLOWS the skew error here, because `verdict.flag` is three-state
//       and an ABSENT flag is "no signal" (surface.ts:195-205). AWS's error envelope has no `ok`
//       field, so the flag never fires and `accept` alone succeeds on the 403. Measured: the call
//       returned `ok: true` and handed the caller `RequestTimeTooSkewed` AS ITS DATA.
//   (e) What does work is ~6 lines of `Surface.interpret` composing `verdictOf`: a real error for
//       the caller, and zero circuit failures.
//
//   pnpm exec tsx docs/scenarios/proofs/expiring-signatures/c6-skew-403-classification.ts
import { stitch, verdictOf } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type { StitchConfig } from '../../../../packages/core/src/types';
import { FakeAws, isSkewError, outcomeOf } from './fake-aws';
import { check, checkSeq, finish, heading, note } from './harness';
import { CREDS, clockSigV4 } from './signers';
import { drain, runOut } from './virtual-time';

const URL_S3 = 'https://bucket.s3.us-east-1.amazonaws.com/key';
const T0 = Date.UTC(2026, 7, 5, 12, 0, 0);
const MIN = 60_000;
/** The host is ten minutes behind the server. Every signature it mints is already outside the window. */
const DRIFT = 10 * MIN;

/**
 * The classification that actually works: reject a skew 403 on its BODY, so it reaches the caller as
 * a real failure while staying off the transport-health signal the breaker reads.
 *
 * Six lines, and every one of them is load-bearing. `verdictOf` first so `retry.on`/`verdict.accept`
 * keep their meaning; then the skew check; then the default "body is the value".
 */
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

async function main(): Promise<void> {
    heading(
        'C6 — a RequestTimeTooSkewed 403 from a drifting host: retried? classifiable? swallowed?',
    );

    const rig = (
        extra: Partial<StitchConfig> = {},
    ): {
        aws: FakeAws;
        call: ReturnType<typeof stitch>;
        clock: ReturnType<typeof manualClock>;
    } => {
        const clock = manualClock(T0);
        const aws = new FakeAws({ clock, skewMs: DRIFT });
        const call = stitch({
            url: URL_S3,
            adapter: aws.adapter(),
            auth: clockSigV4({ ...CREDS, clock }),
            clock,
            ...extra,
        });
        return { aws, call, clock };
    };

    // ── (a) is a 403 retried by default? ────────────────────────────────────────────────────
    {
        const { aws, call } = rig({ retry: { attempts: 4 } });
        const outcome = await outcomeOf(() => call({}));
        await drain();

        check('(a) outcome', outcome, '403');
        check(
            '(a) requests that reached the wire, with `retry: { attempts: 4 }`',
            aws.calls.length,
            1,
        );
        note(
            '(a) why',
            '`retry.on` defaults to [429,502,503,504] (engine.ts:640); 403 is not in it',
        );
    }

    // ── (b) and if someone adds 403 to `retry.on`? ──────────────────────────────────────────
    // The natural reading of a 403 is "auth blip, retry it". This is what that costs.
    {
        const { aws, call, clock } = rig({
            retry: {
                attempts: 4,
                on: [403, 429, 502, 503, 504],
                // `fixed`, and two whole seconds. The default `expo-jitter` curve puts all four
                // attempts inside one virtual second with fractional-millisecond offsets, and
                // `x-amz-date` has ONE-SECOND resolution — so the four genuinely-re-signed requests
                // would carry one identical timestamp and one identical signature, which reads as a
                // replay and is not one. Spacing the attempts past the resolution makes the
                // re-signing visible.
                backoff: { curve: 'fixed', base: '2s' },
            },
        });
        // The retry backoffs sleep on the INJECTED clock, so the call cannot progress unless
        // something advances it. (Nothing hangs the process: a manualClock timer is an array entry,
        // not a real one, so an undriven run simply exits with the event loop empty.)
        const pending = outcomeOf(() => call({}));
        await runOut(clock, MIN, 1_000);
        const outcome = await pending;

        check('(b) outcome after 4 attempts', outcome, '403');
        check('(b) requests that reached the wire', aws.calls.length, 4);
        check(
            '(b) DISTINCT signatures — every attempt WAS re-signed',
            aws.distinctSignatures(),
            4,
        );
        checkSeq(
            '(b) the skew the server measured on each fresh signature (ms)',
            aws.calls.map((c) => c.skewMs),
            [DRIFT, DRIFT, DRIFT, DRIFT],
        );
        note(
            '(b) the lesson',
            'per-attempt signing does not correct a wrong clock — it faithfully re-mints the same wrong time',
        );
    }

    // ── (c) the circuit reads a local clock fault as a dependency outage ────────────────────
    {
        const { aws, call } = rig({
            circuit: { failures: 2, cooldown: '30s' },
        });
        const spine: string[] = [];
        for (let i = 0; i < 4; i++) {
            spine.push(await outcomeOf(() => call({})));
            await drain();
        }

        checkSeq(
            '(c) outcome per call — the host clock is wrong, and the breaker opens on it',
            spine,
            ['403', '403', '503', '503'],
        );
        check('(c) requests that reached the wire', aws.calls.length, 2);
        note(
            '(c) what the page says',
            '`circuit open` / 503 — a dependency outage, for a fault entirely inside this process',
        );
    }

    // ── (d) THE FOOTGUN — the pure-config classification swallows it ───────────────────────
    {
        const { aws, call } = rig({
            circuit: { failures: 2, cooldown: '30s' },
            verdict: { accept: [403], flag: 'ok' },
        });
        const result = await call({}).safe();
        await drain();

        check(
            '(d) `verdict: { accept: [403], flag: "ok" }` — did the call SUCCEED?',
            result.ok,
            true,
        );
        check(
            '(d) and the code the caller received as its DATA',
            (result.data as { Error?: { Code?: string } } | undefined)?.Error
                ?.Code,
            'RequestTimeTooSkewed',
        );
        check('(d) requests that reached the wire', aws.calls.length, 1);
        note(
            '(d) why the `flag` did not save it',
            '`verdict.flag` is three-state; an ABSENT flag is "no signal" (surface.ts:195-205). AWS error bodies have no `ok` field, so the flag never fires and `accept` alone succeeds on the 403',
        );
    }

    // ── (e) the classification that works ──────────────────────────────────────────────────
    {
        const { aws, call } = rig({
            kind: skewAwareSurface,
            circuit: { failures: 2, cooldown: '30s' },
            verdict: { accept: [403] },
        });
        const spine: string[] = [];
        for (let i = 0; i < 4; i++) {
            spine.push(await outcomeOf(() => call({})));
            await drain();
        }

        checkSeq(
            '(e) outcome per call — a real error every time, and the breaker never trips',
            spine,
            ['403', '403', '403', '403'],
        );
        check(
            '(e) requests that reached the wire — no fast-fail, so 4 of 4',
            aws.calls.length,
            4,
        );
        note(
            '(e) the mechanism',
            'a surface rejection returns `{ ok: false }` rather than throwing, so `attemptWithCircuit` records a circuit SUCCESS (engine.ts:905-908) while the caller still gets a failure',
        );
        note(
            '(e) cost',
            '6 lines of `Surface.interpret` + `verdict: { accept: [403] }`',
        );
    }

    finish(
        'C6',
        'a skew 403 is NOT retried by default (1 request with attempts:4) — but it IS counted as a circuit failure, so a local clock fault reports `503 circuit open`; and the pure-config `verdict: { accept, flag }` SWALLOWS it (ok:true, RequestTimeTooSkewed handed over as data) because AWS bodies carry no flag. 6 lines of surface fix both',
    );
}

void main();
