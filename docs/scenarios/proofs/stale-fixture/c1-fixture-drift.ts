// C1 (DECIDING) — can a fixture be caught when it goes stale?
//
// The capture's hypothesis is that a shared `output` schema is "the honest middle ground — but only
// if the SAME schema guards prod and the fixtures". This script builds exactly that: one Zod schema,
// one stitch config, and only the `adapter` swapped between the live vendor and the test double.
// Then it drifts things and measures who fails.
//
// The finding is a DIRECTION problem, and it is the whole scenario:
//
//   (b) fixture drifts, schema holds       -> the test FAILS. The schema works.
//   (e) VENDOR drifts, fixture holds       -> the test PASSES. Production is broken.
//
// (e) is the scenario's actual shape — "the mock that passed for six months" is the vendor moving
// while the cassette sits still — and no arrangement of `output`/`drift()` detects it offline,
// because offline there is nothing to compare the fixture against except the schema the fixture
// already satisfies. Everything the library validates is downstream of a byte that must come from
// somewhere, and in a test that somewhere is the fixture.
//
//   pnpm exec tsx docs/scenarios/proofs/stale-fixture/c1-fixture-drift.ts
import { drift, stitch } from '../../../../packages/core/src/index';
import { mockAdapter } from '../../../../packages/core/src/test-mock';
import type {
    Adapter,
    StitchEvent,
    TraceSink,
} from '../../../../packages/core/src/types';
import { check, checkSeq, finish, heading, note } from './harness';
import {
    BASE,
    MUTATIONS,
    RECORDED_2026_02_04,
    RECORDED_ON,
    VENDOR_TODAY,
    fmt,
    vendorAdapter,
} from './vendor';
import { z } from './zod';

// ── THE CONTRACT ────────────────────────────────────────────────────────────────────────────────
// One schema. It is what production validates against, and — because the stitch config is shared —
// it is also what the test double's responses are validated against. This is the capture's
// prescription, built literally.
const Invoice = z.object({
    id: z.string(),
    amount_cents: z.number(),
    currency: z.string(),
    paid: z.boolean(),
    customer_email: z.string(),
    legacy_ref: z.string(),
});

/** The result of one call, reduced to a comparable shape. */
interface Outcome {
    ok: boolean;
    message: string | null;
    findings: string[];
    data: unknown;
}

/**
 * ONE stitch definition. `adapter` is the only parameter — that is the seam the capture says should
 * be the only difference between prod and test, so it is the only difference here.
 */
async function callWith(
    adapter: Adapter,
    output: unknown = Invoice,
): Promise<Outcome> {
    const findings: string[] = [];
    const sink: TraceSink = {
        handle(e: StitchEvent) {
            if (e.type === 'drift') findings.push(fmt(e.finding));
        },
    };
    const call = stitch({
        name: 'getInvoice',
        baseUrl: BASE,
        path: '/v1/invoices/{id}',
        adapter,
        output: output as never,
        trace: sink,
    });
    const r = await call.safe({ params: { id: 'inv_9f2' } });
    return {
        ok: r.ok,
        message: r.error?.message ?? null,
        findings,
        data: r.data,
    };
}

async function main(): Promise<void> {
    heading('C1 (a) — the baseline: cassette and schema agree');
    {
        const o = await callWith(vendorAdapter(RECORDED_2026_02_04));
        check('the call succeeded', o.ok, true);
        checkSeq('drift findings', o.findings, []);
        note('this is the state on the day the cassette was cut', RECORDED_ON);
    }

    heading(
        'C1 (b) — the fixture drifts from the schema: removed / renamed / retyped / nulled',
    );
    // Direction 1. The FIXTURE is wrong and the schema is right. This is the direction the capture
    // predicts is covered, and it is: all four mutations fail the call.
    {
        const rows: string[] = [];
        for (const name of [
            'removed',
            'renamed',
            'retyped',
            'nulled',
        ] as const) {
            const o = await callWith(vendorAdapter(MUTATIONS[name]));
            rows.push(
                `${name.padEnd(8)} ok=${String(o.ok)} findings=${String(o.findings.length)}`,
            );
        }
        checkSeq('four mutations, four outcomes', rows, [
            'removed  ok=false findings=1',
            'renamed  ok=false findings=1',
            'retyped  ok=false findings=1',
            'nulled   ok=false findings=1',
        ]);
        note(
            '(b) → a fixture that violates the schema CANNOT be served silently. Note `findings=1` on a PLAIN `output`, with no `drift()` anywhere: a hard validation failure travels the drift CHANNEL (`error|invalid`) whether or not you opted into drift reporting',
            '',
        );
    }

    heading('C1 (c) — the same four, wrapped in `drift()`, for the messages');
    // `drift()` turns the same failures into named findings. Same verdict, more detail — and this is
    // the answer to "does drift() help here": it helps you READ the failure, not FIND it.
    {
        const messages: string[] = [];
        for (const name of [
            'removed',
            'renamed',
            'retyped',
            'nulled',
        ] as const) {
            const o = await callWith(
                vendorAdapter(MUTATIONS[name]),
                drift(Invoice as never),
            );
            messages.push(`${name}: ${o.findings.join(' + ') || '<none>'}`);
        }
        for (const m of messages) note(m);
        check(
            '(c) every mutation produced at least one finding under drift()',
            messages.every((m) => !m.endsWith('<none>')),
            true,
        );
        note(
            '(c) → `drift()` reports WHICH field and HOW. But it fired because the fixture broke the SCHEMA, not because the fixture is old',
            '',
        );
    }

    heading('C1 (d) — is the double really validated the same as prod?');
    // The claim "the same schema guards both" is worth measuring rather than assuming: swap in the
    // library's own `mockAdapter` and confirm the engine still runs `output` over its canned body.
    {
        const mock = mockAdapter([
            {
                match: '/v1/invoices/inv_9f2',
                respond: { body: MUTATIONS.retyped },
            },
        ]);
        const o = await callWith(mock);
        check('mockAdapter fixture is validated too', o.ok, false);
        check('and the transport was actually consulted', mock.callCount(), 1);
        note(
            '(d) → `mockAdapter` is below validation, so the full engine runs over the fixture. The double is not a bypass',
            '',
        );
    }

    heading(
        'C1 (e) — THE ACTUAL SCENARIO: the vendor drifts, the fixture does not',
    );
    // Direction 2, and the one the scenario is named for. The cassette still satisfies the schema
    // (it was recorded when both were true). The vendor no longer does. The test is green.
    {
        const test = await callWith(vendorAdapter(RECORDED_2026_02_04));
        const prod = await callWith(vendorAdapter(VENDOR_TODAY));
        check('the TEST passes', test.ok, true);
        check('PRODUCTION fails', prod.ok, false);
        check(
            'the test emitted no finding of any kind',
            test.findings.length,
            0,
        );
        checkSeq(
            'the keys the two responses disagree on',
            [
                ...new Set([
                    ...Object.keys(RECORDED_2026_02_04),
                    ...Object.keys(VENDOR_TODAY),
                ]),
            ].filter(
                (k) =>
                    JSON.stringify(
                        (RECORDED_2026_02_04 as Record<string, unknown>)[k],
                    ) !==
                    JSON.stringify(
                        (VENDOR_TODAY as Record<string, unknown>)[k],
                    ),
            ),
            ['amount_cents', 'paid', 'customer_email', 'legacy_ref', 'amount'],
        );
        note(
            '(e) → five keys differ between the cassette and the live vendor, and the suite is green. This is the six months',
            '',
        );
    }

    heading(
        'C1 (f) — can anything assert "my fixture still matches the contract"?',
    );
    // The narrow question: given a fixture and the schema, is there a published call that says
    // "validate this object against this stitch's `output`" without a transport? Measured by
    // checking the exported surface of the main entry and of `stitchapi/testing`.
    {
        const core =
            (await import('../../../../packages/core/src/index')) as Record<
                string,
                unknown
            >;
        const testing =
            (await import('../../../../packages/core/src/testing')) as Record<
                string,
                unknown
            >;
        // Descend one level into namespace-valued exports (`conformance`, `secrets`, the token
        // grammars) — a flat `Object.keys` would let a member hide behind its namespace, and the
        // one name this scan is looking for lives inside one.
        const flatten = (mod: Record<string, unknown>): string[] =>
            Object.keys(mod).flatMap((key) => {
                const value = mod[key];
                return value !== null && typeof value === 'object'
                    ? [key, ...Object.keys(value).map((m) => `${key}.${m}`)]
                    : [key];
            });
        const named = [...flatten(core), ...flatten(testing)].sort();
        const fixtureWords = named.filter((n) =>
            /fixture|cassette|record|snapshot|stale|fresh|expire/i.test(n),
        );
        checkSeq(
            'exports mentioning fixture/cassette/record/snapshot/stale/freshness',
            fixtureWords,
            ['conformance.fixture'],
        );
        note(
            'and `conformance.fixture` is the ADAPTER echo contract — for people writing transports, not people holding a stale invoice body',
            '',
        );
        note('total exported names across both entries', named.length);

        // The honest workaround: a fixture is just data, and a schema is callable directly. This
        // works — but it is your code, not a library seam, and it validates the fixture against the
        // SCHEMA, which is the direction (b) already covered.
        const parsed = Invoice.safeParse(RECORDED_2026_02_04);
        check(
            'a fixture CAN be checked against the schema directly',
            parsed.success,
            true,
        );
        const stale = Invoice.safeParse(VENDOR_TODAY);
        check("…and it catches today's vendor body", stale.success, false);
        note(
            "(f) → but that last check required HAVING today's vendor body. Offline, you do not",
            '',
        );
    }

    heading('C1 (g) — is the recording date expressible anywhere?');
    {
        // `__config` is the published read-out of a stitch. If a recorded-on date could ride
        // anywhere it would ride here.
        const call = stitch({
            name: 'getInvoice',
            baseUrl: BASE,
            path: '/v1/invoices/{id}',
            adapter: vendorAdapter(RECORDED_2026_02_04),
            output: Invoice as never,
        });
        const cfgKeys = Object.keys(call.__config).sort();
        checkSeq('__config keys', cfgKeys, [
            'baseUrl',
            'kind',
            'name',
            'output',
            'path',
        ]);
        check(
            'a slot for arbitrary metadata',
            cfgKeys.some((k) => /meta|tag|label|note|version/i.test(k)),
            false,
        );
        note(
            `(g) → \`${RECORDED_ON}\` lives in this proof directory's source and nowhere the library can read`,
            '',
        );
    }

    finish(
        'C1',
        'PARTIAL, AND THE HALF THAT IS MISSING IS THE SCENARIO. A shared `output` schema DOES catch a fixture that drifts from the contract: all four mutations — `legacy_ref` removed, `amount_cents` renamed, `paid` retyped, `customer_email` nulled — fail the call, through the library\'s own `mockAdapter` as well as a hand-written one, and `drift()` names each one. But that is the fixture drifting from the SCHEMA. The scenario is the VENDOR drifting from the schema while the fixture sits still, and measured, that run is: test ok=true with zero findings, production ok=false, five keys different. Nothing offline closes it, because offline the only bytes are the fixture\'s. Of the exported names across the main entry and `stitchapi/testing`, exactly one matches /fixture|cassette|record|snapshot|stale|fresh|expire/ — `conformance.fixture`, which is the transport echo contract for plugin authors — and `__config` has no metadata slot, so "recorded on 2026-02-04" is not expressible in the library at all',
    );
}

void main();
