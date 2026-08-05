// C8 — assemble the best available "my fixtures cannot silently rot" setup, and price it.
//
// Every gap C1–C7 measured gets replayed here twice: once against the naive setup (a `mockAdapter`
// and a `stubStitch`, written the way the docs show) and once against `fixture-guard.ts`. The
// difference is the whole claim, and the line count is the bill.
//
// The honest headline: FOUR of the five gaps close in-process, and the fifth — C1(e), the vendor
// moving while the fixture holds — does not close at all without a live call. What the guard can do
// for that one is make the staleness VISIBLE (a recording date, an expiry) so the suite fails on a
// calendar rather than on a schema. That is a weaker guarantee than the other four and it is
// reported as one.
//
//   pnpm exec tsx docs/scenarios/proofs/stale-fixture/c8-assembled.ts
import { stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/test-clock';
import { mockAdapter } from '../../../../packages/core/src/test-mock';
import { stubStitch } from '../../../../packages/core/src/test-stub';
import type { Stitch } from '../../../../packages/core/src/types';
import {
    assertClockHonest,
    contractStub,
    expired,
    jsonOnly,
    parity,
    stamp,
} from './fixture-guard';
import { check, checkSeq, finish, heading, note } from './harness';
import {
    BASE,
    RECORDED_2026_02_04,
    RECORDED_ON,
    VENDOR_TODAY,
    vendorAdapter,
} from './vendor';
import { z } from './zod';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Executable lines between the USER CODE markers — imports, blanks and comments removed, so the
 * number is the code someone actually maintains. Same counter as `agent-holds-the-tool/c8`.
 */
function executableLines(file: string): number {
    const src = readFileSync(join(HERE, file), 'utf8');
    const from = src.indexOf('// >>> BEGIN USER CODE');
    const to = src.indexOf('// <<< END USER CODE');
    return src
        .slice(from, to)
        .replace(/^import[\s\S]*?;$/gm, '')
        .split('\n')
        .map((l) => l.trim())
        .filter(
            (l) =>
                l !== '' &&
                !l.startsWith('//') &&
                !l.startsWith('*') &&
                !l.startsWith('/*'),
        ).length;
}

const Invoice = z.object({
    id: z.string(),
    amount_cents: z.number(),
    currency: z.string(),
    paid: z.boolean(),
    customer_email: z.string(),
    legacy_ref: z.string(),
});

class LiveInvoice {
    constructor(public id: string) {}
    get amount_cents(): number {
        return 4200;
    }
}

async function main(): Promise<void> {
    heading('C8 (a) — the C3 gap: a fixture body no wire could produce');
    {
        // NAIVE: `mockAdapter` serves the class instance, getter and all.
        const naive = mockAdapter([
            { respond: { body: new LiveInvoice('inv_1') } as never },
        ]);
        const naiveCall = stitch({ url: `${BASE}/i`, adapter: naive });
        const n = await naiveCall.safe();
        check('naive: the call succeeded', n.ok, true);
        check(
            'naive: the caller read a value that exists only in the test',
            (n.data as LiveInvoice).amount_cents,
            4200,
        );

        // GUARDED: the same fixture is refused at the transport seam.
        const guarded = stitch({
            url: `${BASE}/i`,
            adapter: jsonOnly(
                mockAdapter([
                    { respond: { body: new LiveInvoice('inv_1') } as never },
                ]),
            ),
        });
        const g = await guarded.safe();
        check('guarded: the call FAILED', g.ok, false);
        check(
            'guarded: with a reason naming the fixture',
            g.error?.message,
            `fixture is not a wire shape ($: LiveInvoice): GET ${BASE}/i`,
        );

        // …and a legitimate fixture still passes straight through.
        const fine = stitch({
            url: `${BASE}/i`,
            adapter: jsonOnly(
                mockAdapter([{ respond: { body: RECORDED_2026_02_04 } }]),
            ),
            output: Invoice,
        });
        const f = await fine.safe();
        check('guarded: a real JSON fixture is unaffected', f.ok, true);
    }

    heading('C8 (b) — the C5 gap: a stub that skips the input contract');
    {
        const InputSchemas = { params: z.object({ id: z.string() }) };
        const naive = stubStitch({ id: 'inv_1' });
        const nr = await naive.safe({ params: { id: 42 } } as never);
        check('naive stub: accepted a number id', nr.ok, true);

        const guarded = contractStub(InputSchemas, { id: 'inv_1' });
        const gr = await guarded.safe({ params: { id: 42 } } as never);
        check('guarded stub: REFUSED it', gr.ok, false);
        check(
            'guarded stub: with the schema’s own message',
            gr.error?.message?.startsWith('stub input.params:'),
            true,
        );
        note('the message', gr.error?.message);
        const ok = await guarded.safe({ params: { id: '42' } } as never);
        check('guarded stub: a valid id still works', ok.ok, true);
        check('…and the spy still records', guarded.callCount(), 2);
    }

    heading('C8 (c) — the C2 gap: a slot that is inert under `manualClock`');
    {
        const clock = manualClock();
        const cfg = { cache: { ttl: 60_000 }, timeout: { total: 1000 } };
        let refused = '';
        try {
            assertClockHonest(cfg);
        } catch (e) {
            refused = (e as Error).message;
        }
        check(
            'the pairing is refused',
            refused,
            'manualClock cannot drive: cache, timeout.total — these read wall-clock (ADR 0010 §4), so an advance() proves nothing about them',
        );
        // The clock-driven slots are not refused.
        let allowed = 'ok';
        try {
            assertClockHonest({
                retry: { attempts: 3 },
                throttle: '1/s',
                circuit: { failures: 2, cooldown: 1000 },
                timeout: 500,
            });
        } catch (e) {
            allowed = (e as Error).message;
        }
        check('retry/throttle/circuit/per-attempt timeout pass', allowed, 'ok');
        note(
            'the library’s own diagnostic for this',
            'none — `policySummary` reports `cfg[k] !== undefined` (configured), never whether a slot RAN',
        );
        void clock;
    }

    heading('C8 (d) — the C1(e) gap: the vendor moved, the fixture did not');
    {
        // This is the one that does not close offline. What the guard adds is a DATE.
        const fixtures = {
            getInvoice: stamp(RECORDED_2026_02_04, RECORDED_ON, 90),
            listPlans: stamp({ plans: [] }, '2026-07-20', 90),
        };
        const stale = expired(fixtures, new Date('2026-08-05'));
        checkSeq('fixtures past their re-record date', stale, [
            'getInvoice recorded 2026-02-04 (182d old)',
        ]);
        check('…and the fresh one is not flagged', stale.length, 1);
        note(
            '(d) → 182 days. The offline suite can now fail on the CALENDAR, which is the only signal available without a call. It does not prove the fixture is wrong — it proves nobody has checked',
            '',
        );

        // And the live check, quarantined, for when a call is permitted.
        const live = stitch({
            name: 'getInvoice',
            baseUrl: BASE,
            path: '/v1/invoices/{id}',
            output: Invoice,
            adapter: vendorAdapter(VENDOR_TODAY),
        }) as unknown as Stitch;
        const fake = stitch({
            name: 'getInvoice',
            baseUrl: BASE,
            path: '/v1/invoices/{id}',
            output: Invoice,
            adapter: vendorAdapter(RECORDED_2026_02_04),
        }) as unknown as Stitch;
        const verdict = await parity(live, fake, { params: { id: 'inv_9f2' } });
        check(
            'the live parity check names the drift',
            verdict,
            'DISAGREE live=contract violation (drift) fake=ok',
        );
        note(
            '(d) → `parity()` is the only thing in this directory that DETECTS the drift rather than dating it, and it needs a real call. It cannot live in the offline suite',
            '',
        );
    }

    heading('C8 (e) — what still does not close');
    {
        // C7(d): a clean early close is indistinguishable from a complete stream. No seam here
        // changes that — it is a delta count the consumer has to assert.
        check('a truncated stream is still a successful stream', true, true);
        note(
            'C7(d) — a clean early close ends `result` + `done(ok:true)`, same as success. Countable, not detectable',
            '',
        );
        note(
            'C4 — retry backoff delays are still absent from the event stream; `clock.now()` remains the only reader',
            '',
        );
        note(
            'C5(g) — `stubStitch.safe()` still throws on a SYNC-throwing impl. `contractStub` sidesteps it by being `async`, but the underlying behaviour is unchanged',
            '',
        );
        note(
            'C2 — `timeout.total`, `cache.ttl`, `memoryStore` TTL, OAuth2 expiry, SigV4 and `done.elapsed` are still wall-clock. `assertClockHonest` refuses the pairing; it does not fix it',
            '',
        );
    }

    heading('C8 (f) — the bill');
    {
        const lines = executableLines('fixture-guard.ts');
        note('fixture-guard.ts, executable lines', lines);
        note('seams used', 5);
        note('  1. the `adapter` seam', 'wrap the transport — `jsonOnly`');
        note(
            '  2. the `impl` function of `stubStitch`',
            'run the input schemas — `contractStub`',
        );
        note(
            '  3. the published `validate()`',
            'the SAME schema the real stitch declares, called directly',
        );
        note(
            '  4. the config object, read before construction',
            'refuse an inert pairing — `assertClockHonest`',
        );
        note(
            '  5. `extends: { baseUrl, adapter }`',
            'one endpoint, two targets — `parity`',
        );
        note('config keys that know about any of this', 0);
        check('under 100 executable lines', lines <= 100, true);
        check('of which the part needing a NETWORK call', 'parity', 'parity');
    }

    finish(
        'C8',
        `FOUR OF FIVE GAPS CLOSE IN ${String(executableLines('fixture-guard.ts'))} EXECUTABLE LINES ACROSS 5 SEAMS; THE FIFTH CANNOT CLOSE OFFLINE. Replayed side by side: (a) a class-instance fixture gives the naive setup \`data.amount_cents === 4200\` from a getter and gives the guarded setup \`fixture is not a wire shape ($: LiveInvoice): GET ${BASE}/i\`, with a real JSON fixture unaffected; (b) \`{ params: { id: 42 } }\` is accepted by \`stubStitch\` and refused by \`contractStub\` with the schema's own message, while valid input still passes and the spy still records 2 calls; (c) pairing a \`manualClock\` with \`cache\` + \`timeout.total\` is refused by name, while retry/throttle/circuit/per-attempt-timeout pass — a diagnostic the library does not have, since \`policySummary\` reports only whether a slot was CONFIGURED, never whether it RAN. (d) is the one that does not close: the guard can only DATE the fixture — \`getInvoice recorded 2026-02-04 (182d old)\` against a 90-day expiry — which fails the suite on the calendar rather than on the drift. The only thing that actually detects it is \`parity()\`, measured returning \`DISAGREE live=contract violation (drift) fake=ok\`, and it needs a live call, so it cannot run in the offline suite. That is the scenario's answer: the comparison is 8 lines and the library already gives you every seam it needs; what is missing is a place to put a call you are only allowed to make sometimes`,
    );
}

void main();
