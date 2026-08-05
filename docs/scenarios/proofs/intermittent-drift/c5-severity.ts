// C5 — can the four change classes be given DIFFERENT severities, declaratively?
//
// The real config is `DriftOptions` (types.ts:83-116) with exactly two keys: `severity` and
// `ignore`. `severity` is keyed by `SoftDriftChange` = `'undeclared' | 'coerced' | 'defaulted'`
// (types.ts:72) and its values are `DriftSeverity` = `'warn' | 'info' | 'verbose'` (types.ts:74).
//
// So the answer is a qualified yes with one sharp edge and one hole:
//
//   - The vocabulary is keyed by MECHANISM (what your schema did to the value), not by CHANGE
//     CLASS (what the vendor did to the shape). Addition maps cleanly onto `undeclared`; the other
//     three do not have a stable home.
//   - `error` is not in `DriftSeverity`, so you cannot promote a soft finding to fatal — the docs
//     say fatality is the schema's job. The RUNTIME honours `'error'` anyway if you cast past the
//     type. That is measured here, both directions.
//   - `ignore` is per-PATH, `severity` is per-KIND. There is no per-path severity, so "a coercion
//     on `transaction_id` is a page, a coercion on `description` is noise" is not expressible.
//
//   pnpm exec tsx docs/scenarios/proofs/intermittent-drift/c5-severity.ts
import { drift, stitch } from '../../../../packages/core/src/index';
import type {
    DriftOptions,
    StitchEvent,
    TraceSink,
} from '../../../../packages/core/src/types';
import { fmt, serving } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { z } from './zod';

/** A schema that can produce all three soft kinds at once. */
const Charge = z.object({
    transaction_id: z.coerce.number().catch(0), // → `coerced` when the wire type shifts
    amount: z.number(),
    currency: z.string().default('usd'), // → `defaulted` when the vendor drops it
    status: z.string(),
});

/** A body that trips all three kinds on one call: a retype, a removal, and an addition. */
const ALL_THREE = {
    transaction_id: '100001',
    amount: 4200,
    status: 'succeeded',
    settlement_delay_ms: 900,
};

interface Run {
    ok: boolean;
    findings: string[];
}

async function run(
    opts: DriftOptions,
    body: unknown = ALL_THREE,
): Promise<Run> {
    const findings: string[] = [];
    const sink: TraceSink = {
        handle(e: StitchEvent) {
            if (e.type === 'drift') findings.push(fmt(e.finding));
        },
    };
    const call = stitch({
        url: 'https://pay.example/charges/1',
        adapter: serving(body),
        output: drift(Charge, opts),
        trace: sink,
    });
    const r = await call.safe();
    return { ok: r.ok, findings: findings.sort() };
}

async function main(): Promise<void> {
    heading('C5 — leveling the change classes declaratively');

    // ── (a) the defaults, all three kinds on one call ────────────────────────────────────────
    // drift.ts:65-69 — `undeclared` → info, `coerced` → warn, `defaulted` → verbose.
    {
        const r = await run({});
        check('(a) the call SUCCEEDED', r.ok, true);
        checkSeq('(a) findings at the per-kind defaults', r.findings, [
            'info|undeclared|settlement_delay_ms|undeclared field (number)',
            'verbose|defaulted|currency|default applied',
            'warn|coerced|transaction_id|string -> number',
        ]);
        note(
            '(a) → three kinds, three levels, out of the box, on one response. This is the vocabulary the capture hoped existed',
            '',
        );
    }

    // ── (b) the map form RE-LEVELS each kind ─────────────────────────────────────────────────
    // "addition silent-ish, coercion loud, default loud" — expressible in one object literal.
    {
        const r = await run({
            severity: {
                undeclared: 'verbose',
                coerced: 'warn',
                defaulted: 'warn',
            },
        });
        checkSeq('(b) findings after re-leveling', r.findings, [
            'verbose|undeclared|settlement_delay_ms|undeclared field (number)',
            'warn|coerced|transaction_id|string -> number',
            'warn|defaulted|currency|default applied',
        ]);
        note(
            '(b) → the three SOFT kinds are fully re-levelable across the three soft levels. Nine combinations, one literal',
            '',
        );
    }

    // ── (c) the allowlist form DROPS findings entirely ───────────────────────────────────────
    // `severity: 'warn'` is not "show warn prominently", it is "emit only warn". The dropped
    // findings never reach the event stream, so they never reach a counter either (C6).
    {
        const r = await run({ severity: 'warn' });
        checkSeq('(c) findings with `severity: "warn"`', r.findings, [
            'warn|coerced|transaction_id|string -> number',
        ]);
        const two = await run({ severity: ['warn', 'info'] });
        checkSeq(
            '(c) findings with `severity: ["warn","info"]`',
            two.findings,
            [
                'info|undeclared|settlement_delay_ms|undeclared field (number)',
                'warn|coerced|transaction_id|string -> number',
            ],
        );
        note(
            '(c) → filtering happens at EMISSION (drift.ts:147), not at consumption. A finding you filtered out is invisible to the trace sink, so you cannot filter and count the same kind',
            '',
        );
    }

    // ── (d) `ignore` is per-PATH; `severity` is per-KIND. There is no per-path severity ──────
    // The thing a payments team actually wants — coercion on `transaction_id` is a page, coercion
    // on `description` is noise — has no spelling. You can only silence a path completely.
    {
        const Two = z.object({
            transaction_id: z.coerce.number().catch(0),
            description: z.coerce.string().catch(''),
            amount: z.number(),
        });
        const findings: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'drift') findings.push(fmt(e.finding));
            },
        };
        const call = stitch({
            url: 'https://pay.example/charges/1',
            adapter: serving({
                transaction_id: '100001',
                description: 99,
                amount: 4200,
            }),
            output: drift(Two, { severity: { coerced: 'warn' } }),
            trace: sink,
        });
        await call.safe();
        checkSeq('(d) two coercions, one severity', findings.sort(), [
            'warn|coerced|description|number -> string',
            'warn|coerced|transaction_id|string -> number',
        ]);

        const silenced: string[] = [];
        const sink2: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'drift') silenced.push(fmt(e.finding));
            },
        };
        const call2 = stitch({
            url: 'https://pay.example/charges/1',
            adapter: serving({
                transaction_id: '100001',
                description: 99,
                amount: 4200,
            }),
            output: drift(Two, { ignore: ['description'] }),
            trace: sink2,
        });
        await call2.safe();
        checkSeq('(d) `ignore: ["description"]`', silenced, [
            'warn|coerced|transaction_id|string -> number',
        ]);
        note(
            '(d) → the only per-path lever is ON/OFF. `resolveSeverity` (drift.ts:90-101) takes the CHANGE KIND and nothing else — the path never reaches it',
            '',
        );
    }

    // ── (e) you cannot promote a soft finding to `error` through the type ────────────────────
    // `DriftSeverity` excludes `'error'` by construction (types.ts:74) and the JSDoc is explicit:
    // "to fail on a change, make the field required/strict in the schema". That is the documented
    // route, and it is the one C2(a) and C3(a) measured.
    {
        // @ts-expect-error `'error'` is not assignable to DriftSeverity — this is the point.
        const rejected: DriftOptions = { severity: { coerced: 'error' } };
        check(
            '(e) the type REJECTS `severity: { coerced: "error" }`',
            typeof rejected,
            'object',
        );
        note(
            '(e) → the `@ts-expect-error` above is the assertion: if the type ever starts allowing it, this file stops compiling',
            '',
        );
    }

    // ── (f) …but the RUNTIME honours it if you cast past the type ────────────────────────────
    // `levelOf` returns whatever the map says (drift.ts:100) and the engine treats any
    // `level === 'error'` finding as fatal (engine.ts:1215). So the capability exists, off-contract.
    // Reported in both directions: it works, and it is not something to build on.
    {
        const cast = {
            severity: { coerced: 'error' },
        } as unknown as DriftOptions;
        const r = await run(cast);
        check('(f) the call FAILED', r.ok, false);
        checkSeq('(f) findings', r.findings, [
            'error|coerced|transaction_id|string -> number',
            'info|undeclared|settlement_delay_ms|undeclared field (number)',
            'verbose|defaulted|currency|default applied',
        ]);
        note(
            '(f) → an `error`-leveled COERCED finding, and the call failed with `data: null`. Type-blocked, runtime-live. The documented way to get here is a strict schema, which also gives you a better message',
            '',
        );
    }

    // ── (g) the four industry classes vs the three soft kinds, side by side ──────────────────
    // The mapping is not one-to-one and this is the table that says so.
    {
        const rows = [
            'addition   → undeclared  (info)     — clean 1:1',
            'removal    → invalid/defaulted/none — decided by your schema (C2)',
            'type change→ invalid/coerced/none   — decided by your schema (C3)',
            'nullable   → invalid/coerced/none   — no nullable level at all (C4)',
        ];
        checkSeq('(g) taxonomy vs vocabulary', rows, rows);
        note(
            '(g) → only ADDITION has a stable home. The other three land on a kind chosen by how you declared the field, so "removal is fatal" is a schema decision, not a severity decision',
            '',
        );
    }

    finish(
        'C5',
        'PARTLY EXPRESSIBLE, AND KEYED ON THE WRONG AXIS. The three SOFT kinds are fully re-levelable in one literal — `severity: { undeclared: "verbose", coerced: "warn", defaulted: "warn" }` measured exactly that — and `severity: "warn"` / `["warn","info"]` is an emission-time allowlist. But `severity` is keyed by MECHANISM (`undeclared`/`coerced`/`defaulted`, types.ts:72), not by the four industry CHANGE CLASSES, and only ADDITION maps 1:1. Removal, type change and nullability each land on a kind decided by your schema, so their loudness is a schema decision. There is NO per-path severity — `ignore` is the only path-aware lever and it is on/off (drift.ts:90-101 never sees the path) — so "coercion on `transaction_id` pages, coercion on `description` does not" has no spelling. And `error` is not in `DriftSeverity`, so a soft finding cannot be promoted to fatal through the type (the `@ts-expect-error` in (e) asserts it) — though a cast past the type DOES fail the call at runtime, measured in (f)',
    );
}

void main();
