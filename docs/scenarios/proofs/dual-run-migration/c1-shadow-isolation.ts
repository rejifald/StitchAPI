// C1 — DECIDING CLAIM. Can the shadow be made unable to hurt the primary?
//
// "Unable to hurt" is not one property, it is FOUR, and they have four different answers. This
// script measures each separately and fills the table in `printChannels()`:
//
//   (a) LATENCY  — does awaiting the shadow put its wall-clock on the caller's critical path?
//   (b) THROWN   — does a shadow failure reach the caller as a thrown error?
//   (c) RETRY    — does the shadow consume the primary's retry budget?
//   (d) CIRCUIT  — do the shadow's failures open a breaker the primary uses?
//
// (d) carries a PRE-REGISTERED PREDICTION from scenario 9 / issue #641: "resilience state is shared
// unless keyed by hand", so a flaky v2 may open a breaker that takes down v1. It is measured here as
// five separate configurations, because the answer turns out to depend on TWO things at once (the
// store instance and the key string) and a single yes/no would misreport four of the five.
//
// TIMING: (a) is wall-clock — real `setTimeout` in the fake transport, `performance.now()` at the
// caller. (d) uses `manualClock()`, which DOES drive circuit cooldown. See harness.ts.
import { all } from '../../../../packages/core/src/pipe';
import { seam } from '../../../../packages/core/src/seam';
import { stitch } from '../../../../packages/core/src/stitch';
import { manualClock } from '../../../../packages/core/src/test-clock';
import type {
    SafeResult,
    StitchInput,
} from '../../../../packages/core/src/types';
import {
    channelRow,
    check,
    checkBand,
    finish,
    heading,
    ledgerRow,
    note,
    printChannels,
    printLedger,
} from './harness';
import { HOST, elapsed, fakeVendor } from './vendor';

const V1_PATH = '/v1/customers/{id}';
const V2_PATH = '/v2/customers';

async function main(): Promise<void> {
    // ---------------------------------------------------------------------------
    heading(
        "C1 (a) — LATENCY: does the shadow land on the caller's critical path?",
    );
    // v1 answers in 10ms, v2 in 120ms. Any spelling that AWAITS both pays 120ms; the question is
    // whether a spelling exists that does not.
    {
        const vendor = fakeVendor({ latency: { v1: 10, v2: 120 } });
        const v1 = stitch({
            baseUrl: HOST,
            path: V1_PATH,
            adapter: vendor.adapter,
            name: 'cust-v1',
        });
        const v2 = stitch({
            baseUrl: HOST,
            path: V2_PATH,
            adapter: vendor.adapter,
            name: 'cust-v2',
        });

        // The baseline: the primary alone. Everything else is measured against this.
        const solo = await elapsed(() => v1({ params: { id: 'cus_7Q2' } }));
        note('primary alone (v1, 10ms endpoint)', `${solo.ms}ms`);

        // Spelling 1 — the combinator that looks purpose-built for this.
        const both = await elapsed(() =>
            all([v1, v2])({ params: { id: 'cus_7Q2' } }),
        );
        note('all([v1, v2]) — awaits both', `${both.ms}ms`);

        // Spelling 2 — fire-and-forget. The shadow is started and deliberately NOT awaited.
        const ff = await elapsed(async () => {
            const primary = v1({ params: { id: 'cus_7Q2' } });
            void v2({ params: { id: 'cus_7Q2' } }).catch(() => undefined);
            return primary;
        });
        note('fire-and-forget (shadow not awaited)', `${ff.ms}ms`);

        checkBand(
            'all([v1,v2]) caller-observed ms (≈ the SLOWEST member)',
            both.ms,
            110,
            220,
        );
        checkBand(
            'fire-and-forget caller-observed ms (≈ the PRIMARY alone)',
            ff.ms,
            5,
            60,
        );
        const added = both.ms - solo.ms;
        note('added latency, all() vs primary alone', `${added}ms`);
        check(
            'fire-and-forget adds less than 25ms over the primary alone',
            ff.ms - solo.ms < 25,
            true,
        );

        channelRow({
            channel: '(a) latency',
            safeByDefault: false,
            measured: `${both.ms}ms vs ${ff.ms}ms`,
            fix: 'do NOT await the shadow — no combinator does this; user code',
        });

        // A fire-and-forget shadow still has to be allowed to finish before the process exits, or the
        // measurement below counts a request the vendor never actually received.
        await new Promise((r) => setTimeout(r, 200));
        ledgerRow(
            'all([v1,v2]) + fire-and-forget, 3 logical calls',
            vendor.count('v1'),
            vendor.count('v2'),
            `${both.ms}ms / ${ff.ms}ms`,
        );
    }

    // ---------------------------------------------------------------------------
    heading('C1 (b) — THROWN: does a shadow failure reach the caller?');
    {
        // v2 answers 500 forever; v1 is healthy.
        const vendor = fakeVendor({ statuses: { v2: [500, 500, 500, 500] } });
        const v1 = stitch({
            baseUrl: HOST,
            path: V1_PATH,
            adapter: vendor.adapter,
            name: 'cust-v1',
        });
        const v2 = stitch({
            baseUrl: HOST,
            path: V2_PATH,
            adapter: vendor.adapter,
            name: 'cust-v2',
        });

        // Spelling 1 — `all` is FAIL-FAST by construction: the first failure rejects the group.
        const viaAll = await elapsed(() =>
            all([v1, v2])({ params: { id: 'cus_7Q2' } }),
        );
        const allErr = viaAll.error as Error | undefined;
        note(
            'all([v1,v2]) threw',
            allErr ? allErr.constructor.name : 'nothing',
        );
        check(
            'all() surfaces the shadow failure to the caller',
            allErr !== undefined,
            true,
        );

        // Spelling 2 — the shadow is floated with an explicit `.catch`.
        vendor.reset();
        const caught = await elapsed(async () => {
            const primary = v1({ params: { id: 'cus_7Q2' } });
            void v2({ params: { id: 'cus_7Q2' } }).catch(() => undefined);
            return primary;
        });
        await new Promise((r) => setTimeout(r, 60));
        check(
            'float + .catch() reaches the caller',
            caught.error !== undefined,
            false,
        );
        check(
            'float + .catch() DID send the shadow request',
            vendor.count('v2'),
            1,
        );
        note(
            'float + .catch() caller result',
            caught.value !== undefined ? 'a v1 value' : 'nothing',
        );

        // Spelling 3 — `.safe()` never throws at all.
        const safe = await v2.safe({ params: { id: 'cus_7Q2' } });
        check('.safe() on the failing shadow throws', false, false);
        check('.safe().ok', safe.ok, false);

        // THE HAZARD, and it is NOT the one the capture would predict. `StitchResult` is a LAZY
        // `PromiseLike` (types.ts:1905), not a Promise: nothing runs until something subscribes. So
        // the most natural fire-and-forget spelling in the language —
        //
        //     void v2(input);            // "shadow it and move on"
        //
        // does not fail loudly. It does not run AT ALL. There is no request, no rejection, and no
        // unhandledRejection to tell you: the dual-run silently compares nothing, forever.
        vendor.reset();
        let unhandled: string | undefined;
        const onUnhandled = (reason: unknown) => {
            unhandled = (reason as Error)?.constructor?.name ?? String(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        {
            const primary = v1({ params: { id: 'cus_7Q2' } });
            void v2({ params: { id: 'cus_7Q2' } }); // NO subscription — the mistake this measures
            await primary;
        }
        await new Promise((r) => setTimeout(r, 60));
        const bareVoidRequests = vendor.count('v2');
        check(
            'bare `void v2(input)` sent ZERO shadow requests (lazy thenable)',
            bareVoidRequests,
            0,
        );
        check(
            '...and therefore raised no unhandledRejection either',
            unhandled,
            undefined,
        );

        // The construction that DOES leave a rejection unhandled: subscribe (so it runs) but attach
        // no rejection handler. `Promise.resolve(...)` on the thenable is the ordinary way to do it
        // by accident — e.g. handing the shadow to `Promise.allSettled`'s cousin, or logging it.
        vendor.reset();
        {
            const primary = v1({ params: { id: 'cus_7Q2' } });
            void Promise.resolve(v2({ params: { id: 'cus_7Q2' } })); // subscribed, unguarded
            await primary;
        }
        await new Promise((r) => setTimeout(r, 60));
        process.off('unhandledRejection', onUnhandled);
        check(
            'subscribing without a handler DID send the request',
            vendor.count('v2'),
            1,
        );
        check(
            '...and it raises an unhandledRejection',
            unhandled !== undefined,
            true,
        );
        note('unhandledRejection reason class', unhandled ?? 'none');

        channelRow({
            channel: '(b) thrown',
            safeByDefault: false,
            measured: `all(): threw; .safe(): ok:false`,
            fix: '`void v2.safe(input)` — fires AND cannot reject. `void v2(input)` never fires',
        });
    }

    // ---------------------------------------------------------------------------
    heading(
        "C1 (c) — RETRY: does the shadow consume the primary's retry budget?",
    );
    {
        // Both stitches ask for 3 attempts. v2's endpoint answers 503 (a default-retryable status)
        // three times; v1's answers 200 immediately. If the budget were shared, v1's request count
        // would move.
        //
        // REAL CLOCK, deliberately. A `manualClock()` DOES drive retry backoff — which is exactly
        // why it cannot be used here: nothing advances it, so the first backoff sleep never resolves
        // and the script hangs. This channel measures COUNTS, not timing, so a real clock with a
        // 1ms fixed backoff is both honest and fast.
        const vendor = fakeVendor({ statuses: { v2: [503, 503, 503, 503] } });
        const backoff = { curve: 'fixed', base: 1 } as const;
        const v1 = stitch({
            baseUrl: HOST,
            path: V1_PATH,
            adapter: vendor.adapter,
            name: 'cust-v1',
            retry: { attempts: 3, backoff },
        });
        const v2 = stitch({
            baseUrl: HOST,
            path: V2_PATH,
            adapter: vendor.adapter,
            name: 'cust-v2',
            retry: { attempts: 3, backoff },
        });

        await v2.safe({ params: { id: 'cus_7Q2' } });
        const v2Attempts = vendor.count('v2');
        await v1({ params: { id: 'cus_7Q2' } });
        const v1Attempts = vendor.count('v1');

        check('shadow burned its own attempts (retry: 3)', v2Attempts, 3);
        check(
            'primary still got its full first attempt (1 call, 1 request)',
            v1Attempts,
            1,
        );
        note(
            'retry budget is a local loop counter (engine.ts:610,624) — per call, never shared',
        );
    }
    // BUT: there is a FIFTH way the shadow reaches the primary that the capture did not list, and it
    // lives next door to this channel. `all` AUTO-CANCELS its members on the first failure (pipe.ts:115
    // `ctrl.abort()`), so a shadow that fails FAST cancels a primary that is still in flight. The
    // primary does not merely surface an error — its request is killed on the wire.
    heading(
        'C1 (c*) — CANCEL: does a shadow failure kill the in-flight primary?',
    );
    {
        const vendor = fakeVendor({
            latency: { v1: 120, v2: 0 },
            statuses: { v2: [500] },
        });
        const slowPrimary = stitch({
            baseUrl: HOST,
            path: V1_PATH,
            adapter: vendor.adapter,
            name: 'cust-v1',
        });
        const fastFailShadow = stitch({
            baseUrl: HOST,
            path: V2_PATH,
            adapter: vendor.adapter,
            name: 'cust-v2',
        });

        const r = await elapsed(() =>
            all([slowPrimary, fastFailShadow])({ params: { id: 'cus_7Q2' } }),
        );
        await new Promise((res) => setTimeout(res, 200));
        const primaryCall = vendor.log.find((c) => c.version === 'v1');
        check(
            'all(): the primary request reached the vendor',
            primaryCall !== undefined,
            true,
        );
        check(
            "all(): the shadow's failure ABORTED the in-flight primary",
            primaryCall?.aborted,
            true,
        );
        check(
            'all(): the primary never completed',
            primaryCall?.completed,
            false,
        );
        note(
            'the group AbortController (pipe.ts:57-71, aborted at pipe.ts:115) is linked to every member',
        );
        note('caller-observed ms for the aborted group', `${r.ms}ms`);

        channelRow({
            channel: '(c) retry',
            safeByDefault: true,
            measured: `v1 requests: 1 of 1`,
            fix: '— (budget is a per-call loop counter). But see (c*) below',
        });
        channelRow({
            channel: '(c*) cancel',
            safeByDefault: false,
            measured: `primary aborted: ${String(primaryCall?.aborted)}`,
            fix: 'never put the shadow in `all()` — it auto-cancels the primary',
        });
    }

    // ---------------------------------------------------------------------------
    heading(
        "C1 (d) — CIRCUIT: do the shadow's failures open a breaker the primary uses?",
    );
    // PRE-REGISTERED PREDICTION (scenario 9 / issue #641): "resilience state is shared unless keyed by
    // hand". Measured as five configurations, because the breaker's identity is
    //   (store instance) x ('circuit:' + (circuit.key ?? cfg.name ?? cfg.path ?? 'stitch'))
    // — resilience.ts:353 over engine.ts:857-862, engine.ts:265-274, engine.ts:140 — and the prediction
    // is right for some of those and wrong for others.
    //
    // The probe is the same every time: fail the SHADOW until its breaker trips, then call the PRIMARY
    // once and count whether the vendor received that request. A request that never arrives was
    // fast-failed by a breaker the shadow opened.

    /** Trip the shadow, then call the primary once. Returns what the vendor saw and what the caller got. */
    // The probe only ever calls `.safe()`, so it asks for exactly that. Naming the full
    // `Stitch<unknown>` would not typecheck: a `path`-templated stitch NARROWS its own input type
    // (`params` becomes required), so `Stitch<unknown, {params: {...}}>` is not assignable to
    // `Stitch<unknown, StitchInput>`.
    type Probed = {
        safe(input?: StitchInput): Promise<SafeResult<unknown>>;
    };
    async function probe(
        label: string,
        build: (adapter: ReturnType<typeof fakeVendor>) => {
            v1: Probed;
            v2: Probed;
        },
    ): Promise<{ primaryRequests: number; callerError: string }> {
        const vendor = fakeVendor({ statuses: { v2: [500, 500, 500, 500] } });
        const { v1, v2 } = build(vendor);
        // circuit: [2, '60s'] — two consecutive failures trip it.
        await v2.safe({ params: { id: 'cus_7Q2' } });
        await v2.safe({ params: { id: 'cus_7Q2' } });
        const before = vendor.count('v1');
        const primary = await v1.safe({ params: { id: 'cus_7Q2' } });
        const primaryRequests = vendor.count('v1') - before;
        // A fast-fail comes back through `.safe()` as a `StitchError` whose MESSAGE carries the
        // breaker's own words — the `CircuitOpenError` class is flattened on the awaited path — so
        // the message is what identifies it, not the constructor name.
        const err = primary.error as (Error & { status?: number }) | undefined;
        const callerError = primary.ok
            ? 'ok'
            : err?.message === 'circuit open'
              ? 'circuit open'
              : `${err?.name ?? 'error'} ${err?.status ?? ''}`.trim();
        ledgerRow(label, primaryRequests, vendor.count('v2'), callerError);
        return { primaryRequests, callerError };
    }

    const CIRCUIT = [2, '60s'] as [number, string];

    // (d1) Two standalone stitches. No shared store. Distinct paths.
    const d1 = await probe('d1 standalone, distinct paths', (vendor) => ({
        v1: stitch({
            baseUrl: HOST,
            path: V1_PATH,
            adapter: vendor.adapter,
            circuit: CIRCUIT,
            clock: manualClock(),
        }),
        v2: stitch({
            baseUrl: HOST,
            path: V2_PATH,
            adapter: vendor.adapter,
            circuit: CIRCUIT,
            clock: manualClock(),
        }),
    }));
    check(
        '(d1) standalone stitches: primary still reached the vendor',
        d1.primaryRequests,
        1,
    );

    // (d2) ONE seam — the natural way to configure a vendor once. The seam SHARES one store
    // (seam.ts:229, stitch.ts:985). Paths still distinct.
    const d2 = await probe('d2 shared seam, distinct paths', (vendor) => {
        const vendorSeam = seam({
            baseUrl: HOST,
            adapter: vendor.adapter,
            circuit: CIRCUIT,
            clock: manualClock(),
        });
        return {
            v1: vendorSeam.stitch({ path: V1_PATH }),
            v2: vendorSeam.stitch({ path: V2_PATH }),
        };
    });
    check(
        '(d2) shared seam, distinct paths: primary still reached the vendor',
        d2.primaryRequests,
        1,
    );

    // (d3) THE TRAP. A shared seam AND a colliding key. Here the two versions live on different
    // ORIGINS but the same PATH — `api.vendor.test` vs `v2.vendor.test`, `/customers` on both — which
    // is an entirely ordinary way for a vendor to ship a v2. `nameOf` reads `cfg.name ?? cfg.path`, so
    // both stitches key on `'circuit:/customers'`.
    const d3 = await probe('d3 shared seam, SAME path', (vendor) => {
        const vendorSeam = seam({
            adapter: vendor.adapter,
            circuit: CIRCUIT,
            clock: manualClock(),
        });
        return {
            // Both spell `path: '/customers'`; only the origin differs. The fake routes on the
            // /v1 or /v2 prefix in the URL, so the origin carries the version here.
            v1: vendorSeam.stitch({
                baseUrl: `${HOST}/v1`,
                path: '/customers',
            }),
            v2: vendorSeam.stitch({
                baseUrl: `${HOST}/v2`,
                path: '/customers',
            }),
        };
    });
    check(
        "(d3) shared seam + SAME path: primary was FAST-FAILED by the shadow's breaker",
        d3.primaryRequests,
        0,
    );
    check(
        "(d3) the caller got the shadow's breaker error, verbatim",
        d3.callerError,
        'circuit open',
    );

    // (d4) THE SECOND TRAP, and the one specific to a dual-run: `throttle: { pool: 'host' }` — the
    // setting you reach for BECAUSE v1 and v2 share the vendor's meter (C7) — silently re-keys the
    // CIRCUIT onto the URL host (engine.ts:266-272 feeding engine.ts:860). One host, one breaker,
    // even though the paths differ.
    const d4 = await probe('d4 shared seam + pool:host', (vendor) => {
        const vendorSeam = seam({
            baseUrl: HOST,
            adapter: vendor.adapter,
            circuit: CIRCUIT,
            // `pool: 'host'` ALONE — no rate, so nothing paces and nothing sleeps. That isolates
            // the effect being measured: the mere presence of this key moves the BREAKER's key
            // onto the URL host (engine.ts:266-272 feeding engine.ts:860).
            throttle: { pool: 'host' },
            clock: manualClock(),
        });
        return {
            v1: vendorSeam.stitch({ path: V1_PATH }),
            v2: vendorSeam.stitch({ path: V2_PATH }),
        };
    });
    check(
        '(d4) pool:host re-keys the breaker onto the HOST: primary fast-failed',
        d4.primaryRequests,
        0,
    );
    check(
        '(d4) the caller got the breaker error, verbatim',
        d4.callerError,
        'circuit open',
    );

    // (d5) The fix, measured: an explicit distinct `circuit.key` per version. This is the "keyed by
    // hand" the prediction names, and it is the ONLY lever — `CircuitOptions` has exactly three fields
    // (failures, cooldown, key) and `key` is a static string, not a function (types.ts:1145-1162).
    const d5 = await probe('d5 pool:host + explicit circuit.key', (vendor) => {
        const vendorSeam = seam({
            baseUrl: HOST,
            adapter: vendor.adapter,
            throttle: { pool: 'host' },
            clock: manualClock(),
        });
        return {
            v1: vendorSeam.stitch({
                path: V1_PATH,
                circuit: { failures: 2, cooldown: '60s', key: 'cust-v1' },
            }),
            v2: vendorSeam.stitch({
                path: V2_PATH,
                circuit: { failures: 2, cooldown: '60s', key: 'cust-v2' },
            }),
        };
    });
    check(
        '(d5) explicit circuit.key restores isolation: primary reached the vendor',
        d5.primaryRequests,
        1,
    );

    channelRow({
        channel: '(d) circuit',
        safeByDefault: false,
        measured: `d1/d2: 1 req · d3/d4: 0 req · d5: 1 req`,
        fix: "distinct `circuit.key` per version (or distinct `name`), and never `pool:'host'` unkeyed",
    });

    printChannels();
    printLedger('C1 — requests the vendor actually received');

    console.log(`
      READING THE (d) ROWS. The prediction "resilience state is shared unless keyed by hand" is
      HALF RIGHT, and the half that is wrong is the half that would have made this safe by accident:

        d1  standalone stitches, distinct paths  -> ISOLATED (each builds its own memoryStore)
        d2  one seam, distinct paths             -> ISOLATED (shared store, but the key is the path)
        d3  one seam, SAME path                  -> SHARED. v1 fast-failed on v2's breaker.
        d4  one seam + throttle pool:'host'      -> SHARED. The host became the key.
        d5  explicit distinct circuit.key        -> ISOLATED.

      So sharing is not the default; it is a COLLISION, and the collision is invisible in the config.
      Two stitches collide when they land on the same store AND the same string out of
      \`circuit.key ?? name ?? path ?? 'stitch'\`. The two ways a dual-run walks into it are both
      ordinary: a v2 that keeps the path and changes the origin (d3), and \`pool: 'host'\` (d4) — which
      is the setting a consumer reaches for precisely BECAUSE the two versions share the vendor's meter.
    `);

    finish(
        'C1',
        'the shadow CAN be made unable to hurt the primary, but only ONE of the four channels is safe by default: the retry budget. Latency, thrown errors and the circuit each need explicit construction — and a fifth channel the capture did not list (`all()` auto-cancelling the in-flight primary) is the most dangerous of them',
    );
}

void main();
