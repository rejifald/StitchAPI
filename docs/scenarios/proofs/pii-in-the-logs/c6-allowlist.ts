// C6 — is an ALLOWLIST expressible? Does an `output` schema that strips unknown keys keep them out
// of the trace, the log and the cache?
//
// Scenario 20 measured that `output` DOES use its parsed value (unlike `input`, which discards it —
// issue #648). So a stripping schema should genuinely filter, and it does: with a four-field Zod
// object declared as `output`, the JSONL sink, the console line, the `result` event, the cache
// entry and `.inspect().data` all go from 7 sentinels to 0, at every depth and inside array
// elements, with no field names enumerated anywhere.
//
// And then there is the residue, which is the part worth writing down. An allowlist that filters
// five destinations leaves two carrying the full record — `.inspect().raw`, by design, and
// `StitchError.body` on any non-2xx, because validation never runs on a failure. The second one is
// not a design decision anybody made; it is where the two mechanisms simply do not meet.
//
//   pnpm exec tsx docs/scenarios/proofs/pii-in-the-logs/c6-allowlist.ts
import { drift, stitch } from '../../../../packages/core/src/index';
import type { StitchConfig } from '../../../../packages/core/src/types';
import {
    BASE,
    SENTINELS,
    bytesOf,
    canary,
    captureStderr,
    collectingSink,
    fakeVendor,
    recordingStore,
    tempFileSink,
} from './canary';
import {
    check,
    checkSeq,
    finish,
    heading,
    leakRow,
    note,
    printLeakTable,
    scan,
} from './harness';
import { z } from './zod';

// The allowlist. Four fields, declared positively — nothing about `email`/`ssn`/`mail` appears
// anywhere in it, which is the whole difference from C3's denylist.
const SAFE = z.object({
    id: z.string(),
    plan: z.string(),
    profile: z.object({ locale: z.string() }),
    contacts: z.array(z.object({ label: z.string() })),
});

async function battery(extra: Partial<StitchConfig>, status = 200) {
    const hits = new Map<string, number>();
    const base = {
        name: 'getCustomer',
        baseUrl: BASE,
        path: '/v1/customers/1',
        cache: { ttl: '60s' },
        ...extra,
    } as StitchConfig;

    const t = tempFileSink();
    const store = recordingStore();
    const a = stitch({
        ...base,
        adapter: fakeVendor({ status }),
        trace: t.sink,
        store,
    });
    await a.safe();
    hits.set('fileSink (JSONL)', scan(t.text(), SENTINELS).size);
    hits.set('cache entry', scan(store.text(), SENTINELS).size);
    t.cleanup();

    const sink = collectingSink();
    const b = stitch({
        ...base,
        adapter: fakeVendor({ status }),
        trace: sink,
        store: recordingStore(),
    });
    await b.safe();
    hits.set('raw event spine', scan(sink.text(), SENTINELS).size);

    const cap = captureStderr();
    try {
        const c = stitch({
            ...base,
            adapter: fakeVendor({ status }),
            trace: 'console',
            store: recordingStore(),
        });
        await c.safe();
    } finally {
        cap.restore();
    }
    hits.set('consoleSink', scan(cap.text(), SENTINELS).size);

    const d = stitch({
        ...base,
        adapter: fakeVendor({ status }),
        store: recordingStore(),
    });
    const w = await d.inspect();
    hits.set('.inspect().data', scan(bytesOf(w.data), SENTINELS).size);
    hits.set('.inspect().raw', scan(bytesOf(w.raw), SENTINELS).size);
    hits.set('.inspect() wrapper', scan(bytesOf(w), SENTINELS).size);
    const out = await d.safe();
    hits.set(
        'StitchError.body',
        scan(bytesOf(out.error?.body), SENTINELS).size,
    );
    return hits;
}

function printBattery(
    label: string,
    m: Map<string, number>,
    baseline?: Map<string, number>,
): void {
    const w = Math.max(...[...m.keys()].map((k) => k.length));
    console.log(`\n  ${label}`);
    for (const [k, v] of m) {
        const b = baseline?.get(k);
        const delta =
            b === undefined ? '' : b === v ? '   (unchanged)' : `   was ${b}`;
        console.log(`    ${k.padEnd(w)}  ${String(v).padStart(2)}${delta}`);
    }
}

async function main(): Promise<void> {
    heading(
        'C6 (a) — the schema really does strip (the premise, checked directly)',
    );
    {
        const parsed = SAFE.parse(canary());
        checkSeq(
            'the parsed value keeps only the declared keys',
            Object.keys(parsed).sort(),
            ['contacts', 'id', 'plan', 'profile'],
        );
        check(
            'nested: `profile.contact` is gone',
            'contact' in (parsed.profile as object),
            false,
        );
        check(
            'array elements: `contacts[1].email` is gone',
            'email' in ((parsed.contacts as object[])[1] ?? {}),
            false,
        );
        check(
            'and nothing in the parsed value matches any sentinel',
            scan(bytesOf(parsed), SENTINELS).size,
            0,
        );
    }

    heading('C6 (b) — the battery, without and with the `output` allowlist');
    const baseline = await battery({});
    printBattery('no output schema', baseline);
    const allow = await battery({ output: SAFE });
    printBattery('output: SAFE (strips unknown keys)', allow, baseline);
    {
        check(
            'fileSink: 7 → 0 — the log is clean',
            allow.get('fileSink (JSONL)'),
            0,
        );
        check('cache entry: 7 → 0', allow.get('cache entry'), 0);
        check('raw event spine: 7 → 0', allow.get('raw event spine'), 0);
        check('.inspect().data: 7 → 0', allow.get('.inspect().data'), 0);
        check(
            '.inspect() wrapper: 7 → 0 (`data` was the enumerable leak in C1(e))',
            allow.get('.inspect() wrapper'),
            0,
        );
        check(
            'but `.inspect().raw` is UNCHANGED at 7 — validation runs after `raw` is captured',
            allow.get('.inspect().raw'),
            7,
        );
        note(
            '→ scenario 20 confirmed on the output side: the engine serves `value = validated` (engine.ts:1223), so a stripping schema is a real filter and not merely a check. The `input` side discards its parsed value (issue #648); the `output` side does not',
        );
    }

    heading('C6 (c) — the residue: the failure path');
    {
        const failing = await battery({ output: SAFE }, 500);
        printBattery('output: SAFE, vendor returns 500', failing);
        check(
            '`StitchError.body` still holds all 7 on a 500',
            failing.get('StitchError.body'),
            7,
        );
        check(
            'and so does the JSONL? No — the sink never sees a body it was not given',
            failing.get('fileSink (JSONL)'),
            0,
        );
        check(
            'and — NOT IN THE CLAIMS — `JSON.stringify(inspection)` is back to 7 on a failure',
            failing.get('.inspect() wrapper'),
            7,
        );
        note(
            '→ the route is the enumerable `error` field: `StitchError` assigns `this.body` in its constructor, so it is an OWN ENUMERABLE property and `JSON.stringify(err)` emits `{"name":"StitchError","status":500,"attempts":1,"body":{…}}`. `err.stack` and `String(err)` are clean (C1(g) measured 0), so the leak is specific to JSON-serialising the error — which is exactly what a structured logger does',
        );
        note(
            '→ the allowlist is airtight on every destination that reads the VALIDATED value and absent on every destination that reads the RESPONSE. Output validation is stage 7; a non-2xx never reaches it. So an `output` allowlist plus an unguarded `catch (e) { log.error(e.body) }` is a complete filter with a hole exactly where an incident actually gets logged',
        );
    }

    heading('C6 (d) — the three unknown-key modes, measured');
    {
        const loose = SAFE.passthrough();
        const strict = SAFE.strict();
        const l = await battery({ output: loose });
        check(
            '`.passthrough()` returns the JSONL to 5 of 7 — not 7',
            l.get('fileSink (JSONL)'),
            5,
        );
        note(
            "→ measured, not assumed: `.passthrough()` is SHALLOW. The two sentinels it does NOT restore are exactly the two that sit inside a nested `z.object` — `profile.contact.mail` and `contacts[1].email` — because the inner objects are still stripping. So Zod's unknown-key mode is per-object, and an allowlist leaks at whatever depth you relaxed it",
        );
        const s = await battery({ output: strict });
        check(
            '`.strict()` FAILS the call instead of filtering — JSONL clean, but…',
            s.get('fileSink (JSONL)'),
            0,
        );
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            output: strict,
        });
        const out = await call.safe();
        check('… the call fails', out.ok, false);
        check(
            "the ERROR message is the engine's, not the schema's",
            out.error?.message,
            'contract violation (drift)',
        );
        const strictProbe = await call.inspect();
        check(
            "the schema's complaint rides the FINDINGS instead",
            strictProbe.findings.some((f) => /ssn/.test(f.detail ?? '')),
            true,
        );
        note(
            'the finding detail',
            strictProbe.findings.find((f) => f.change === 'invalid')?.detail,
        );
        check(
            'and no finding carries a VALUE',
            scan(bytesOf(strictProbe.findings), SENTINELS).size,
            0,
        );
        note(
            "→ NOT IN THE CLAIMS: `.strict()`'s complaint enumerates the undeclared KEY NAMES into a `DriftFinding.detail` that every sink logs — `Unrecognized key(s) in object: 'name', 'email', 'ssn', …`. Names, never values (0 sentinels), but the strictest allowlist is also the one that writes a field inventory of the vendor's response into your log",
        );
        const strictSink = tempFileSink();
        const traced = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            output: strict,
            trace: strictSink.sink,
        });
        await traced.safe();
        check(
            'and the JSONL does log that message, sentinel-free',
            scan(strictSink.text(), SENTINELS).size,
            0,
        );
        check('with the key names in it', /ssn/.test(strictSink.text()), true);
        strictSink.cleanup();
    }

    heading('C6 (e) — the allowlist under `drift()`: filtering AND a signal');
    {
        const spec = drift(SAFE, { severity: 'info' });
        const sink = collectingSink();
        const t = tempFileSink();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            output: spec,
            trace: t.sink,
        });
        const w = await call.inspect();
        check('`data` is filtered', scan(bytesOf(w.data), SENTINELS).size, 0);
        check(
            'and every stripped field is reported as an `undeclared` finding',
            w.findings.filter((f) => f.change === 'undeclared').length >= 5,
            true,
        );
        checkSeq(
            'the finding PATHS name the stripped fields',
            w.findings
                .filter((f) => f.change === 'undeclared')
                .map((f) => f.path)
                .sort(),
            [
                'contacts[].email',
                'email',
                'name',
                'note',
                'primaryContactMail',
                'profile.contact',
                'ssn',
            ],
        );
        check(
            'and no finding carries a VALUE — 0 sentinels across every finding',
            scan(bytesOf(w.findings), SENTINELS).size,
            0,
        );
        const traced = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            output: spec,
            trace: sink,
        });
        await traced();
        check(
            'the drift events on the spine are sentinel-free too',
            scan(
                bytesOf(sink.events().filter((e) => e.type === 'drift')),
                SENTINELS,
            ).size,
            0,
        );
        check(
            'and the JSONL that logged all of them is clean',
            scan(t.text(), SENTINELS).size,
            0,
        );
        note(
            '→ this is the combination the capture calls "correct by construction": an allowlist that filters the value AND emits a named, value-free inventory of everything it filtered. `detailFor` (drift.ts:77) emits KINDS only — `undeclared field (string)` — so the diagnostic that tells you a PII field appeared does not itself contain the PII',
        );
        t.cleanup();
    }

    heading('C6 (f) — the leak table under the assembled allowlist');
    {
        const t = tempFileSink();
        const store = recordingStore();
        const cfg = {
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            cache: { ttl: '60s' },
            output: drift(SAFE, { severity: 'info' }),
        } as StitchConfig;
        const a = stitch({
            ...cfg,
            adapter: fakeVendor(),
            trace: t.sink,
            store,
        });
        await a();
        leakRow('fileSink', t.text(), SENTINELS, 'output allowlist only');
        leakRow('cache entry', store.text(), SENTINELS, '');
        const b = stitch({
            ...cfg,
            adapter: fakeVendor(),
            store: recordingStore(),
        });
        const w = await b.inspect();
        leakRow('.inspect() wrapper', bytesOf(w), SENTINELS, '');
        leakRow('.inspect().raw', bytesOf(w.raw), SENTINELS, 'THE RESIDUE');
        leakRow('.inspect().findings', bytesOf(w.findings), SENTINELS, '');
        const c = stitch({
            ...cfg,
            adapter: fakeVendor({ status: 500 }),
            store: recordingStore(),
        });
        const out = await c.safe();
        leakRow(
            'StitchError.body (500)',
            bytesOf(out.error?.body),
            SENTINELS,
            'THE RESIDUE',
        );
        const tally = printLeakTable(SENTINELS);
        check(
            'destinations still leaking under the allowlist',
            tally.leaking,
            2,
        );
        check('destinations the allowlist covers', tally.clean, 4);
        t.cleanup();
    }

    finish(
        'C6',
        "CONFIRMED — an allowlist is expressible, it genuinely filters, and it is the only mechanism in this directory that survives a vendor adding a field. A four-field Zod `output` schema takes the JSONL sink, the `result` event / raw spine, the console line, the cache entry, `.inspect().data` and the whole `.inspect()` wrapper from 7 sentinels to 0, at depth (`profile.contact` gone) and inside array elements (`contacts[].email` gone), with no PII field name written anywhere. This confirms scenario 20 on the output side: the engine serves `value = validated` (engine.ts:1223), so `output` filters where `input` merely checks (issue #648). Wrapped in `drift()` it also emits a value-free inventory of everything it stripped — 7 `undeclared` findings whose paths name the fields and whose details are KINDS only (`undeclared field (string)`), 0 sentinels across every finding and every drift event. The residue is exactly two destinations and both are structural: `.inspect().raw` stays at 7/7 by design (it is captured before validation — it exists to show what the vendor really sent), and `StitchError.body` stays at 7/7 on any non-2xx because output validation is stage 7 and a failure never reaches it. Mode notes: `.passthrough()` returns the JSONL to 5/7 rather than 7/7, because it is SHALLOW — the two sentinels behind a nested `z.object` stay stripped; and `.strict()` fails the call rather than filtering, its message being the engine's `contract violation (drift)` while the schema's complaint rides a `DriftFinding.detail` that enumerates the undeclared KEY NAMES into every sink — names, never values. One finding outside the claims: on the failure path `JSON.stringify(inspection)` goes back to 7/7 through the enumerable `error` field, because `StitchError` assigns `this.body` in its constructor and `JSON.stringify(err)` therefore emits the whole response body (`err.stack` and `String(err)` stay clean)",
    );
}

void main();
