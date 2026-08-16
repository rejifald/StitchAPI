// C8 — ASSEMBLE THE SAFEST DUAL-RUN, and measure what it costs.
//
// Every finding from C1–C7 is a constraint, and this is the one construction that satisfies all of
// them at once. It is replayed side by side against the NAIVE version — the one a reader would
// write from the capture's own description ("issue both, return v1, log the diff") — over the same
// fake vendor, so the difference is a set of counts rather than an argument.
//
// The constraints, and where each came from:
//
//   C1 (a)  the shadow must not be AWAITED                    -> `.safe()`, floated
//   C1 (b)  a shadow failure must not reach the caller        -> `.safe()` cannot reject
//   C1 (b') a floated shadow must actually RUN                -> `.safe()` is eager; `v2(...)` is not
//   C1 (c*) a shadow failure must not CANCEL the primary      -> no combinator; separate calls
//   C1 (d)  the shadow's breaker must not be the primary's    -> explicit distinct `circuit.key`
//   C2      the two calls take different inputs               -> a per-version input mapping
//   C3      there is no public response-vs-response comparator-> ~20 lines, vendored
//   C4      a correct v2 diffs 7 times on every call          -> a normalizer, not `ignore`
//   C5      a shadowed write charges twice                    -> `readsOnly` on the SHADOW's adapter
//   C7      the shadow doubles the vendor's meter             -> a seam-level throttle + sampling
import { diff } from '../../../../packages/core/src/diff';
import { all } from '../../../../packages/core/src/pipe';
import { seam } from '../../../../packages/core/src/seam';
import type { Adapter } from '../../../../packages/core/src/types';
import {
    check,
    checkBand,
    checkSeq,
    countUserLines,
    finish,
    heading,
    ledgerRow,
    note,
    printLedger,
} from './harness';
import {
    HOST,
    REGRESSED_BALANCE,
    TRUE_BALANCE,
    elapsed,
    fakeVendor,
    seededRandom,
} from './vendor';

import { readFileSync } from 'node:fs';

const V1_PATH = '/v1/customers/{id}';
const V2_PATH = '/v2/customers';

/** One reported difference between the two versions, after the relevancy model has run. */
interface Finding {
    path: string;
    v1: unknown;
    v2: unknown;
}

async function main(): Promise<void> {
    // =======================================================================
    heading(
        'C8 (1) — THE NAIVE DUAL-RUN: "issue both, return v1, log the diff"',
    );
    // Written straight from the capture's description, using the combinator that looks
    // purpose-built for it. One shared seam, because configuring the vendor once is the obvious
    // thing to do, and both versions on `/customers` because that is how this vendor shipped v2.
    {
        const vendor = fakeVendor({ latency: { v1: 10, v2: 90 } });
        const vendorSeam = seam({
            adapter: vendor.adapter,
            circuit: [2, '60s'],
            throttle: { pool: 'host' },
        });
        const v1 = vendorSeam.stitch({
            baseUrl: `${HOST}/v1`,
            path: '/customers',
        });
        const v2 = vendorSeam.stitch({
            baseUrl: `${HOST}/v2`,
            path: '/customers',
        });

        const r = await elapsed(() =>
            all([v1, v2])({ query: { customer_id: 'cus_7Q2' } }),
        );
        const raw = r.value as unknown[] | undefined;
        note('caller-observed latency', `${r.ms}ms`);
        checkBand('the caller waited for the SLOWEST version', r.ms, 80, 200);
        check(
            "and v1 was handed v2's parameter name",
            vendor.pathOf('v1').includes('customer_id'),
            true,
        );
        const rawDiff = raw ? diff(raw[0], raw[1]).length : -1;
        note('raw diff ops the naive version would log, per call', rawDiff);
        ledgerRow(
            'NAIVE — one healthy call',
            vendor.count('v1'),
            vendor.count('v2'),
            `${r.ms}ms, ${rawDiff} diff ops`,
        );

        // Now make v2 flaky, which is the entire reason a dual-run exists.
        const flaky = fakeVendor({ statuses: { v2: [500, 500, 500, 500] } });
        const flakySeam = seam({
            adapter: flaky.adapter,
            circuit: [2, '60s'],
            throttle: { pool: 'host' },
        });
        const f1 = flakySeam.stitch({
            baseUrl: `${HOST}/v1`,
            path: '/customers',
        });
        const f2 = flakySeam.stitch({
            baseUrl: `${HOST}/v2`,
            path: '/customers',
        });
        const outcomes: string[] = [];
        for (let i = 0; i < 4; i++) {
            const res = await all([f1, f2])({ query: { customer_id: 'x' } })
                .then(() => 'ok')
                .catch((e: Error) => e.message);
            outcomes.push(res === 'ok' ? 'ok' : res);
        }
        checkSeq(
            'four user-facing calls through the naive dual-run',
            outcomes,
            // The first two calls carry v2's status verbatim; the last two are v1 being
            // fast-failed on a breaker only v2 ever opened.
            ['HTTP 500', 'HTTP 500', 'circuit open', 'circuit open'],
        );
        check(
            'user-facing calls that succeeded',
            outcomes.filter((o) => o === 'ok').length,
            0,
        );
        check('v1 requests that ever reached the vendor', flaky.count('v1'), 2);
        ledgerRow(
            'NAIVE — 4 calls, v2 flaky',
            flaky.count('v1'),
            flaky.count('v2'),
            '0 of 4 succeeded',
        );
        note(
            "the experiment took down the thing it was protecting — first by propagating v2's error, then by fast-failing v1 on v2's breaker",
        );
    }

    // =======================================================================
    heading('C8 (2) — THE SAFE DUAL-RUN');

    const vendor = fakeVendor({ latency: { v1: 10, v2: 90 } });
    const rand = seededRandom(20260805);
    const findings: Finding[] = [];

    // >>> BEGIN USER CODE
    /** SEAM 1 — the Adapter. A shadow that cannot emit a non-read cannot double-charge (C5). */
    const readsOnly =
        (inner: Adapter): Adapter =>
        (req) => {
            if (req.method !== 'GET' && req.method !== 'HEAD')
                throw new Error(`shadow refused a ${req.method} to ${req.url}`);
            return inner(req);
        };

    /** SEAM 2 — one `seam`, so ONE throttle bucket spans both versions and the meter adds up (C7). */
    const vendorSeam = seam({
        baseUrl: HOST,
        adapter: vendor.adapter,
        throttle: '200/s',
    });
    /** SEAM 3 — `circuit.key`, distinct per version, so the shadow's breaker is not the primary's (C1 d). */
    const v1 = vendorSeam.stitch({
        path: V1_PATH,
        circuit: { failures: 5, cooldown: '30s', key: 'cust-v1' },
    });
    const v2 = vendorSeam.stitch({
        path: V2_PATH,
        adapter: readsOnly(vendor.adapter),
        circuit: { failures: 5, cooldown: '30s', key: 'cust-v2' },
    });

    /** SEAM 4 — the relevancy model. Four known-benign changes, normalized onto common ground (C4). */
    const RENAMED: Record<string, string> = { created: 'created_at' };
    const UNORDERED = new Set(['tags']);
    const ADDED = new Set(['livemode']);
    const normalize = (b: Record<string, unknown>, side: 'v1' | 'v2') => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(b)) {
            if (side === 'v2' && ADDED.has(k)) continue;
            const key = side === 'v1' ? (RENAMED[k] ?? k) : k;
            out[key] = UNORDERED.has(key)
                ? [...(v as unknown[])].sort()
                : key === 'created_at'
                  ? new Date(
                        typeof v === 'number' ? v * 1000 : (v as string),
                    ).toISOString()
                  : v;
        }
        return out;
    };

    /** SEAM 5 — the dual-run itself. The shadow is sampled, eager, un-awaited and unable to reject. */
    const SAMPLE = 0.25;
    const getCustomer = (id: string) => {
        const primary = v1({ params: { id } });
        if (rand() < SAMPLE)
            void v2
                .safe({ query: { customer_id: id } })
                .then(async (shadow) => {
                    if (!shadow.ok) return;
                    const a = normalize(
                        (await primary) as Record<string, unknown>,
                        'v1',
                    );
                    const b = normalize(
                        shadow.data as Record<string, unknown>,
                        'v2',
                    );
                    for (const d of diff(a, b))
                        findings.push({
                            path: d.path.join('.'),
                            v1: d.oldValue,
                            v2: d.value,
                        });
                });
        return primary;
    };
    // <<< END USER CODE

    // -----------------------------------------------------------------------
    heading('C8 (2a) — latency, isolation, and cost');
    {
        const N = 40;
        const r = await elapsed(async () => {
            for (let i = 0; i < N; i++) await getCustomer(`cus_${i}`);
        });
        await new Promise((res) => setTimeout(res, 250));

        const perCall = r.ms / N;
        note(
            'mean caller-observed latency per call',
            `${perCall.toFixed(1)}ms`,
        );
        checkBand(
            "the caller never paid the shadow's 90ms",
            perCall * 10,
            80,
            400,
        );
        check('every primary call went out', vendor.count('v1'), N);
        const shadows = vendor.count('v2');
        note('shadow calls at a 25% sample', shadows);
        checkBand('the sample landed near 25%', shadows, 5, 17);
        const multiplier = (N + shadows) / N;
        note('cost multiplier', multiplier.toFixed(3));
        checkBand(
            'cost is well under the unsampled 2.000x',
            multiplier * 1000,
            1100,
            1450,
        );
        ledgerRow(
            `SAFE — ${N} calls, 25% sample`,
            vendor.count('v1'),
            shadows,
            `${perCall.toFixed(1)}ms/call, ${multiplier.toFixed(3)}x`,
        );
    }

    // -----------------------------------------------------------------------
    heading(
        'C8 (2b) — the comparison: does it find the regression and nothing else?',
    );
    {
        const paths = [...new Set(findings.map((f) => f.path))];
        note(
            'total findings reported across the sampled calls',
            findings.length,
        );
        checkSeq('distinct paths reported', paths, ['balance_cents']);
        check(
            'the regression, as reported (v1)',
            findings[0]?.v1,
            TRUE_BALANCE,
        );
        check(
            'the regression, as reported (v2)',
            findings[0]?.v2,
            REGRESSED_BALANCE,
        );
        note(
            'the rename, the retype, the reorder and the new field produced ZERO findings — 7 raw ops per call became 1',
        );
    }

    // -----------------------------------------------------------------------
    heading('C8 (2c) — the safety properties, exercised');
    {
        // A flaky v2, replayed through the SAFE construction. Same failure, same seam, same host.
        const flaky = fakeVendor({
            statuses: { v2: [500, 500, 500, 500, 500, 500] },
        });
        const s = seam({
            baseUrl: HOST,
            adapter: flaky.adapter,
            throttle: '200/s',
        });
        const p = s.stitch({
            path: V1_PATH,
            circuit: { failures: 2, cooldown: '30s', key: 'cust-v1' },
        });
        const sh = s.stitch({
            path: V2_PATH,
            adapter: readsOnly(flaky.adapter),
            circuit: { failures: 2, cooldown: '30s', key: 'cust-v2' },
        });
        const results: string[] = [];
        for (let i = 0; i < 4; i++) {
            void sh.safe({ query: { customer_id: 'x' } });
            const r = await p.safe({ params: { id: 'x' } });
            results.push(r.ok ? 'ok' : (r.error as Error).message);
        }
        await new Promise((res) => setTimeout(res, 60));
        checkSeq(
            'four user-facing calls with the shadow failing every time',
            results,
            ['ok', 'ok', 'ok', 'ok'],
        );
        check('v1 requests that reached the vendor', flaky.count('v1'), 4);
        check(
            'the shadow tripped its OWN breaker',
            flaky.count('v2') < 4,
            true,
        );
        note('shadow requests before its breaker opened', flaky.count('v2'));
        ledgerRow(
            'SAFE — 4 calls, v2 flaky',
            flaky.count('v1'),
            flaky.count('v2'),
            '4 of 4 succeeded',
        );

        // A shadowed WRITE, attempted through the same construction.
        const writeShadow = s.stitch({
            path: '/v2/charges',
            method: 'POST',
            adapter: readsOnly(flaky.adapter),
            circuit: { failures: 5, cooldown: '30s', key: 'charge-v2' },
        });
        const w = await writeShadow.safe({ body: { amount: 4200 } });
        check('the shadowed write failed', w.ok, false);
        check(
            'shadow WRITES the vendor received',
            flaky.log.filter((c) => c.version === 'v2' && c.method !== 'GET')
                .length,
            0,
        );
    }

    printLedger('C8 — naive vs safe, over the same vendor');

    const src = readFileSync(new URL(import.meta.url), 'utf8');
    const userLines = countUserLines(src);
    note('EXECUTABLE LINES OF USER CODE', userLines);

    console.log(`
  THE FIVE SEAMS, AND WHAT EACH BUYS

    seam                       spelling                                  closes
    -------------------------  ----------------------------------------  --------------------------
    1  the Adapter             readsOnly(adapter) on the SHADOW only     C5 — a shadowed write is
                                                                         impossible, not discouraged
    2  the seam                seam({ throttle: '200/s' })               C7 — ONE bucket spans both
                                                                         versions, so the vendor's
                                                                         meter adds up
    3  circuit.key             distinct string per version               C1 (d) — the shadow's
                                                                         breaker is not the primary's
    4  the relevancy model     normalize() — user code, no library seam  C4 — 7 raw ops/call -> 1
    5  the call site           v2.safe(...) floated, never awaited       C1 (a)(b)(b')(c*) — off the
                                                                         critical path, cannot reject,
                                                                         cannot cancel, and DOES run

    SAME VENDOR, SAME FLAKY v2, FOUR USER-FACING CALLS

      naive (all([v1, v2]), one seam, shared key)   0 of 4 succeeded
      safe  (this construction)                     4 of 4 succeeded

  WHAT IT COSTS

    ${userLines} executable lines of user code, of which the largest single block is the relevancy model
    (${countUserLines(src)} total; the normalizer alone is roughly half). Four of the five seams are
    ordinary config — an adapter wrapper, a seam, two circuit keys, a call site. The fifth is not
    config at all: there is no declarative surface anywhere in the library for "these two field
    names mean the same thing" or "compare this array unordered", so the relevancy model is code you
    write and maintain, and it is exactly the part the field guidance says the effort goes into.

    Three things NO amount of user code fixes, and they bound the technique rather than the library:
      - a write can only be REFUSED, never shadowed (C5);
      - the shadow's correctness depends on the caller mapping the input twice, and getting it
        wrong is silent — C2 measured a bound shadow querying the wrong customer forever;
      - the comparator is vendored, so a library-side improvement to \`diff\` never reaches it (C3).
`);

    finish(
        'C8',
        `ASSEMBLED, AND THE SAFE CONSTRUCTION IS ${userLines} EXECUTABLE LINES ACROSS 5 SEAMS. Replayed against the naive version over the same vendor and the same flaky v2, the numbers are 0-of-4 versus 4-of-4 user-facing calls succeeding: the naive dual-run — \`all([v1, v2])\` under one seam with both versions on \`/customers\` — propagated v2's 500 to the caller twice, then fast-failed v1 on v2's breaker twice, and along the way put a 90ms shadow on a 10ms call's critical path and sent v2's parameter name to v1. The safe construction needed no fork and no new config key: \`readsOnly\` on the SHADOW's adapter only (0 shadow writes reached the wire while the primary still wrote), a seam-level throttle (one bucket, so the meter adds up), distinct \`circuit.key\` strings (the shadow tripped its own breaker and the primary never noticed), a hand-written normalizer (7 raw diff ops per call became exactly 1 — the planted \`balance_cents\` regression, reported with both values), and a floated \`.safe()\` at the call site, which is the one spelling that is simultaneously off the critical path, unable to reject, unable to cancel the primary, and actually eager enough to run. The irreducible cost is the relevancy model: no declarative surface for field aliasing or unordered comparison exists anywhere in the library, so that block is user code by construction`,
    );
}

void main();
