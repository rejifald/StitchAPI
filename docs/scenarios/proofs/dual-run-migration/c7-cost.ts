// C7 — COST. The shadow spends the VENDOR's meter, not yours. Three questions:
//
//   (1) does the shadow double rate-limit consumption?
//   (2) does a shared `throttle` correctly account for BOTH calls?
//   (3) is sampling ("shadow 5% of reads") expressible in config, or is it user code?
//
// TIMING: real clock throughout, deliberately. `manualClock()` DOES drive throttle pacing — which
// is exactly why it is unusable here: nothing advances it, so the first paced call never resolves.
// The rates are chosen small (`'20/s'` = a 50ms gap) so a real-time measurement stays fast, and
// every elapsed figure is reported as a band rather than an exact number.
import { seam } from '../../../../packages/core/src/seam';
import { stitch } from '../../../../packages/core/src/stitch';
import {
    check,
    checkBand,
    countUserLines,
    finish,
    heading,
    ledgerRow,
    note,
    printLedger,
} from './harness';
import { HOST, elapsed, fakeVendor, seededRandom } from './vendor';

import { readFileSync } from 'node:fs';

const V1_PATH = '/v1/customers/{id}';
const V2_PATH = '/v2/customers';
/** `'20/s'` is a 50ms minimum spacing — the throttle paces, it does not bucket (types.ts:1052-1077). */
const RATE = '20/s';
const GAP = 50;

async function main(): Promise<void> {
    // -----------------------------------------------------------------------
    heading('C7 (1) — does the shadow double what the vendor is charged for?');
    {
        const vendor = fakeVendor({});
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

        const N = 20;
        for (let i = 0; i < N; i++) await v1({ params: { id: `cus_${i}` } });
        const soloTotal = vendor.log.length;
        check('20 logical calls, primary only', soloTotal, 20);
        ledgerRow(
            'primary only, 20 calls',
            vendor.count('v1'),
            vendor.count('v2'),
            '20 billed',
        );

        vendor.reset();
        for (let i = 0; i < N; i++) {
            const shadow = v2.safe({ query: { customer_id: `cus_${i}` } });
            await v1({ params: { id: `cus_${i}` } });
            await shadow;
        }
        check('20 logical calls, dual-run — v1', vendor.count('v1'), 20);
        check('20 logical calls, dual-run — v2', vendor.count('v2'), 20);
        check('total requests the vendor received', vendor.log.length, 40);
        check('the multiplier', vendor.log.length / soloTotal, 2);
        ledgerRow(
            'dual-run 100%, 20 calls',
            vendor.count('v1'),
            vendor.count('v2'),
            '40 billed — 2x',
        );
        note(
            'there is no deduplication anywhere: two stitches, two requests, two meter ticks',
        );
    }

    // -----------------------------------------------------------------------
    heading('C7 (2) — does a shared `throttle` account for BOTH calls?');
    // The measurement is PACING, in real milliseconds. Four requests through one limiter at a 50ms
    // gap take ~150ms; four requests through two independent limiters take ~50ms. The elapsed time
    // is therefore a direct read of how many buckets there are.

    // (2a) Two standalone stitches, each with its own `throttle`. The default `pool` is `'stitch'`.
    {
        const vendor = fakeVendor({});
        const v1 = stitch({
            baseUrl: HOST,
            path: V1_PATH,
            adapter: vendor.adapter,
            name: 'cust-v1',
            throttle: RATE,
        });
        const v2 = stitch({
            baseUrl: HOST,
            path: V2_PATH,
            adapter: vendor.adapter,
            name: 'cust-v2',
            throttle: RATE,
        });
        const r = await elapsed(async () => {
            await Promise.all([
                v1({ params: { id: 'a' } }),
                v2({ query: { customer_id: 'a' } }),
                v1({ params: { id: 'b' } }),
                v2({ query: { customer_id: 'b' } }),
            ]);
        });
        note('4 requests, two standalone stitches at 20/s each', `${r.ms}ms`);
        checkBand(
            'elapsed ≈ ONE gap — the two versions paced independently',
            r.ms,
            0,
            GAP + 45,
        );
        check('the vendor still received all 4', vendor.log.length, 4);
        ledgerRow(
            `standalone throttle: '${RATE}' each`,
            vendor.count('v1'),
            vendor.count('v2'),
            `${r.ms}ms — 2 buckets, 40/s at the vendor`,
        );
    }

    // (2b) Two members of ONE seam. `seamBucket` re-keys every acquire onto `seam:<id>`
    // (seam.ts:51-69), so a seam-level throttle is ONE budget across all members.
    {
        const vendor = fakeVendor({});
        const vendorSeam = seam({
            baseUrl: HOST,
            adapter: vendor.adapter,
            throttle: RATE,
        });
        const v1 = vendorSeam.stitch({ path: V1_PATH });
        const v2 = vendorSeam.stitch({ path: V2_PATH });
        const r = await elapsed(async () => {
            await Promise.all([
                v1({ params: { id: 'a' } }),
                v2({ query: { customer_id: 'a' } }),
                v1({ params: { id: 'b' } }),
                v2({ query: { customer_id: 'b' } }),
            ]);
        });
        note(
            '4 requests, two seam members sharing one 20/s budget',
            `${r.ms}ms`,
        );
        checkBand(
            'elapsed ≈ THREE gaps — one bucket, correctly counting both',
            r.ms,
            GAP * 2,
            GAP * 5,
        );
        check('the vendor still received all 4', vendor.log.length, 4);
        ledgerRow(
            `seam throttle: '${RATE}'`,
            vendor.count('v1'),
            vendor.count('v2'),
            `${r.ms}ms — 1 bucket, 20/s at the vendor`,
        );
        note(
            'a seam accounts for the shadow correctly BY DEFAULT — this is the one cost question the library already answers',
        );
    }

    // (2c) `pool: 'host'` — the other way to get one bucket, and the one C1 (d4) measured as the
    // trap: it also re-keys the CIRCUIT onto the host.
    {
        const vendor = fakeVendor({});
        const opts = { rate: RATE, pool: 'host' } as const;
        const v1 = stitch({
            baseUrl: HOST,
            path: V1_PATH,
            adapter: vendor.adapter,
            name: 'cust-v1',
            throttle: opts,
        });
        const v2 = stitch({
            baseUrl: HOST,
            path: V2_PATH,
            adapter: vendor.adapter,
            name: 'cust-v2',
            throttle: opts,
        });
        const r = await elapsed(async () => {
            await Promise.all([
                v1({ params: { id: 'a' } }),
                v2({ query: { customer_id: 'a' } }),
                v1({ params: { id: 'b' } }),
                v2({ query: { customer_id: 'b' } }),
            ]);
        });
        note(
            "4 requests, two standalone stitches with pool:'host'",
            `${r.ms}ms`,
        );
        checkBand(
            "elapsed ≈ THREE gaps — pool:'host' pools across separate stitches",
            r.ms,
            GAP * 2,
            GAP * 5,
        );
        ledgerRow(
            `standalone pool:'host'`,
            vendor.count('v1'),
            vendor.count('v2'),
            `${r.ms}ms — 1 bucket, and a SHARED BREAKER (C1 d4)`,
        );
        note(
            "pool:'host' uses a MODULE-LEVEL registry (resilience.ts:84), so it pools across separately-constructed stitches with no shared store",
        );
    }

    // -----------------------------------------------------------------------
    heading('C7 (3) — is sampling expressible in config?');
    {
        const vendor = fakeVendor({});
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

        // There is no `sample`, `ratio`, `percent`, or `probability` slot anywhere on the config
        // surface — C3 enumerated the whole public barrel and the 17 subpaths. The closest thing in
        // the tree is `trace`'s sink wiring, which samples nothing. So: user code.
        const rand = seededRandom(20260805);
        const SAMPLE = 0.05;
        // >>> BEGIN USER CODE sampling
        const shadowed = (id: string) => {
            const primary = v1({ params: { id } });
            if (rand() < SAMPLE) void v2.safe({ query: { customer_id: id } });
            return primary;
        };
        // <<< END USER CODE sampling

        const N = 400;
        for (let i = 0; i < N; i++) await shadowed(`cus_${i}`);
        await new Promise((r) => setTimeout(r, 50));

        check('every primary call went out', vendor.count('v1'), N);
        const sampled = vendor.count('v2');
        note('shadow calls at a 5% sample over 400 primaries', sampled);
        checkBand(
            'the sample lands near 5% (deterministic PRNG, seed 20260805)',
            sampled,
            8,
            34,
        );
        check('total vendor requests', vendor.log.length, N + sampled);
        const multiplier = (N + sampled) / N;
        note('the multiplier at 5%', multiplier.toFixed(3));
        checkBand(
            'the cost multiplier is near 1.05x, not 2x',
            multiplier * 1000,
            1020,
            1085,
        );
        ledgerRow(
            'sampled dual-run 5%, 400 calls',
            vendor.count('v1'),
            sampled,
            `${multiplier.toFixed(3)}x — vs 2.000x unsampled`,
        );

        const src = readFileSync(new URL(import.meta.url), 'utf8');
        const lines = countUserLines(src, 'sampling');
        note('executable lines for sampling', lines);
        check('sampling is 5 lines or fewer of user code', lines <= 5, true);
    }

    printLedger('C7 — what the vendor was actually charged for');

    console.log(`
  THE COST LEDGER

    question                                      answer
    --------------------------------------------  ------------------------------------------------
    does the shadow double consumption?           YES, exactly 2.000x. No dedup anywhere.
    does a per-stitch throttle account for both?  NO — two buckets, so the configured 20/s
                                                  became 40/s at the vendor.
    does a SEAM throttle account for both?        YES, by default. seamBucket re-keys every
                                                  acquire onto one seam id (seam.ts:51-69).
    does pool:'host' account for both?            YES — and it drags the CIRCUIT onto the host
                                                  key with it (measured in C1 d4).
    is sampling expressible in config?            NO. No sample/ratio/percent slot exists.
                                                  5 lines of user code; 2.000x -> 1.05x.

  The sharp edge is that the two ways to make the METER accounting correct are not equivalent. A
  seam gets it right and leaves the breaker keyed per path. \`pool: 'host'\` gets it right and
  silently re-keys the breaker onto the host, which is the exact configuration C1 measured taking
  the primary down. A consumer reaching for \`pool: 'host'\` is reaching for it for a good reason
  — the two versions genuinely do share one vendor quota — and gets an unasked-for shared breaker.
`);

    finish(
        'C7',
        "MEASURED. The shadow doubles consumption exactly — 20 logical calls became 40 vendor requests, a 2.000x multiplier, with no deduplication anywhere. A per-stitch `throttle` does NOT account for both: two standalone stitches each configured `20/s` put 4 requests through in ~1 gap, so the vendor saw 40/s. Two constructions fix it, and they are not equivalent: a SEAM-level throttle is one bucket by default (seamBucket re-keys every acquire onto one seam id) and leaves the breaker keyed per path, while `pool: 'host'` also pools correctly but drags the CIRCUIT onto the host key with it — the same setting C1 (d4) measured fast-failing the primary on the shadow's breaker. Sampling is not expressible in config: no sample/ratio/percent slot exists on any of the 17 subpaths, and 5 lines of user code took the multiplier from 2.000x to 1.05x",
    );
}

void main();
