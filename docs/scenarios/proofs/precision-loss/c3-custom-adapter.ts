// C3 — can a custom `Adapter` fix it, and what does that cost?
//
// The repair is real and it is short: a single-pass scanner (`wire.ts:quoteBigInts`) that quotes
// out-of-string integer literals above 2^53, plus a `JSON.parse` reviver that turns them back into
// `BigInt`. This script proves the parse is correct — including the case the capture says a regex
// gets wrong, a number-shaped substring INSIDE a string — and then walks every downstream seam
// asking "does this still work now that the body carries a BigInt".
//
// The capture predicts a "loud cascade". Measured, the cascade is real but SHORTER than predicted:
// the library already carries bigint handling in two of the places the capture expected to break
// (trace serialisation and the cache key encoder), both deliberately, both commented as such.
// What genuinely breaks is user-facing and unavoidable: `JSON.stringify` and every `z.number()`.
//
//   pnpm exec tsx docs/scenarios/proofs/precision-loss/c3-custom-adapter.ts
import {
    consoleSink,
    fileSink,
    stitch,
} from '../../../../packages/core/src/index';
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
import {
    BASE,
    NESTED_TEXT,
    ONE_ID_TEXT,
    SENTINEL,
    SNOWFLAKE,
    bigintAdapter,
    fmt,
    parseBigIntsAsStrings,
    parseWithBigInt,
    quoteBigInts,
} from './wire';
import { z } from './zod';

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Try something and report the exact thrown message, or `''` when it did not throw. */
function threw(fn: () => unknown): string {
    try {
        fn();
        return '';
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

async function main(): Promise<void> {
    heading('C3 (a) — is the scanner actually correct?');
    {
        // The capture's objection to the regex approach: "Breaks on numbers inside strings." So
        // that is the first thing measured. `quoteBigInts` tracks string state and escapes.
        const tricky =
            '{"note":"order 1234567890123456789 shipped","id":1234567890123456789,' +
            '"esc":"a \\" 9007199254740993 b","small":42,"neg":-9223372036854775807,' +
            '"float":1234567890123456789.5,"exp":1.2e30}';
        note('a payload designed to break a regex', tricky);
        const parsed = parseWithBigInt(tricky) as Record<string, unknown>;
        checkStr(
            'a big-integer-looking substring INSIDE a string is untouched',
            String(parsed['note']),
            'order 1234567890123456789 shipped',
        );
        checkStr(
            'and inside a string containing an escaped quote',
            String(parsed['esc']),
            'a " 9007199254740993 b',
        );
        checkDigits(
            'the real id became a BigInt with the sent digits',
            parsed['id'],
            `${SNOWFLAKE}n`,
        );
        checkDigits(
            'a negative int64 too',
            parsed['neg'],
            '-9223372036854775807n',
        );
        check(
            'a small integer stays a number',
            typeof parsed['small'],
            'number',
        );
        check(
            'a float stays a number (not an integer token — left alone)',
            typeof parsed['float'],
            'number',
        );
        check(
            'an exponent form stays a number',
            typeof parsed['exp'],
            'number',
        );
        // The size of the repair is a claim, so it is counted rather than asserted: every
        // non-blank, non-comment line from `quoteBigInts` to the end of `parseBigIntsAsStrings`.
        const src = readFileSync(join(__dirname, 'wire.ts'), 'utf8').split(
            '\n',
        );
        const from = src.findIndex((l) =>
            l.includes('export function quoteBigInts'),
        );
        const to = src.findIndex((l) =>
            l.includes('export function parseBigIntsAsStrings'),
        );
        const end = src.findIndex((l, i) => i > to && l === '}');
        const executable = src
            .slice(from, end + 1)
            .filter(
                (l) =>
                    l.trim() !== '' &&
                    !l.trim().startsWith('//') &&
                    !l.trim().startsWith('*') &&
                    !l.trim().startsWith('/*'),
            ).length;
        note(
            'executable lines in the repair (quoteBigInts + both revivers), counted',
            executable,
        );
        check('the counted size of the repair', executable, 84);
        note(
            'that is the price of the repair, and it is a real parser, not a regex',
            '',
        );
        note(
            'what it looks like on the way through',
            quoteBigInts(ONE_ID_TEXT),
        );
    }

    heading('C3 (a2) — the repair has its OWN false positive, and here it is');
    {
        // Writing this scanner turned up a constraint that is not in the capture and is not
        // obvious: the natural sentinel is a control character, because a control character cannot
        // appear unescaped in a vendor string — but `JSON.parse` REJECTS a raw control character
        // inside a string literal. This directory hit that error verbatim before settling on a
        // printable sentinel, so the collision below is a real residual cost of the repair.
        const collide = `{"label":"${SENTINEL}999","id":${SNOWFLAKE}}`;
        const parsed = parseWithBigInt(collide) as Record<string, unknown>;
        check(
            'a vendor string that happens to start with the sentinel becomes a BigInt',
            typeof parsed['label'],
            'bigint',
        );
        checkDigits('…this one', parsed['label'], '999n');
        note('the offending payload', collide);
        note(
            '→ a hand-rolled bigint parser is not free of silent misreads either; it just moves which payload triggers one, from "any id above 2^53" to "a string literally beginning ~bigint~". A real dependency (json-bigint) parses rather than pre-quotes and has no such case',
            '',
        );
    }

    heading('C3 (b) — the repaired adapter, in a stitch');
    {
        const call = stitch({
            name: 'getThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: bigintAdapter(ONE_ID_TEXT),
            output: z.object({ id: z.bigint() }),
        });
        const data = (await call()) as { id: bigint };
        checkDigits('data.id', data.id, `${SNOWFLAKE}n`);
        check('typeof data.id', typeof data.id, 'bigint');
        check(
            'and it equals the sent digits exactly',
            data.id === BigInt(SNOWFLAKE),
            true,
        );
        note('the seam works. Everything below is the bill', '');
    }

    heading('C3 (c) — COST: `output` validators');
    {
        // The most common schema in the world, applied to a repaired body.
        const numeric = stitch({
            name: 'getThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: bigintAdapter(ONE_ID_TEXT),
            output: z.object({ id: z.number() }),
        });
        const r = await numeric.safe();
        check('a `z.number()` schema now FAILS', r.ok, false);
        note('the message', r.error?.message ?? '');
        note(
            '→ every schema in the codebase that said `z.number()` for an ID has to become `z.bigint()`, one at a time, and a missed one is a hard failure rather than a silent one. That is an improvement, and it is still a migration',
            '',
        );

        // z.coerce.number() "works" and is the trap: it re-introduces the exact loss.
        const coerced = stitch({
            name: 'getThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: bigintAdapter(ONE_ID_TEXT),
            output: z.object({ id: z.coerce.number() }),
        });
        const c = await coerced.safe();
        check('but `z.coerce.number()` accepts it', c.ok, true);
        checkDigits(
            'and hands back — the corrupted value again',
            (c.data as { id: number }).id,
            '1234567890123456768',
        );
        note(
            '→ the repair is undone by one `.coerce`. The BigInt has to survive all the way to the consumer or it bought nothing',
            '',
        );
    }

    heading('C3 (d) — COST: `JSON.stringify` on the result');
    {
        const call = stitch({
            name: 'getThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: bigintAdapter(ONE_ID_TEXT),
        });
        const data = await call();
        const msg = threw(() => JSON.stringify(data));
        checkStr(
            'the exact error',
            msg,
            'Do not know how to serialize a BigInt',
        );
        note(
            '→ this is the cascade the capture names, and it is real: every log line, every response echo, every `res.json(data)` in an Express handler',
            '',
        );
        // The standard workaround, measured so the cost is concrete rather than gestured at.
        const withReplacer = JSON.stringify(data, (_k, v: unknown) =>
            typeof v === 'bigint' ? v.toString() : v,
        );
        checkStr(
            'with a replacer it serialises, to the SENT digits',
            withReplacer,
            `{"id":"${SNOWFLAKE}"}`,
        );
        note(
            'note the quotes: the id is now a JSON string on the way out. Correct, and a wire-format change your own consumers see',
            '',
        );
    }

    heading(
        'C3 (e) — REFUTATION: trace sinks do NOT break. The library already handles BigInt',
    );
    {
        // The capture predicts trace sinks among the casualties. They are not: `trace.ts:160` is a
        // `bigintSafe` JSON replacer, with a comment saying tracing must never break the call it
        // observes. The replacer sits on the JSONL writer, so `fileSink` is the path that actually
        // exercises it — written to a temp file, read back, and asserted on.
        const jsonl = join(
            mkdtempSync(join(tmpdir(), 'stitch-precision-')),
            'trace.jsonl',
        );
        let sinkError = '';
        try {
            const call = stitch({
                name: 'getThing',
                baseUrl: BASE,
                path: '/v1/things/1',
                adapter: bigintAdapter(ONE_ID_TEXT),
                trace: fileSink(jsonl, { body: { chars: false } }),
            });
            await call();
        } catch (e) {
            sinkError = e instanceof Error ? e.message : String(e);
        }
        checkStr('the real `fileSink` threw', sinkError, '');
        const written = readFileSync(jsonl, 'utf8');
        check('and it wrote records', written.length > 0, true);
        check(
            'the JSONL carries the SENT digits, `n`-suffixed',
            written.includes(`${SNOWFLAKE}n`),
            true,
        );
        note(
            'the result record it wrote',
            written
                .split('\n')
                .find((l) => l.includes('"result"'))
                ?.slice(0, 220) ?? '',
        );
        // And the human console sink, which renders to stderr rather than JSON — also clean.
        let consoleError = '';
        try {
            const call = stitch({
                name: 'getThing',
                baseUrl: BASE,
                path: '/v1/things/1',
                adapter: bigintAdapter(ONE_ID_TEXT),
                trace: consoleSink(),
            });
            await call();
        } catch (e) {
            consoleError = e instanceof Error ? e.message : String(e);
        }
        checkStr('the real `consoleSink` threw', consoleError, '');
        note(
            '→ REFUTED. `trace.ts` ships `bigintSafe`, a replacer that renders a bigint as `"<digits>n"` on the JSONL writer, commented "Tracing must never break the call it observes". A repaired body traces fine, and the trace shows the RIGHT digits — the only place in this whole scenario where a StitchAPI diagnostic surface holds the vendor\'s actual value',
            '',
        );
    }

    heading('C3 (f) — COST: `.inspect()` and `.report()`');
    {
        const call = stitch({
            name: 'getThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: bigintAdapter(ONE_ID_TEXT),
        });
        const ins = await call.inspect();
        checkDigits(
            'inspection.raw.id survives as a BigInt',
            (ins.raw as { id: unknown }).id,
            `${SNOWFLAKE}n`,
        );
        checkSeq('inspection.findings', ins.findings, []);
        const rep = await call.report();
        check('`.report()` completed', rep.status, 200);
        // The object works; SERIALISING it is what fails, and a report is meant to be pasted into
        // a support ticket, so this matters.
        checkStr(
            'JSON.stringify(report) — the exact error',
            threw(() => JSON.stringify(rep)),
            'Do not know how to serialize a BigInt',
        );
        note(
            '→ `.report()` is documented as "safe to log". With a BigInt body it is safe to READ and throws when logged. The `raw` field is non-enumerable so it is not the culprit — `data` is',
            '',
        );
    }

    heading('C3 (g) — `__config` JSON round-trip is UNAFFECTED');
    {
        // Worth measuring rather than assuming: `__config` describes the stitch, not the response,
        // so no response value can reach it. The adapter is a function and is redacted out.
        const call = stitch({
            name: 'getThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: bigintAdapter(ONE_ID_TEXT),
            output: z.object({ id: z.bigint() }),
        });
        await call();
        const json = threw(() => JSON.stringify(call.__config));
        checkStr('JSON.stringify(__config) threw', json, '');
        checkSeq('__config keys', Object.keys(call.__config).sort(), [
            'baseUrl',
            'kind',
            'name',
            'output',
            'path',
        ]);
        note(
            'the config round-trips because a response body never enters it. Confirmed, not assumed',
            '',
        );
    }

    heading('C3 (h) — the other fork: parse big integers as STRINGS');
    {
        // Same scanner, different reviver. This is the capture's "keep everything as strings", and
        // measured against the BigInt fork it costs strictly less downstream — at the price of
        // giving up arithmetic, which for an ID is not a price.
        const parsed = parseBigIntsAsStrings(NESTED_TEXT) as {
            items: { id: unknown }[];
            cursor: unknown;
        };
        checkStr(
            'the big id came back as a string with the sent digits',
            String(parsed.items[0]?.id),
            SNOWFLAKE,
        );
        check(
            'a small id stays a number',
            typeof parsed.items[1]?.id,
            'number',
        );
        checkStr(
            'and the whole body JSON.stringifies without a replacer',
            threw(() => JSON.stringify(parsed)),
            '',
        );
        note('JSON.stringify of the string-fork body', JSON.stringify(parsed));
        note(
            '→ the string fork keeps `JSON.stringify`, keeps `z.string()`, keeps structured cloning, keeps every cache store. It breaks only arithmetic and `===` against a number — which is why vendors that care ship `id_str`',
            '',
        );
        note(
            'one asymmetry worth naming: the string fork makes the TYPE depend on the VALUE — the same field is a string above 2^53 and a number below it, so a schema has to be `z.union([z.string(), z.number()])` unless the scanner quotes by KEY instead of by magnitude',
            '',
        );
    }

    heading('C3 (i) — does the engine care that the adapter is custom?');
    {
        // A quick control: nothing else in the pipeline is disturbed by the swap. Same events,
        // same shape, one attempt.
        const events: StitchEvent[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                events.push(e);
            },
        };
        const call = stitch({
            name: 'getThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: bigintAdapter(ONE_ID_TEXT),
            trace: sink,
        });
        await call();
        checkSeq(
            "event spine, identical to C1's",
            events.map((e) => e.type),
            ['start', 'progress', 'result', 'done'],
        );
        checkSeq(
            'findings',
            events
                .filter((e) => e.type === 'drift')
                .map((e) => fmt(e as never)),
            [],
        );
    }

    finish(
        'C3',
        'CONFIRMED that a custom Adapter fixes it; the COST is real but SHORTER than the capture predicted. The repair is a single-pass scanner plus a reviver — counted, 84 executable lines — and it is correct where a regex is not: a big-integer-looking substring inside a string ("order 1234567890123456789 shipped") and inside an escaped-quote string are both left untouched, floats and exponent forms pass through, and the id arrives as 1234567890123456789n. It has its OWN silent misread, measured: a vendor string beginning "~bigint~" is turned into a BigInt, because the collision-free sentinel is a control character and `JSON.parse` rejects a raw control character in a string literal. WHAT BREAKS: `output: z.number()` now hard-fails (an improvement over silence, and still a per-schema migration); `z.coerce.number()` silently UNDOES the repair back to 1234567890123456768; `JSON.stringify(data)` throws the exact string "Do not know how to serialize a BigInt", and so does `JSON.stringify(report)` — which matters because `.report()` is documented as safe to log. WHAT DOES NOT BREAK, against prediction: trace sinks. `fileSink(path, { body: { chars: false } })` wrote {"id":"1234567890123456789n"} and `consoleSink()` ran clean, because `trace.ts` already ships a `bigintSafe` replacer explicitly so tracing cannot break the call it observes — the one diagnostic surface in this whole scenario that ends up holding the vendor\'s actual digits. `__config` also round-trips (a response body never enters it) and the event spine is byte-identical to the default path. The STRING fork of the same scanner costs strictly less — `JSON.stringify` keeps working — at the price of making the field type depend on the field value',
    );
}

void main();
