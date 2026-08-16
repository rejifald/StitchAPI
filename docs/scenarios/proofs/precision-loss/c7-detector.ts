// C7 — is there ANY spelling that makes this loud, and what is the minimum user code?
//
// C2 established that a schema refinement CAN separate a corrupted id from an intact one. C7 asks
// the two follow-up questions that decide whether that is a usable answer:
//
//   1. Can it be LOUD IN THE LIBRARY'S OWN CHANNEL — a drift finding, an event — rather than just a
//      thrown error? Measured: YES, and it does not require the call to fail. A `drift()`-wrapped
//      schema whose refinement is expressed as a COERCION produces `warn|coerced|<path>|number ->
//      string` on the drift channel, non-fatal, with the field named. That is the exact shape the
//      capture asks for and does not expect to exist.
//   2. What does it COST in false positives and false negatives? Measured over a mixed workload
//      and then over 20 000 random snowflakes, because the answer is a rate, not a yes/no.
//
//   pnpm exec tsx docs/scenarios/proofs/precision-loss/c7-detector.ts
import { drift, stitch } from '../../../../packages/core/src/index';
import type {
    StitchEvent,
    TraceSink,
} from '../../../../packages/core/src/types';
import {
    check,
    checkDigits,
    checkSeq,
    checkStr,
    finish,
    heading,
    note,
} from './harness';
import { BASE, MAX_SAFE, SMALL_ID, SNOWFLAKE, fmt, wireAdapter } from './wire';
import { z } from './zod';

// ── >>> BEGIN USER CODE — THE DETECTOR ──────────────────────────────────────────────────────────
// The whole of it. One predicate, one walker, one schema wrapper.

/** True when a parsed JSON number passed through the lossy zone. Integers only — a decimal is a
 *  different failure (C1 b2) and flagging it here would be noise. */
const unsafe = (v: unknown): boolean =>
    typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v);

/** Every dotted path in `body` holding an integer above 2^53. Schema-free: works on any shape. */
function unsafePaths(body: unknown, at = ''): string[] {
    if (unsafe(body)) return [at || '<root>'];
    if (Array.isArray(body))
        return body.flatMap((v, i) => unsafePaths(v, `${at}[${i}]`));
    if (body !== null && typeof body === 'object')
        return Object.entries(body as Record<string, unknown>).flatMap(
            ([k, v]) => unsafePaths(v, at ? `${at}.${k}` : k),
        );
    return [];
}

/** A `z.number()` that stays a number when safe and becomes its digits when not — so the loss is
 *  reported by `drift()` as a coercion instead of failing the call. */
const guardedInt = z
    .number()
    .transform((n) => (Number.isSafeInteger(n) ? n : String(n)));

// ── <<< END USER CODE ───────────────────────────────────────────────────────────────────────────

/** Run one stitch over `text`, collecting findings and events. */
async function run(
    text: string,
    extra: Record<string, unknown> = {},
): Promise<{
    ok: boolean;
    data: unknown;
    findings: string[];
    events: StitchEvent[];
}> {
    const findings: string[] = [];
    const events: StitchEvent[] = [];
    const sink: TraceSink = {
        handle(e: StitchEvent) {
            events.push(e);
            if (e.type === 'drift') findings.push(fmt(e.finding));
        },
    };
    const call = stitch({
        name: 'getThing',
        baseUrl: BASE,
        path: '/v1/things/1',
        adapter: wireAdapter(text),
        trace: sink,
        ...extra,
    } as never);
    const r = await call.safe();
    return { ok: r.ok, data: r.data, findings, events };
}

async function main(): Promise<void> {
    heading(
        "C7 (a) — LOUD, in the library's own channel, WITHOUT failing the call",
    );
    {
        // The answer to "is there any spelling that makes this loud". A `drift()`-wrapped schema
        // whose guard is a TRANSFORM: the schema succeeds either way, so nothing throws, but the
        // validated value now differs from the raw one — which is precisely what `drift()` reports.
        const Guarded = drift(z.object({ id: guardedInt }));

        const bad = await run(`{"id":${SNOWFLAKE}}`, { output: Guarded });
        check(
            'the call SUCCEEDED — this is diagnostic, not control flow',
            bad.ok,
            true,
        );
        checkSeq('the drift finding', bad.findings, [
            'warn|coerced|id|number -> string',
        ]);
        checkStr(
            'and `data.id` now carries digits instead of a wrong number',
            (bad.data as { id: string }).id,
            '1234567890123456800',
        );
        checkSeq(
            'the event spine now has a `drift` event in it',
            bad.events.map((e) => e.type),
            ['start', 'progress', 'drift', 'result', 'done'],
        );

        const good = await run(`{"id":${SMALL_ID}}`, { output: Guarded });
        check('an intact id still succeeds', good.ok, true);
        checkSeq('…with NO finding', good.findings, []);
        checkDigits(
            '…and its value is untouched, still a number',
            (good.data as { id: number }).id,
            SMALL_ID,
        );
        note(
            "→ this is the answer to C7. `warn|coerced|id|number -> string`, on the drift channel, in `.inspect().findings`, in `.report()`, through any `TraceSink`, and through `loggerSink` at `warn` level — because a drift finding's level IS its log level. The call still resolves",
            '',
        );
        note(
            'the honest caveat: `data.id` is now a string on the corrupted path and a number on the clean one — the same value-dependent type C3(h) and C4(d) hit. It buys VISIBILITY, not correctness. The digits it carries (1234567890123456800) are still not the digits the vendor sent',
            '',
        );
    }

    heading('C7 (b) — the schema-free version, for a body you do not model');
    {
        // `unsafePaths` needs no schema, so it covers the case a refinement cannot: an undeclared
        // field, a `transform` output, a body you pass through. Wired at `transform` so it runs on
        // every call.
        const seen: string[][] = [];
        const r = await run(
            '{"page":1,"items":[{"id":' +
                SNOWFLAKE +
                ',"qty":3},{"id":' +
                SMALL_ID +
                '}],"cursor":"' +
                SNOWFLAKE +
                '","total":' +
                MAX_SAFE +
                '}',
            {
                transform: (body: unknown) => {
                    seen.push(unsafePaths(body));
                    return body;
                },
            },
        );
        check('the call succeeded', r.ok, true);
        checkSeq('the paths it flagged', seen[0] ?? [], ['items[0].id']);
        note(
            'note what it did NOT flag: `page` (small), `items[1].id` (small), `total` (exactly 2^53-1), and `cursor` — which holds the same 19 digits but as a STRING, so it never went through a number',
            '',
        );
    }

    heading('C7 (c) — the minimum, counted');
    {
        // Line counts for the two spellings, measured off this file rather than asserted.
        const src = (await import('node:fs')).readFileSync(__filename, 'utf8');
        const lines = src.split('\n');
        const start = lines.findIndex((l) => l.includes('>>> BEGIN USER CODE'));
        const end = lines.findIndex((l) => l.includes('<<< END USER CODE'));
        const executable = lines
            .slice(start + 1, end)
            .filter(
                (l) =>
                    l.trim() !== '' &&
                    !l.trim().startsWith('//') &&
                    !l.trim().startsWith('*') &&
                    !l.trim().startsWith('/*'),
            ).length;
        note('executable lines between the USER CODE markers', executable);
        check('the whole detector, counted', executable, 15);
        note(
            'the one-field version is ONE line: `z.number().refine(Number.isSafeInteger)` — and it fails the call instead of reporting. The drift-channel version is three lines (`guardedInt`), the schema-free walker eight',
            '',
        );
    }

    heading(
        'C7 (d) — false positives and false negatives over a mixed workload',
    );
    {
        // A payload per row, each labelled with what SHOULD happen. `corrupted` is ground truth,
        // computed by comparing the sent digits to the received ones — not by the detector.
        const workload: [label: string, json: string, path: string][] = [
            ['snowflake', `{"v":${SNOWFLAKE}}`, 'v'],
            ['2^53 - 1 (max safe)', `{"v":${MAX_SAFE}}`, 'v'],
            ['2^53', '{"v":9007199254740992}', 'v'],
            ['2^53 + 1', '{"v":9007199254740993}', 'v'],
            ['2^53 + 2', '{"v":9007199254740994}', 'v'],
            ['small id', `{"v":${SMALL_ID}}`, 'v'],
            ['zero', '{"v":0}', 'v'],
            ['negative snowflake', `{"v":-${SNOWFLAKE}}`, 'v'],
            ['money 19.99', '{"v":19.99}', 'v'],
            ['0.1', '{"v":0.1}', 'v'],
            ['a big float', '{"v":1234567890123.456}', 'v'],
            ['exponent 1e21', '{"v":1e21}', 'v'],
            ['id as a STRING', `{"v":"${SNOWFLAKE}"}`, 'v'],
            ['null', '{"v":null}', 'v'],
            ['boolean', '{"v":true}', 'v'],
            ['nested', `{"a":{"b":[{"v":${SNOWFLAKE}}]}}`, 'a.b[0].v'],
        ];

        let tp = 0;
        let fp = 0;
        let fn = 0;
        let tn = 0;
        const rows: string[] = [];
        for (const [label, json, path] of workload) {
            // Ground truth: re-serialise the parsed value and compare digit tokens with the wire.
            const sentToken = /:\s*(-?[\d.e+]+)\s*[},]/.exec(
                json.replace(/\[|\]/g, ''),
            )?.[1];
            const parsed = JSON.parse(json) as unknown;
            const flagged = unsafePaths(parsed);
            const detected = flagged.length > 0;
            // "corrupted" = a NUMBER token whose exact value changed. Recomputed from BigInt for
            // integer tokens; a non-numeric token is never corrupted.
            let corrupted = false;
            if (sentToken !== undefined && /^-?\d+$/.test(sentToken)) {
                const got = unsafePathValue(parsed, path);
                corrupted =
                    typeof got === 'number' &&
                    BigInt(sentToken) !== BigInt(got);
            }
            if (corrupted && detected) tp++;
            else if (!corrupted && detected) fp++;
            else if (corrupted && !detected) fn++;
            else tn++;
            rows.push(
                `${label.padEnd(20)} corrupted=${corrupted ? 'Y' : 'n'} detected=${detected ? 'Y' : 'n'} ${
                    corrupted === detected
                        ? ''
                        : corrupted
                          ? '<-- FALSE NEGATIVE'
                          : '<-- false positive'
                }`,
            );
        }
        for (const r of rows) note(r);
        check('true positives', tp, 4);
        check('true negatives', tn, 9);
        check('FALSE NEGATIVES — the number that must be zero', fn, 0);
        check('false positives', fp, 3);
        note(
            'the three false positives are 2^53, 2^53+2 and 1e21 — all above the boundary and all exactly representable, so they round-tripped and were flagged anyway',
            '',
        );
    }

    heading('C7 (e) — the false-positive RATE, on realistic snowflakes');
    {
        // The mixed workload is hand-picked and its 3/16 false-positive count is an artefact of
        // that. The number a user cares about is: given a real 19-digit snowflake, how often does
        // the detector cry wolf? Measured over 20 000 pseudo-random ids in the Discord range.
        //
        // The id is assembled ENTIRELY in BigInt, from four 16-bit chunks. The obvious spelling —
        // `Math.floor(rand() * 3e17)` — is wrong for this measurement in exactly the way the
        // scenario is about: that product is itself a double above 2^53, so every offset it can
        // produce is already a representable value, and the sample comes out ~24x more
        // "exactly-representable" than a real id stream. Measuring a precision bug with a generator
        // that has the precision bug in it was this directory's second self-inflicted error.
        let seed = 20260805;
        const rand16 = (): number => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return (seed >>> 8) & 0xffff;
        };
        const N = 20_000;
        let corrupted = 0;
        let flagged = 0;
        let missed = 0;
        for (let i = 0; i < N; i++) {
            let off = 0n;
            for (let k = 0; k < 4; k++) off = off * 65536n + BigInt(rand16());
            // A plausible snowflake: 1.1e18 .. 1.4e18, the range Discord is in today.
            const id =
                1_100_000_000_000_000_000n + (off % 300_000_000_000_000_000n);
            const parsed = JSON.parse(`{"v":${id.toString()}}`) as {
                v: number;
            };
            const lost = BigInt(parsed.v) !== id;
            const flag = unsafe(parsed.v);
            if (lost) corrupted++;
            if (flag) flagged++;
            if (lost && !flag) missed++;
        }
        note('sample size', N);
        note('ids whose digits actually changed', corrupted);
        note('ids the detector flagged', flagged);
        check('every id in this range is flagged', flagged, N);
        check('FALSE NEGATIVES across 20 000 ids', missed, 0);
        const fpRate = ((flagged - corrupted) / N) * 100;
        note(
            'false-positive rate in the snowflake range, %',
            Number(fpRate.toFixed(3)),
        );
        check('the false-positive rate is under 1%', fpRate < 1, true);
        note(
            '→ roughly 1 in 128–256: at 1.1e18 the representable doubles are spaced 128 apart, and past 2^60 (1.15e18) 256 apart, so that fraction of ids land exactly on one. Every OTHER id in the range is genuinely corrupted. A detector that fires on 100% of ids in a range where >99% are wrong is not crying wolf — it is correctly reporting that the whole field is untrustworthy',
            '',
        );
    }

    finish(
        'C7',
        "CONFIRMED — there IS a spelling that makes it loud, in the library's own channel, without failing the call. `drift(z.object({ id: z.number().transform(n => Number.isSafeInteger(n) ? n : String(n)) }))` produces the finding `warn|coerced|id|number -> string` and inserts a `drift` event into the spine (start/progress/DRIFT/result/done), while the call still resolves ok=true — so it reaches `.inspect().findings`, `.report()`, any `TraceSink`, and `loggerSink` at warn level, because a finding's level IS its log level. An intact id produces no finding and keeps its number type. The schema-free version — an 8-line recursive walker in `transform` — flags `items[0].id` in a nested payload and correctly leaves alone a small id, an exactly-2^53-1 total, and the SAME 19 digits carried as a string. Whole detector: 15 executable lines between the markers; the one-field version is one line. COST, measured: over a hand-picked 16-row workload, 4 true positives, 9 true negatives, 3 false positives (2^53, 2^53+2, 1e21 — all above the boundary and all exactly representable) and ZERO false negatives. Over 20 000 random Discord-range snowflakes (assembled in BigInt, because the obvious Math.floor(rand()*3e17) generator has the very precision bug under test baked into it and inflates the rate 17x): 20 000 flagged, 19 893 genuinely corrupted, 0 false negatives, false-positive rate 0.535% — roughly 1 in 128-256, the spacing of representable doubles at 1.1e18. It buys VISIBILITY, not correctness: the reported value 1234567890123456800 is still not the value the vendor sent",
    );
}

/** Read a dotted/indexed path (`a.b[0].v`) out of a parsed body — used only to fetch ground truth. */
function unsafePathValue(body: unknown, path: string): unknown {
    let cur: unknown = body;
    for (const seg of path.split(/\.|\[|\]/).filter(Boolean)) {
        if (cur === null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[seg];
    }
    return cur;
}

void main();
