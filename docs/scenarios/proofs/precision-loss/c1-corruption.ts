// C1 (DECIDING) — does the default path corrupt, and is it silent?
//
// The measurement is deliberately blunt: put a known digit string on the wire, run the library's
// real default transport over it, and print the digits that came out the other side. No schema, no
// drift, no options — the plainest `stitch()` anyone would write.
//
// The scenario claims two things and this script separates them, because they are not the same
// claim and they do not have to both be true:
//
//   (1) the value CHANGES  — measured as sent-digits vs received-digits, field by field.
//   (2) NOTHING SAYS SO    — measured by enumerating the entire event spine, every drift finding,
//                            and every field of `.report()`, and finding no mention of it.
//
//   pnpm exec tsx docs/scenarios/proofs/precision-loss/c1-corruption.ts
import { stitch } from '../../../../packages/core/src/index';
import type {
    StitchEvent,
    TraceSink,
} from '../../../../packages/core/src/types';
import {
    check,
    checkDigits,
    checkSeq,
    digits,
    finish,
    heading,
    note,
    printWireTable,
    wireRow,
} from './harness';
import {
    BASE,
    BIGINT_PK,
    FIFTH,
    MAX_SAFE,
    MONEY,
    SMALL_ID,
    SNOWFLAKE,
    TENTH,
    TWO53_PLUS_1,
    WIRE_TEXT,
    fmt,
    wireAdapter,
} from './wire';

/** Everything one run of the plainest possible stitch produced. */
interface Run {
    data: Record<string, unknown>;
    events: StitchEvent[];
    findings: string[];
}

/** The plainest stitch anyone would write: a base, a path, a transport. Nothing else. */
async function plainCall(text: string): Promise<Run> {
    const events: StitchEvent[] = [];
    const findings: string[] = [];
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
    });
    const data = (await call()) as Record<string, unknown>;
    return { data, events, findings };
}

async function main(): Promise<void> {
    heading('C1 (a) — the wire text, verbatim');
    // Printed in full first, so every digit asserted below is visibly the digit that was sent.
    note('the exact bytes the fake vendor returns', WIRE_TEXT);
    note('WIRE_TEXT length in bytes', WIRE_TEXT.length);

    const run = await plainCall(WIRE_TEXT);

    heading('C1 (b) — sent digits vs received digits, field by field');
    {
        wireRow('snowflake (Discord/X)', SNOWFLAKE, run.data['snowflake']);
        wireRow('2^53 + 1', TWO53_PLUS_1, run.data['two53_plus_1']);
        wireRow('bigint PK (int64 max)', BIGINT_PK, run.data['bigint_pk']);
        wireRow('money 19.99', MONEY, run.data['money']);
        wireRow('0.1', TENTH, run.data['tenth']);
        wireRow('0.2', FIFTH, run.data['fifth']);
        wireRow('CONTROL 2^53 - 1', MAX_SAFE, run.data['max_safe']);
        wireRow('CONTROL small id', SMALL_ID, run.data['small_id']);
        const tally = printWireTable();
        console.log('');

        // The three that must break, asserted as EXACT digit strings — the received digits are
        // hard-coded here so a change in V8's parse would fail this script rather than silently
        // rewrite the evidence.
        checkDigits(
            'snowflake received',
            run.data['snowflake'],
            '1234567890123456768',
        );
        checkDigits(
            '2^53+1 received',
            run.data['two53_plus_1'],
            '9007199254740992',
        );
        checkDigits(
            'bigint PK received',
            run.data['bigint_pk'],
            '9223372036854775808',
        );

        // The two that must survive, asserted the same way. Without these the claim would be
        // "JavaScript numbers are approximate", which is not the scenario.
        checkDigits('CONTROL 2^53-1 received', run.data['max_safe'], MAX_SAFE);
        checkDigits(
            'CONTROL small id received',
            run.data['small_id'],
            SMALL_ID,
        );

        check('values corrupted', tally.corrupted, 3);
        check('values intact', tally.intact, 5);

        note(
            'the snowflake moved by exactly this many units',
            String(BigInt(SNOWFLAKE) - BigInt(digits(run.data['snowflake']))),
        );
    }

    heading(
        'C1 (b2) — the money rows came back "intact", and that is a REAL result, not a bug in the table',
    );
    {
        // The capture files "a decimal money amount" alongside the snowflakes, as the same failure.
        // Measured, it is NOT the same failure, and the distinction decides whether a round-trip
        // detector can ever see it.
        //
        // `19.99` is not exactly representable either — but the nearest double's SHORTEST
        // round-tripping decimal form is the string `"19.99"`. So it goes out as `19.99` and comes
        // back as `19.99`: the wire round-trip is LOSSLESS even though the value is inexact. A
        // 64-bit integer has no such luck, because two distinct integers share one double and the
        // shortest form of that double is a third string again.
        check(
            'the received money value re-serialises to the same token that was sent',
            JSON.stringify(run.data['money']),
            MONEY,
        );
        note(
            'yet the value is not 19.99 — at 20 decimal places it is',
            (run.data['money'] as number).toFixed(20),
        );
        check(
            'so `money * 100` is not an integer number of cents',
            Number.isInteger((run.data['money'] as number) * 100),
            false,
        );
        note('19.99 * 100 =', String((run.data['money'] as number) * 100));
        note(
            '0.1 + 0.2 as received',
            (run.data['tenth'] as number) + (run.data['fifth'] as number),
        );
        note(
            '→ decimals fail in ARITHMETIC, integers above 2^53 fail in TRANSPORT. Only the second is a wire-fidelity bug, and only the second is in principle detectable by comparing digits',
            '',
        );
    }

    heading(
        'C1 (c) — the vendor also sent the SAME id as a string. It survived',
    );
    {
        // The `id_str` convention, measured. It is the one row in the table that is both large and
        // intact, and it is intact because it never went through a number.
        checkDigits(
            'snowflake_str',
            run.data['snowflake_str'],
            `"${SNOWFLAKE}"`,
        );
        check(
            'and it does NOT equal the number field',
            String(run.data['snowflake_str']) === digits(run.data['snowflake']),
            false,
        );
        note(
            'so the corruption is not "large integers are impossible in JS" — it is "the JSON number type is lossy". The string field crossed the same wire, the same adapter, the same engine',
            '',
        );
    }

    heading('C1 (d) — SILENCE: the complete event spine');
    {
        const spine = run.events.map((e) => e.type);
        checkSeq('every event type emitted, in order', spine, [
            'start',
            'progress',
            'result',
            'done',
        ]);
        const phases = run.events
            .filter((e) => e.type === 'progress')
            .map((e) => (e as { phase?: string }).phase);
        checkSeq('progress phases', phases, ['request']);
        checkSeq('drift findings', run.findings, []);
        check(
            'events of type "drift"',
            run.events.filter((e) => e.type === 'drift').length,
            0,
        );
        check(
            'events of type "error"',
            run.events.filter((e) => e.type === 'error').length,
            0,
        );
        // The engine's teaching channel — `info` events are how it says "you asked for upload
        // progress on a transport that cannot do it". Nothing here reaches for it.
        check(
            'events of type "info"',
            run.events.filter((e) => e.type === 'info').length,
            0,
        );
    }

    heading('C1 (e) — SILENCE: does any event carry the sent digits at all?');
    {
        // A weaker question than "was there a warning": is the information even PRESENT anywhere on
        // the spine, for a user who went looking? Run a payload with ONE field — no `snowflake_str`
        // to confound the search — and grep every serialised event for the digits that were sent.
        const solo = await plainCall(`{"id":${SNOWFLAKE}}`);
        const dump = solo.events
            .map((e) => {
                try {
                    return JSON.stringify(e);
                } catch {
                    return String(e);
                }
            })
            .join('\n');
        check(
            'the SENT digits 1234567890123456789 appear anywhere on the event spine',
            dump.includes(SNOWFLAKE),
            false,
        );
        note(
            'the `result` event, serialised',
            dump.split('\n').find((l) => l.includes('"result"')) ?? '<none>',
        );
        note(
            'so the spine is not merely quiet about the change — it does not contain the information needed to notice one',
            '',
        );
    }

    heading(
        'C1 (e2) — a third digit string: what the corrupted value RE-SERIALISES to',
    );
    {
        // Worth its own row because it is the shape a user will actually see in a log. There are
        // THREE distinct digit strings in play, and only the first is the vendor's.
        const got = run.data['snowflake'];
        note('1. the digits the vendor sent', SNOWFLAKE);
        note('2. the exact integer the double holds (via BigInt)', digits(got));
        note(
            '3. what JSON.stringify prints for that double',
            JSON.stringify(got),
        );
        check(
            'how many DISTINCT digit strings for one id',
            new Set([SNOWFLAKE, digits(got), JSON.stringify(got)]).size,
            3,
        );
        note(
            '→ echoing the id back to the vendor sends the THIRD of these, not the second. `JSON.stringify` picks the SHORTEST decimal that round-trips to the same double, which is neither the sent value nor the stored one',
            '',
        );
    }

    heading('C1 (f) — SILENCE: what `.report()` shows');
    {
        const call = stitch({
            name: 'getThing',
            baseUrl: BASE,
            path: '/v1/things/1',
            adapter: wireAdapter(WIRE_TEXT),
        });
        const rep = await call.report();
        checkSeq('report.findings', rep.findings, []);
        check('report.error', rep.error, null);
        check('report.status', rep.status, 200);
        check('report.attempts', rep.attempts, 1);
        check('report.source', rep.source, 'live');
        check('report.cache', rep.cache, 'disabled');
        checkSeq(
            'every enumerable key on the report',
            Object.keys(rep).sort(),
            [
                'attempts',
                'cache',
                'config',
                'data',
                'error',
                'findings',
                'source',
                'status',
                'timing',
            ],
        );
        checkDigits(
            'and report.raw — the pre-validation body — holds the CORRUPTED digits',
            (rep.raw as Record<string, unknown>)['snowflake'],
            '1234567890123456768',
        );
        note(
            "`.report()` is the library's widest diagnostic surface: nine keys, zero findings, and its `raw` is the parsed object",
            '',
        );
    }

    finish(
        'C1',
        'CONFIRMED, AND SILENT — with one REFINEMENT to the capture. The library\'s real default transport (`fetchAdapter`, fed a fake `fetch` so `http-adapter.ts:135` runs verbatim) turned 1234567890123456789 into 1234567890123456768 (a drift of 21), 9007199254740993 into 9007199254740992, and 9223372036854775807 into 9223372036854775808. Both controls survived exactly — 9007199254740991 and 4242 — and the SAME snowflake sent as a string in the same body arrived byte-perfect, which localises the fault to the JSON number type rather than to JavaScript. THE REFINEMENT: the money rows did NOT corrupt on the wire. 19.99 round-trips to the token "19.99" because the nearest double\'s shortest form IS "19.99"; the value is still inexact (19.98999999999999843681, and 19.99*100 is not an integer) and 0.1+0.2 is still 0.30000000000000004, so decimals fail in ARITHMETIC, not in TRANSPORT. Only integers above 2^53 are a wire-fidelity bug. Silence is confirmed in the strong sense: the whole spine is start / progress(request) / result / done — FOUR events, zero drift, zero error, zero info — and the digits 1234567890123456789 appear nowhere in it, so nothing downstream is withholding a warning it could have given. `.report()` adds nine enumerable keys and no findings. And there are three distinct digit strings for one id: sent 1234567890123456789, stored 1234567890123456768, re-serialised 1234567890123456800',
    );
}

void main();
