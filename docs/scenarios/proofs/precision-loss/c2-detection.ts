// C2 (DECIDING) — can ANYTHING downstream detect the corruption?
//
// The capture predicts every seam fails, "because `raw` is already the parsed body". This script
// walks each seam in turn and prints what it actually held. Three of the rows now come out
// differently from the prediction — two refuted by the first run of this survey, and a third
// ((a), the capture's own example) flipped later by Zod 4. The second refutation is the most
// important measurement in this directory:
//
//   REFUTED (i)  — `Number.isSafeInteger` inside an `output` schema IS a working detector. It has
//                  zero false negatives (a corrupted integer is necessarily > 2^53, so it is
//                  necessarily unsafe) and a bounded, characterisable false-positive set (a large
//                  integer that happened to be exactly representable). The capture's "validation
//                  cannot help" is not true — and since the workspace moved to Zod 4 (#589),
//                  neither is its example "a schema that says z.number().int() passes it": Zod 4
//                  folds the safe-integer cap into `.int()`, so the capture's own spelling now
//                  rejects the corrupted id. Measured in (a).
//   REFUTED (ii) — the Adapter is NOT the only seam that can see raw text. `wire: { response:
//                  'text' }` is a published config option that makes `AdapterResponse.body` the
//                  UNPARSED STRING, on the stock `fetchAdapter`. `transform` then runs on text.
//
// Everything else the capture predicted is confirmed, and confirmed by measurement rather than by
// reading: `.inspect().raw`, `hooks.onResponse`, `Surface.interpret`, `drift()` and a `TraceSink`
// all hold the already-parsed body, and none of them can reach the bytes.
//
//   pnpm exec tsx docs/scenarios/proofs/precision-loss/c2-detection.ts
import { drift, stitch } from '../../../../packages/core/src/index';
import { httpSurface } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import type {
    AdapterResponse,
    HookContext,
    StitchEvent,
    TraceSink,
} from '../../../../packages/core/src/types';
import {
    check,
    checkDigits,
    checkSeq,
    checkStr,
    digits,
    finish,
    heading,
    note,
    printSeamTable,
    seamRow,
} from './harness';
import {
    BASE,
    ONE_ID_TEXT,
    ONE_SAFE_ID_TEXT,
    SNOWFLAKE,
    fmt,
    wireAdapter,
} from './wire';
import { z } from './zod';

/** Run one stitch over `text` with an arbitrary extra config, never throwing. */
async function run(
    text: string,
    extra: Record<string, unknown> = {},
): Promise<{
    ok: boolean;
    data: unknown;
    message: string;
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
    return {
        ok: r.ok,
        data: r.data,
        message: r.error?.message ?? '',
        findings,
        events,
    };
}

async function main(): Promise<void> {
    heading("C2 (a) — `output: z.number().int()`, the capture's example");
    {
        // On Zod 3 this seam was blind — `.int()` accepted 1234567890123456768 with zero
        // findings, and that measurement is what the capture generalised from. Zod 4 (the
        // workspace's zod@4.4.3) folds the safe-integer range into `.int()`, so the same schema
        // now rejects the corrupted id outright.
        const corrupt = await run(ONE_ID_TEXT, {
            output: z.object({ id: z.number().int() }),
        });
        check('the call FAILED on a corrupted id (Zod 4)', corrupt.ok, false);
        checkSeq('drift findings', corrupt.findings, [
            'error|invalid|id|Too big: expected int to be <=9007199254740991',
        ]);
        const intact = await run(ONE_SAFE_ID_TEXT, {
            output: z.object({ id: z.number().int() }),
        });
        check('and it ACCEPTS the intact id', intact.ok, true);
        seamRow(
            'output: z.number().int()',
            'SEES_PARSED',
            'Zod 4 caps `.int()` at 2^53-1 — rejects 1234567890123456768',
        );
        note(
            'the value is still parsed before the schema sees it — the seam holds the double, not the digits — but Zod 4 turned this row from blind into a detector with the same trade as (c): anything above 2^53 is rejected, representable or not',
            '',
        );
    }

    heading(
        'C2 (b) — `z.bigint()` and `z.string()`: they fail, but on EVERYTHING',
    );
    {
        // The interesting number is not "does it reject the corrupted id" — it is "does it accept
        // the intact one". A check that rejects both is a type mismatch, not a detector.
        for (const [name, schema] of [
            ['z.bigint()', z.object({ id: z.bigint() })],
            ['z.string()', z.object({ id: z.string() })],
        ] as const) {
            const bad = await run(ONE_ID_TEXT, { output: schema });
            const good = await run(ONE_SAFE_ID_TEXT, { output: schema });
            check(`${name} rejects the CORRUPTED id`, bad.ok, false);
            check(
                `${name} also rejects the INTACT id (false positive)`,
                good.ok,
                false,
            );
            note(`${name} finding on the intact id`, good.findings[0] ?? '');
            seamRow(
                `output: ${name}`,
                'SEES_PARSED',
                'rejects every JSON number — 100% false-positive rate',
            );
        }
        note(
            '→ these do not detect corruption. They detect "the wire type is number", which is always true, so they are unusable as a guard rather than a partial one',
            '',
        );
    }

    heading(
        'C2 (c) — REFUTATION: `Number.isSafeInteger` in a schema DOES separate them',
    );
    {
        // The capture says "validation cannot help: the corrupted value is a perfectly valid number".
        // The first half is wrong. Validation cannot recover the SENT value — nothing can — but it
        // can reliably answer "did this field pass through the lossy zone", which is the question
        // that turns a silent bug into a loud one.
        const Safe = z.object({
            id: z.number().refine(Number.isSafeInteger, {
                message: 'integer exceeds 2^53 — precision was lost in transit',
            }),
        });
        const bad = await run(ONE_ID_TEXT, { output: Safe });
        const good = await run(ONE_SAFE_ID_TEXT, { output: Safe });
        check('rejects the CORRUPTED id', bad.ok, false);
        check('ACCEPTS the intact id — no false positive', good.ok, true);
        checkSeq('the finding it produced', bad.findings, [
            'error|invalid|id|integer exceeds 2^53 — precision was lost in transit',
        ]);
        seamRow(
            'output: .refine(isSafeInteger)',
            'SEES_PARSED',
            'REJECTS corrupted, ACCEPTS intact — a working detector',
        );

        // The exact boundary, since the claim is about reliability. Every integer a double cannot
        // represent is above 2^53, so its parsed value is above 2^53 too: there is no corrupted
        // value that `isSafeInteger` calls safe. FALSE NEGATIVES ARE IMPOSSIBLE, and this walks the
        // boundary to show it.
        const boundary = [
            ['2^53 - 1', '9007199254740991'],
            ['2^53', '9007199254740992'],
            ['2^53 + 1', '9007199254740993'],
            ['2^53 + 2', '9007199254740994'],
        ] as const;
        const rows: string[] = [];
        for (const [label, sent] of boundary) {
            const r = await run(`{"id":${sent}}`, {
                output: z.object({ id: z.number() }),
            });
            const got = digits((r.data as { id: number }).id);
            const lossless = got === sent;
            const flagged = !Number.isSafeInteger(
                (r.data as { id: number }).id,
            );
            rows.push(
                `${label}: sent ${sent} got ${got} lossless=${String(lossless)} flagged=${String(flagged)}`,
            );
        }
        for (const r of rows) note(r);
        checkSeq('the boundary, walked', rows, [
            '2^53 - 1: sent 9007199254740991 got 9007199254740991 lossless=true flagged=false',
            '2^53: sent 9007199254740992 got 9007199254740992 lossless=true flagged=true',
            '2^53 + 1: sent 9007199254740993 got 9007199254740992 lossless=false flagged=true',
            '2^53 + 2: sent 9007199254740994 got 9007199254740994 lossless=true flagged=true',
        ]);
        note(
            '→ read the two right-hand columns. `lossless=false` NEVER co-occurs with `flagged=false`: no false negatives, ever. The reverse does occur — 2^53 and 2^53+2 round-tripped exactly and were still flagged — so the cost is FALSE POSITIVES on large-but-representable integers (the even ones, above the boundary)',
            '',
        );
        note(
            'which is the correct trade for an ID: you cannot tell 9007199254740992-because-that-is-what-they-sent from 9007199254740992-because-they-sent-...93. The value is untrustworthy either way',
            '',
        );
    }

    heading('C2 (d) — `drift()`: what is on the LEFT side of the diff?');
    {
        // The capture asks the critical question directly: does drift compare against raw TEXT or
        // against the parsed body? `engine.ts:1233` says `const rawBody = value` — the post-
        // transform, pre-validation PARSED value. This measures it rather than reading it.
        //
        // The probe: a schema that COERCES number -> string. Drift reports coercions, and the
        // finding's detail names the before/after kinds — but more usefully, the coerced VALUE lands
        // in `data`. If drift's left side were the wire text, the coerced string would be the sent
        // digits. If it is the parsed double, the coerced string is `String(double)`.
        const Coerce = z.object({ id: z.coerce.string() });
        const r = await run(ONE_ID_TEXT, { output: drift(Coerce) });
        check('the call succeeded', r.ok, true);
        checkStr(
            'the coerced id — sent digits, or String(double)?',
            (r.data as { id: string }).id,
            '1234567890123456800',
        );
        check(
            'does the coerced string equal the sent digits?',
            (r.data as { id: string }).id === SNOWFLAKE,
            false,
        );
        checkSeq('the drift finding', r.findings, [
            'warn|coerced|id|number -> string',
        ]);
        note(
            '→ `number -> string` is drift SEEING a number on its left side. If the left side were the wire text, the kind would have been `string -> string` and the value would have been 1234567890123456789. It is neither',
            '',
        );
        seamRow(
            'drift()',
            'SEES_PARSED',
            'diff(parsed, validated) — coerced to "1234567890123456800"',
        );

        // And the plain case: with a matching schema there is nothing to diff, so drift is silent.
        const plain = await run(ONE_ID_TEXT, {
            output: drift(z.object({ id: z.number() })),
        });
        checkSeq(
            'drift() findings on a plain matching schema',
            plain.findings,
            [],
        );
        note(
            "the library's flagship feature, pointed at its most basic failure — a value that is not the value the vendor sent — reports nothing, because both sides of its diff are downstream of the loss",
            '',
        );
    }

    heading('C2 (e) — `.inspect().raw`');
    {
        const call = stitch({
            name: 'getThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: wireAdapter(ONE_ID_TEXT),
        });
        const ins = await call.inspect();
        check('typeof inspection.raw', typeof ins.raw, 'object');
        check('inspection.source', ins.source, 'live');
        checkDigits(
            'inspection.raw.id',
            (ins.raw as { id: unknown }).id,
            '1234567890123456768',
        );
        check(
            'typeof inspection.raw.id',
            typeof (ins.raw as { id: unknown }).id,
            'number',
        );
        seamRow(
            '.inspect().raw',
            'SEES_PARSED',
            'an object whose .id is the number 1234567890123456768',
        );
        note(
            '`raw` means "pre-VALIDATION", not "pre-parse". It is the left side of drift\'s diff, and it is the same object `output` sees',
            '',
        );
    }

    heading('C2 (f) — `hooks.onResponse`: what exactly is `ctx.res.body`?');
    {
        let ctxKeys: string[] = [];
        let resKeys: string[] = [];
        let bodyType = '';
        let idDigits = '';
        let textReachable = false;
        await run(ONE_ID_TEXT, {
            hooks: {
                onResponse: (ctx: HookContext) => {
                    ctxKeys = Object.keys(ctx).sort();
                    const res = (ctx as { res: AdapterResponse }).res;
                    resKeys = Object.keys(res).sort();
                    bodyType = typeof res.body;
                    idDigits = digits((res.body as { id: unknown }).id);
                    // The whole question: is the wire text reachable from here by ANY route?
                    const dump = JSON.stringify({ ctxKeys, resKeys });
                    textReachable =
                        dump.includes(SNOWFLAKE) ||
                        resKeys.some((k) =>
                            /text|raw|bytes|body_?text|source/i.test(k),
                        );
                },
            },
        });
        checkSeq('Object.keys(ctx)', ctxKeys, ['attempt', 'name', 'res']);
        checkSeq('Object.keys(ctx.res)', resKeys, [
            'body',
            'headers',
            'status',
            'url',
        ]);
        checkStr('typeof ctx.res.body', bodyType, 'object');
        checkStr('ctx.res.body.id', idDigits, '1234567890123456768');
        check('any key on ctx.res that could hold text', textReachable, false);
        seamRow(
            'hooks.onResponse',
            'SEES_PARSED',
            'ctx.res = {body,headers,status,url}; body.id = 1234567890123456768',
        );
        note(
            'four keys. The `AdapterResponse` the hook receives is the SAME object `fetchAdapter` returned, and `fetchAdapter` discarded `text` at line 135',
            '',
        );
    }

    heading('C2 (g) — `Surface.interpret`');
    {
        // The surface hook runs on the AdapterResponse directly — the earliest engine-level seam
        // there is. It is still after the adapter.
        let seenType = '';
        let seenId = '';
        const spySurface: Surface = {
            ...httpSurface,
            id: 'http',
            interpret: (res: AdapterResponse) => {
                seenType = typeof res.body;
                seenId = digits((res.body as { id: unknown }).id);
                return { ok: true, data: res.body };
            },
        };
        const r = await run(ONE_ID_TEXT, { kind: spySurface });
        check('the surface ran', r.ok, true);
        checkStr('typeof res.body inside interpret', seenType, 'object');
        checkStr('res.body.id inside interpret', seenId, '1234567890123456768');
        seamRow(
            'Surface.interpret',
            'SEES_PARSED',
            'res.body.id = 1234567890123456768',
        );
    }

    heading('C2 (h) — a `TraceSink`');
    {
        const r = await run(ONE_ID_TEXT);
        const dump = r.events
            .map((e) => {
                try {
                    return JSON.stringify(e);
                } catch {
                    return String(e);
                }
            })
            .join('\n');
        check(
            'sent digits anywhere in the trace',
            dump.includes(SNOWFLAKE),
            false,
        );
        // Symbols are the library's channel for out-of-band payloads (RAW_BODY). Check whether a
        // sink could reach one.
        const syms = r.events.flatMap((e) => Object.getOwnPropertySymbols(e));
        checkSeq(
            'own symbols on any traced event',
            syms.map((s) => s.toString()),
            [],
        );
        seamRow(
            'TraceSink',
            'SEES_PARSED',
            'four events, no wire text, no symbol channels',
        );
    }

    heading(
        'C2 (i) — REFUTATION: `wire: { response: "text" }` DOES deliver the raw bytes',
    );
    {
        // The capture concludes "that makes the `Adapter` the only candidate seam". It is not.
        // `wire.response` is a published `StitchConfig` option that sets `AdapterRequest.responseType`,
        // and `fetchAdapter` honours `'text'` at line 123-124 — BEFORE the json branch at 133-135.
        // The body handed to the engine is then the unparsed string, on the STOCK transport.
        let hookBodyType = '';
        let hookBody = '';
        const r = await run(ONE_ID_TEXT, {
            wire: { response: 'text' },
            hooks: {
                onResponse: (ctx: HookContext) => {
                    const res = (ctx as { res: AdapterResponse }).res;
                    hookBodyType = typeof res.body;
                    hookBody = String(res.body);
                },
            },
        });
        check('the call succeeded', r.ok, true);
        checkStr('typeof ctx.res.body', hookBodyType, 'string');
        checkStr(
            'ctx.res.body — the VERBATIM WIRE TEXT',
            hookBody,
            ONE_ID_TEXT,
        );
        checkStr(
            'and the resolved data is that same string',
            String(r.data),
            ONE_ID_TEXT,
        );
        check(
            'the SENT digits are present and intact in user space',
            hookBody.includes(SNOWFLAKE),
            true,
        );
        seamRow(
            'wire:{response:"text"}',
            'SEES_TEXT',
            `ctx.res.body === ${JSON.stringify(ONE_ID_TEXT)}`,
        );
        note(
            '→ this is a stock `stitch()` with one extra config key and NO custom adapter. The capture\'s "the Adapter is the only candidate seam" is REFUTED',
            '',
        );
    }

    heading(
        'C2 (j) — …and `transform` runs on that text, so the repair is in config',
    );
    {
        // Chaining the refutation: with `wire.response: 'text'`, `transform` is a pre-parse seam.
        // It receives the bytes and returns whatever it likes — including a body with the id kept
        // as a string. No adapter written, no dependency added.
        const r = await run(ONE_ID_TEXT, {
            wire: { response: 'text' },
            transform: (body: unknown) =>
                JSON.parse(
                    String(body).replace(
                        /:\s*(-?\d{16,})/g,
                        (_m: string, d: string) => `:"${d}"`,
                    ),
                ) as unknown,
            output: z.object({ id: z.string() }),
        });
        check('the call succeeded', r.ok, true);
        checkStr(
            'and `data.id` is the SENT digits, exactly',
            (r.data as { id: string }).id,
            SNOWFLAKE,
        );
        seamRow(
            'transform (under text)',
            'SEES_TEXT',
            `repaired to "${SNOWFLAKE}" with no custom adapter`,
        );
        note(
            'the regex here is the capture\'s own "JSON parser written in regex", and it carries that criticism honestly — C3 does it properly with a scanner. The measured point is only WHERE it can run: `transform`, in config, not in a transport',
            '',
        );
    }

    heading('C2 — the seam table');
    {
        const tally = printSeamTable();
        console.log('');
        check('seams that see the raw text', tally.text, 2);
        check('seams that see only the parsed body', tally.parsed, 9);
        note(
            'and BOTH text-seeing rows are the same seam pair — `wire.response: "text"` moves the parse into user space, and `transform` is where it lands',
            '',
        );
    }

    finish(
        'C2',
        'PARTIALLY REFUTED — the capture is right about the seams it named and wrong about its conclusion, and Zod 4 has since retired its headline example. CONFIRMED: every named seam holds the parsed double — `.inspect().raw` is an OBJECT whose `.id` is the number 1234567890123456768 (`raw` means pre-VALIDATION, not pre-parse); `hooks.onResponse` gets `ctx = {attempt,name,res}` and `ctx.res = {body,headers,status,url}` with `body.id = 1234567890123456768` and no key that could hold text; `Surface.interpret` sees the same; a `TraceSink` sees four events, no wire text and no symbol channels. And drift\'s left side is measured, not assumed: under `z.coerce.string()` the finding is `warn|coerced|id|number -> string` and the coerced value is "1234567890123456800" — a NUMBER on the left, not the sent digits — so `diff(raw, validated)` compares parsed-to-validated, and on a matching schema `drift()` reports nothing at all. OVERTAKEN: "`output: z.number().int()` accepts 1234567890123456768 with zero findings" was true on Zod 3; Zod 4\'s `.int()` enforces the safe-integer range, so the same schema now REJECTS it — `error|invalid|id|Too big: expected int to be <=9007199254740991` — while accepting the intact id. TWO REFUTATIONS. (i) `z.number().refine(Number.isSafeInteger)` IS a working detector: it rejects the corrupted id and ACCEPTS the intact one, and walking 2^53-1 / 2^53 / 2^53+1 / 2^53+2 shows `lossless=false` never co-occurs with `flagged=false` — false negatives are impossible; the cost is false positives on large-but-representable integers. (ii) The Adapter is NOT the only seam that can see bytes: `wire: { response: "text" }` is published config that makes `ctx.res.body` the verbatim string {"id":1234567890123456789} on the STOCK `fetchAdapter`, and `transform` then runs pre-parse — a config-only repair that recovered the exact sent digits',
    );
}

void main();
