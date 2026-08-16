// C4 — a field becomes `null` on ~5% of responses. The geocoder case: nothing is wrong until a
// query happens to be ambiguous, so the shape differs BY DATA and never by deployment.
//
// Two questions from the capture, and the answers point in opposite directions.
//
// Does drift fire only on the drifting calls, and does the finding name the field? YES to both,
// exactly — 5 findings over 100 calls, on calls 20/40/60/80/100, each naming `formatted_address`.
// That is the library doing its job.
//
// Is "nullable" a WARNING-level change class the way the industry taxonomy has it? NO. There is no
// nullable level. `null` against a strict schema is `error` and the call fails; against
// `.nullable()` it is declared variance and produces NOTHING; the only way to get a `warn` is a
// coercion, which means fabricating a value. Three outcomes, none of them "warn, value intact".
//
//   pnpm exec tsx docs/scenarios/proofs/intermittent-drift/c4-intermittent-null.ts
import { drift, stitch } from '../../../../packages/core/src/index';
import type {
    Adapter,
    StitchEvent,
    TraceContext,
    TraceSink,
} from '../../../../packages/core/src/types';
import { fmt, serving } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';
import { z } from './zod';

/** A geocoder result. `formatted_address` is the field that goes null on ambiguous queries. */
const Place = z.object({
    place_id: z.string(),
    formatted_address: z.string(),
    lat: z.number(),
    lng: z.number(),
});

/** 5% of queries are ambiguous — deterministic, so "5 of 100" is a fact. */
function geocoder(): { adapter: Adapter; ambiguousAt: number[] } {
    let n = 0;
    const ambiguousAt: number[] = [];
    return {
        ambiguousAt,
        adapter: async () => {
            n += 1;
            const ambiguous = n % 20 === 0;
            if (ambiguous) ambiguousAt.push(n);
            return {
                status: 200,
                headers: {},
                body: {
                    place_id: `p${n}`,
                    formatted_address: ambiguous ? null : `${n} Main St`,
                    lat: 51.5,
                    lng: -0.12,
                },
            };
        },
    };
}

async function main(): Promise<void> {
    heading('C4 — `formatted_address` is null on 5% of responses');

    // ── (a) does drift fire ONLY on the drifting calls, and does it name the field? ──────────
    // The schema has to admit the null for the call to survive, so this uses `.nullable()` plus a
    // `.catch('')` — the shape a team reaches for after the first outage. The `.catch` is what
    // turns the null into a reportable coercion; see (c) for what `.nullable()` alone does.
    {
        const { adapter, ambiguousAt } = geocoder();
        const firedOn: number[] = [];
        const findings: string[] = [];
        let call = 0;
        const sink: TraceSink = {
            handle(e: StitchEvent, _ctx: TraceContext) {
                if (e.type === 'start') call += 1;
                if (e.type === 'drift') {
                    firedOn.push(call);
                    findings.push(fmt(e.finding));
                }
            },
        };
        const Tolerant = z.object({
            place_id: z.string(),
            formatted_address: z.string().catch(''),
            lat: z.number(),
            lng: z.number(),
        });
        const geocode = stitch({
            url: 'https://geo.example/lookup',
            adapter,
            output: drift(Tolerant),
            trace: sink,
        });
        const okCount = { yes: 0, no: 0 };
        for (let i = 0; i < 100; i += 1) {
            const r = await geocode.safe();
            if (r.ok) okCount.yes += 1;
            else okCount.no += 1;
        }

        check('(a) calls made', call, 100);
        check('(a) calls the vendor actually nulled', ambiguousAt.length, 5);
        check('(a) drift findings', findings.length, 5);
        checkSeq('(a) the calls drift fired on', firedOn, ambiguousAt);
        checkSeq(
            '(a) …and every finding is the same one',
            [...new Set(findings)],
            ['warn|coerced|formatted_address|null -> string'],
        );
        check('(a) successful calls', okCount.yes, 100);
        note(
            '(a) → drift fires on exactly the 5 calls the vendor drifted on and on none of the other 95, and the finding NAMES `formatted_address`. This is the library working',
            '',
        );
    }

    // ── (b) …but what the caller receives on those 5 calls is a FABRICATED value ─────────────
    // `.catch('')` is what made (a) reportable. It is also what makes the null invisible one line
    // downstream: `place.formatted_address` is a string on all 100 calls.
    {
        const { adapter } = geocoder();
        const Tolerant = z.object({
            place_id: z.string(),
            formatted_address: z.string().catch(''),
            lat: z.number(),
            lng: z.number(),
        });
        const geocode = stitch({
            url: 'https://geo.example/lookup',
            adapter,
            output: drift(Tolerant),
        });
        const values: unknown[] = [];
        for (let i = 0; i < 40; i += 1) {
            const r = await geocode.safe();
            values.push(
                (r.data as Record<string, unknown>)['formatted_address'],
            );
        }
        checkSeq(
            '(b) values on calls 19, 20, 21',
            [values[18], values[19], values[20]],
            ['19 Main St', '', '21 Main St'],
        );
        check(
            '(b) how many of 40 are the empty string',
            values.filter((v) => v === '').length,
            2,
        );
        check(
            '(b) …and every value is a string, so a `typeof` guard passes',
            values.every((v) => typeof v === 'string'),
            true,
        );
    }

    // ── (c) the four ways to declare a nullable field, and what each reports ─────────────────
    // The industry taxonomy wants "nullable ⇒ warn, value intact". None of the four does that.
    {
        const rows: string[] = [];
        for (const [label, field] of [
            ['required        ', z.string()],
            ['.nullable()     ', z.string().nullable()],
            ['.catch("")      ', z.string().catch('')],
            ['.nullish()      ', z.string().nullish()],
        ] as const) {
            const findings: string[] = [];
            const sink: TraceSink = {
                handle(e: StitchEvent) {
                    if (e.type === 'drift') findings.push(fmt(e.finding));
                },
            };
            const call = stitch({
                url: 'https://geo.example/lookup',
                adapter: serving({
                    place_id: 'p1',
                    formatted_address: null,
                    lat: 51.5,
                    lng: -0.12,
                }),
                output: drift(
                    z.object({
                        place_id: z.string(),
                        formatted_address: field,
                        lat: z.number(),
                        lng: z.number(),
                    }) as never,
                ),
                trace: sink,
            });
            const r = await call.safe();
            // `drift(... as never)` erases the contract type, so `data` needs a widening cast.
            const data = r.data as unknown as Record<string, unknown> | null;
            const value =
                data === null
                    ? '<call failed>'
                    : JSON.stringify(data['formatted_address']);
            rows.push(
                `${label} ok=${r.ok} finding=${findings[0] ?? '<none>'} value=${value}`,
            );
        }
        checkSeq('(c) one null, four declarations', rows, [
            'required         ok=false finding=error|invalid|formatted_address|Invalid input: expected string, received null value=<call failed>',
            '.nullable()      ok=true finding=<none> value=null',
            '.catch("")       ok=true finding=warn|coerced|formatted_address|null -> string value=""',
            '.nullish()       ok=true finding=<none> value=null',
        ]);
        note(
            '(c) → there is NO "nullable" level. You get `error` + a failed call, or silence + the null, or `warn` + a fabricated value. "Warning-level, value intact" is not one of the options',
            '',
        );
    }

    // ── (d) the silent variant is the one a team actually ships ──────────────────────────────
    // `.nullable()` is the correct schema for "this field is sometimes null", and it produces zero
    // findings on all 100 calls. The 5% rollout is completely invisible to drift.
    {
        const { adapter } = geocoder();
        const findings: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'drift') findings.push(fmt(e.finding));
            },
        };
        const geocode = stitch({
            url: 'https://geo.example/lookup',
            adapter,
            output: drift(
                z.object({
                    place_id: z.string(),
                    formatted_address: z.string().nullable(),
                    lat: z.number(),
                    lng: z.number(),
                }),
            ),
            trace: sink,
        });
        const nulls: number[] = [];
        for (let i = 0; i < 100; i += 1) {
            const r = await geocode.safe();
            if (
                (r.data as Record<string, unknown>)['formatted_address'] ===
                null
            )
                nulls.push(i + 1);
        }
        check('(d) calls that returned null', nulls.length, 5);
        checkSeq('(d) drift findings over the same 100 calls', findings, []);
        note(
            '(d) → declared variance produces no finding (drift.ts:104-111 diffs raw against validated, and they are equal). The rate is only recoverable by inspecting `data` yourself',
            '',
        );
    }

    // ── (e) the strict variant, which does fire — as a 5% ERROR RATE ─────────────────────────
    // The honest alternative to (d): leave the field required and let the 5% fail. It is loud, it
    // names the field, and it costs you the other four fields on every ambiguous query.
    {
        const { adapter } = geocoder();
        const findings: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'drift') findings.push(fmt(e.finding));
            },
        };
        const geocode = stitch({
            url: 'https://geo.example/lookup',
            adapter,
            output: drift(Place),
            trace: sink,
        });
        let failed = 0;
        for (let i = 0; i < 100; i += 1) {
            const r = await geocode.safe();
            if (!r.ok) failed += 1;
        }
        check('(e) failed calls out of 100', failed, 5);
        check('(e) findings', findings.length, 5);
        checkSeq(
            '(e) the finding',
            [...new Set(findings)],
            [
                'error|invalid|formatted_address|Invalid input: expected string, received null',
            ],
        );
        note(
            '(e) → a 5% hard failure rate, each one naming the field. This IS the detection the scenario wants; the price is that the caller loses `place_id`, `lat` and `lng` too',
            '',
        );
    }

    finish(
        'C4',
        'CONFIRMED ON PRECISION, REFUTED ON LEVEL. Drift fires on EXACTLY the drifting calls and nowhere else — 5 findings over 100 calls, on calls [20,40,60,80,100], matching the vendor ledger, and each one NAMES `formatted_address` with `null -> string`. No false positives on the other 95. But there is no NULLABLE LEVEL: one null against four declarations gives `error|invalid` + a failed call (required), NOTHING at all (`.nullable()` / `.nullish()` — declared variance, raw === validated, no diff), or `warn|coerced` + a FABRICATED `""` (`.catch("")`). The industry class "nullable is warning-level, value intact" is not expressible. `.nullable()` is the schema a team actually ships and it makes the 5% rollout completely invisible; the strict schema turns it into a 5% error rate that also discards the four fields that were fine',
    );
}

void main();
