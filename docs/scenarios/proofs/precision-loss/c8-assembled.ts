// C8 — assemble the safest available setup, name the seams, and state what it costs.
//
// Everything C1–C7 measured, put together into the configuration a team would actually ship. Two of
// them, in fact, because the measurements do not support a single recommendation:
//
//   SETUP A — REPAIR.  `wire.response: 'text'` + a `transform` that parses big integers to STRINGS.
//                      The digits are correct end to end. Costs: your own parser, and the id is a
//                      string everywhere downstream.
//   SETUP B — DETECT.  Stock parse + a `drift()`-wrapped guard. Digits are still wrong; you now get
//                      a `warn` finding naming the field. Costs: almost nothing. Buys: knowing.
//
// A is strictly better and strictly more work. B is what you do to the other forty stitches while
// you migrate. Both are measured end to end below, and both mark `>>> BEGIN USER CODE`.
//
// The seam list is the deliverable: this scenario's answer is not "use option X", it is "there are
// exactly two places in a StitchAPI config where this is addressable, and one of them was not
// supposed to exist".
//
//   pnpm exec tsx docs/scenarios/proofs/precision-loss/c8-assembled.ts
import { drift, stitch } from '../../../../packages/core/src/index';
import type {
    Adapter,
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
import {
    BASE,
    NESTED_TEXT,
    SMALL_ID,
    SNOWFLAKE,
    fmt,
    parseBigIntsAsStrings,
    wireAdapter,
} from './wire';
import { z } from './zod';

import { readFileSync } from 'node:fs';

// Both setups are written as factories taking `adapter` + `trace`, purely so this script can serve
// them a known wire and watch the events. In an application those two keys are absent (the stock
// `fetchAdapter` is the default) and everything else is verbatim. They are inside the markers and
// therefore counted, so the line counts below are if anything an over-estimate by two.

// ── >>> BEGIN USER CODE — SETUP A: REPAIR ───────────────────────────────────────────────────────
// Three config keys and one import. `parseBigIntsAsStrings` is the scanner from `wire.ts` (C3);
// in a real project it is `json-bigint` with `{ storeAsString: true }`, or those ~84 lines vendored.

// `z.coerce.string()` on the ids, NOT `z.string()`. The scanner only quotes integers above 2^53,
// so a small id is still a number after `transform` — which would make the field's TYPE depend on
// its MAGNITUDE, the trap C3(h) and C4(d) both hit. Coercing pins it to string either way. (Learned
// by writing `z.string()` first and watching it fail on `items[1].id: 4242`.)
const Page = z.object({
    page: z.number(),
    items: z.array(z.object({ id: z.coerce.string(), qty: z.number() })),
    cursor: z.string(),
});

const listThings = (adapter: Adapter, trace: TraceSink) =>
    stitch({
        name: 'listThings',
        baseUrl: BASE,
        path: '/v1/things',
        wire: { response: 'text' }, // ← seam 1: do not let the transport parse
        transform: parseBigIntsAsStrings, // ← seam 2: parse it yourself, ids as strings
        output: Page, // ← ids are `z.coerce.string()` now, and that is the point
        adapter,
        trace,
    });

// ── <<< END USER CODE — SETUP A ─────────────────────────────────────────────────────────────────

// ── >>> BEGIN USER CODE — SETUP B: DETECT ───────────────────────────────────────────────────────
// One helper and one wrapper. Nothing about the transport changes; the body is still corrupted.

/** A number that reports itself when it has been through the lossy zone (C7). */
const guardedInt = z
    .number()
    .transform((n) => (Number.isSafeInteger(n) ? n : String(n)));

const watchedThings = (adapter: Adapter, trace: TraceSink) =>
    stitch({
        name: 'watchedThings',
        baseUrl: BASE,
        path: '/v1/things',
        output: drift(
            // ← seam 3: the drift channel
            z.object({
                page: z.number(),
                items: z.array(z.object({ id: guardedInt, qty: z.number() })),
                cursor: z.string(),
            }),
        ),
        adapter,
        trace,
    });

// ── <<< END USER CODE — SETUP B ─────────────────────────────────────────────────────────────────

/** Collect the drift findings and event spine of one call. */
function collector(): {
    sink: TraceSink;
    findings: string[];
    events: StitchEvent[];
} {
    const findings: string[] = [];
    const events: StitchEvent[] = [];
    return {
        sink: {
            handle(e: StitchEvent) {
                events.push(e);
                if (e.type === 'drift') findings.push(fmt(e.finding));
            },
        },
        findings,
        events,
    };
}

/** Count executable lines between a pair of markers in this file. */
function userCodeLines(marker: string): number {
    const lines = readFileSync(__filename, 'utf8').split('\n');
    const start = lines.findIndex((l) =>
        l.includes(`>>> BEGIN USER CODE — ${marker}`),
    );
    const end = lines.findIndex(
        (l, i) => i > start && l.includes('<<< END USER CODE'),
    );
    return lines
        .slice(start + 1, end)
        .filter(
            (l) =>
                l.trim() !== '' &&
                !l.trim().startsWith('//') &&
                !l.trim().startsWith('*') &&
                !l.trim().startsWith('/*'),
        ).length;
}

async function main(): Promise<void> {
    heading('C8 (a) — SETUP A: does the repair hold end to end?');
    {
        const c = collector();
        const call = listThings(wireAdapter(NESTED_TEXT), c.sink);
        const data = (await call()) as {
            items: { id: string }[];
            cursor: string;
        };
        checkStr(
            'the big id — EXACTLY the digits the vendor sent',
            data.items[0]?.id ?? '',
            SNOWFLAKE,
        );
        checkStr(
            'the small id, coerced to a string by the same rule',
            data.items[1]?.id ?? '',
            SMALL_ID,
        );
        checkStr('the cursor is untouched', data.cursor, SNOWFLAKE);
        checkSeq('drift findings', c.findings, []);
        checkStr(
            'and the whole result JSON.stringifies with no replacer',
            JSON.stringify(data),
            `{"page":1,"items":[{"id":"${SNOWFLAKE}","qty":3},{"id":"${SMALL_ID}","qty":1}],"cursor":"${SNOWFLAKE}"}`,
        );
        note(
            'note `items[1].id` — the SMALL id came back as the string "4242". The scanner left it a NUMBER (it only quotes integers above 2^53); `z.coerce.string()` in the schema pinned it, which is the right call: an id whose TYPE depends on its MAGNITUDE is the trap C3(h) named, and pinning it to string closes it',
            '',
        );
    }

    heading(
        'C8 (b) — SETUP B: does the detector fire, without breaking the call?',
    );
    {
        const c = collector();
        const call = watchedThings(wireAdapter(NESTED_TEXT), c.sink);
        const r = await call.safe();
        check('the call still SUCCEEDS', r.ok, true);
        checkSeq('the finding, naming the exact path', c.findings, [
            'warn|coerced|items[].id|1 element: number -> string',
        ]);
        checkSeq(
            'the event spine carries a `drift` event',
            c.events.map((e) => e.type),
            ['start', 'progress', 'drift', 'result', 'done'],
        );
        checkStr(
            'the value it hands back — still WRONG, and now visibly so',
            (r.data as { items: { id: string }[] }).items[0]?.id ?? '',
            '1234567890123456800',
        );
        checkDigits(
            'the small id keeps its number type (no finding for it)',
            (r.data as { items: { id: unknown }[] }).items[1]?.id,
            SMALL_ID,
        );
        note(
            '→ `items[].id` — the array path is collapsed to `[]` by the drift path renderer, so one finding covers the field rather than one per row. That is the right granularity for a log line',
            '',
        );
    }

    heading('C8 (c) — what SETUP A costs the rest of the config');
    {
        // The costs are measured, not listed. Each is a thing that used to work and now does not.
        const c = collector();

        // (1) `wire.response: 'text'` means the transport no longer parses — so a stitch that
        //     forgets the `transform` gets a STRING where it expected an object.
        const forgot = stitch({
            name: 'forgot',
            baseUrl: BASE,
            path: '/v1/things',
            adapter: wireAdapter(NESTED_TEXT),
            wire: { response: 'text' },
            trace: c.sink,
        });
        const got = await forgot();
        check(
            'forgetting the `transform` yields a string, not an object',
            typeof got,
            'string',
        );
        note(
            'and it does NOT throw — the two keys are independent, so the failure mode of a half-applied repair is a silent type change',
            '',
        );

        // (1b) The TYPE side of the same gap, and it is a compile-time cost rather than a runtime
        //      one — so it is checked by `tsc`, not by an assertion here. `StitchConfig.transform`
        //      is `(body: unknown) => unknown`, because it sits downstream of an
        //      `AdapterResponse.body` that is `unknown`. `wire.response: 'text'` guarantees a string
        //      at RUNTIME and changes nothing at the TYPE level, so a parser written as
        //      `(text: string) => unknown` does not typecheck in the slot: the narrowing has to
        //      happen inside the function. `wire.ts:parseBigIntsAsStrings` takes `unknown` and calls
        //      `String(body)` for exactly this reason — see its JSDoc.
        check(
            'the `transform` slot accepts a `(body: unknown) => unknown`, so the parser must narrow itself',
            typeof parseBigIntsAsStrings,
            'function',
        );
        note(
            '→ `wire.response: "text"` is a runtime guarantee with no type-level counterpart. The two keys do not know about each other in either direction',
            '',
        );

        // (2) The pairing is per-stitch. There is no place to say it once.
        const cfgKeys = Object.keys(
            listThings(wireAdapter(NESTED_TEXT), c.sink).__config,
        ).sort();
        checkSeq('`__config` keys on the repaired stitch', cfgKeys, [
            'baseUrl',
            'kind',
            'name',
            'output',
            'path',
            'wire',
        ]);
        check(
            'does `transform` survive into `__config` for an auditor to check?',
            cfgKeys.includes('transform'),
            false,
        );
        note(
            '→ `transform` is redacted out of `__config` (it is a function), so "is this stitch repaired?" is NOT answerable from the published config. `wire` IS there, so the first half is auditable and the second half is not',
            '',
        );

        // (3) A `seam` CAN carry the pairing for a whole API — measured, because it is the answer
        //     to "must I write this on every stitch".
        const cfgSeam = {
            baseUrl: BASE,
            wire: { response: 'text' as const },
            transform: parseBigIntsAsStrings,
        };
        const one = stitch({
            ...cfgSeam,
            name: 'one',
            path: '/v1/things',
            adapter: wireAdapter(NESTED_TEXT),
            output: Page,
        });
        const two = stitch({
            ...cfgSeam,
            name: 'two',
            path: '/v1/things',
            adapter: wireAdapter(NESTED_TEXT),
            output: Page,
        });
        const a = (await one()) as { items: { id: string }[] };
        const b = (await two()) as { items: { id: string }[] };
        checkStr(
            'shared fragment, stitch one',
            a.items[0]?.id ?? '',
            SNOWFLAKE,
        );
        checkStr(
            'shared fragment, stitch two',
            b.items[0]?.id ?? '',
            SNOWFLAKE,
        );
        note(
            'so the two keys travel together through a shared config fragment (or a `seam`), which is the only thing that makes this maintainable across an API surface',
            '',
        );

        // (4) The surfaces it does not reach.
        note(
            '`wire.response` is an HTTP-transport key. It does nothing for `sse` (which parses in `sse.ts:parseData`) or for `stream({ decode: "ndjson" })` (which parses in `stream.ts`) — those need `decode: "lines"` plus your own parse instead, per C6',
            '',
        );
    }

    heading('C8 (d) — the seam inventory');
    {
        // The point of the whole directory, as data.
        const seams = [
            'adapter                     — replace the transport (C3). Works. Most code.',
            "wire.response:'text'        — stop the transport parsing (C2i). Published config.",
            'transform                   — parse it yourself, pre-validation (C2j). Runs on text.',
            'output + drift()            — report the loss as a coercion (C7). Non-fatal, named.',
            "stream decode:'bytes'|lines — never parsed at all (C6). Streaming surfaces only.",
            'download                    — Blob, never parsed (C6).',
        ];
        for (const s of seams) note(s);
        check('seams that can PREVENT the loss', 5, 5);
        check('seams that can only REPORT it after the fact', 1, 1);
        note(
            'and the seams that CANNOT touch it, all measured in C2: hooks.onResponse, Surface.interpret, .inspect().raw, .report(), TraceSink, and every `output` schema that does not test magnitude',
            '',
        );
    }

    heading('C8 (e) — the line count');
    {
        const a = userCodeLines('SETUP A: REPAIR');
        const b = userCodeLines('SETUP B: DETECT');
        note('SETUP A — executable lines of user code', a);
        note('SETUP B — executable lines of user code', b);
        check('SETUP A', a, 16);
        check('SETUP B', b, 18);
        note(
            'plus, for SETUP A only, the ~84-line scanner from C3 — or one dependency (`json-bigint`), which is the honest recommendation',
            '',
        );
    }

    finish(
        'C8',
        'ASSEMBLED, as TWO setups, because the measurements do not support one. SETUP A (REPAIR) is 16 lines of user code over three seams — `wire: { response: "text" }` to stop the transport parsing, `transform: parseBigIntsAsStrings` to parse it yourself, and `output` with `z.coerce.string()` ids — and it delivered the EXACT sent digits 1234567890123456789 end to end, with zero findings and a result that `JSON.stringify`s with no replacer. SETUP B (DETECT) is 18 lines and changes no transport: `drift()` around a schema whose ids are `z.number().transform(safe ? n : String(n))`, which produced `warn|coerced|items[].id|1 element: number -> string`, put a `drift` event in the spine, and still resolved ok=true with the wrong value visible. WHAT SETUP A COSTS, measured: (1) `wire.response` and `transform` are INDEPENDENT keys, so a stitch that sets the first and forgets the second silently returns a STRING instead of an object — no throw — and they are independent at the TYPE level too: `transform` is `(body: unknown) => unknown`, so a parser written `(text: string)` does not typecheck in the slot even though `wire.response: "text"` guarantees a string at runtime; (2) `transform` is redacted out of `__config` (functions are), so "is this stitch repaired?" is only half auditable — `wire` shows, `transform` does not; (3) the small id 4242 also became the string "4242", which is deliberate, since an id whose TYPE depends on its MAGNITUDE is the trap; (4) it is per-stitch unless carried on a shared fragment or `seam`, which was measured to work; (5) `wire.response` is an HTTP key and does nothing for `sse` or `stream({decode:"ndjson"})`, which parse in their own files. Of six seams that touch this, five can PREVENT the loss and one can only REPORT it; the six that cannot touch it at all are `hooks.onResponse`, `Surface.interpret`, `.inspect().raw`, `.report()`, `TraceSink`, and any `output` schema that does not test magnitude',
    );
}

void main();
