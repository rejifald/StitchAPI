// C2 (DECIDING, PRE-REGISTERED) — does `sensitive: true` affect ANY logging destination?
//
// The capture pre-registers a suspicion from scenario 18: `sensitive` is a CACHE opt-out and
// nothing more. It is also, by a distance, the nearest-looking key in the whole config to "do not
// log this" — its `types.ts` JSDoc calls itself "the honest 'do not persist this response' hatch
// for one-time tokens or compliance-bound data", which reads exactly like a logging control.
//
// This script settles it two ways, and they agree:
//
//   1. A GREP of the shipped source for every read of the identifier, performed at runtime over the
//      real files rather than quoted from memory.
//   2. The whole C1 battery run TWICE — once without `sensitive`, once with — comparing the
//      sentinel hit count at every destination.
//
//   pnpm exec tsx docs/scenarios/proofs/pii-in-the-logs/c2-sensitive.ts
import { stitch } from '../../../../packages/core/src/index';
import { consoleSink, loggerSink } from '../../../../packages/core/src/trace';
import {
    BASE,
    SENTINELS,
    bytesOf,
    captureLogger,
    captureStderr,
    collectingSink,
    fakeVendor,
    recordingStore,
    tempFileSink,
} from './canary';
import {
    check,
    checkSeq,
    checkStr,
    finish,
    heading,
    note,
    scan,
} from './harness';

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'packages', 'core', 'src');

/** Every line in the shipped source mentioning the bare identifier `sensitive`. */
function grepSensitive(): { file: string; line: number; text: string }[] {
    const out: { file: string; line: number; text: string }[] = [];
    for (const f of readdirSync(SRC).filter((n) => n.endsWith('.ts'))) {
        const lines = readFileSync(join(SRC, f), 'utf8').split('\n');
        lines.forEach((text, i) => {
            // The bare word only: `case-insensitive` / `latency-sensitive` are English, not reads.
            if (!/(?<![-\w])sensitive(?![-\w])/.test(text)) return;
            out.push({ file: f, line: i + 1, text: text.trim() });
        });
    }
    return out;
}

/** Is this line a COMMENT, or code that actually reads the slot? */
function isComment(text: string): boolean {
    return (
        text.startsWith('//') ||
        text.startsWith('*') ||
        text.startsWith('/*') ||
        text.startsWith('*/')
    );
}

/** The C1 battery, parameterised on whether the stitch carries `sensitive: true`. */
async function battery(sensitive: boolean): Promise<Map<string, number>> {
    const hits = new Map<string, number>();
    const record = (dest: string, text: string): void => {
        hits.set(dest, scan(text, SENTINELS).size);
    };
    // `sensitive` is documented as "only meaningful alongside a `cache` block", so every run here
    // carries one — otherwise the comparison would be against a slot that was never consulted.
    const base = {
        name: 'getCustomer',
        baseUrl: BASE,
        path: '/v1/customers/1',
        cache: { ttl: '60s' },
        ...(sensitive ? { sensitive: true } : {}),
    } as const;

    {
        const sink = collectingSink();
        const store = recordingStore();
        const call = stitch({
            ...base,
            adapter: fakeVendor(),
            trace: sink,
            store,
        });
        await call();
        record('event:result', bytesOf(sink.of('result')));
        record('event spine (all)', sink.text());
        record('cache entry (store.set)', store.text());
        hits.set('  └ store writes', store.writes().length);
    }
    {
        const t = tempFileSink();
        const call = stitch({
            ...base,
            adapter: fakeVendor(),
            trace: t.sink,
            store: recordingStore(),
        });
        await call();
        record('fileSink (default)', t.text());
        t.cleanup();
    }
    {
        const cap = captureStderr();
        try {
            const call = stitch({
                ...base,
                adapter: fakeVendor(),
                trace: consoleSink(),
                store: recordingStore(),
            });
            await call();
        } finally {
            cap.restore();
        }
        record('consoleSink (stderr)', cap.text());
    }
    {
        const logger = captureLogger();
        const call = stitch({
            ...base,
            adapter: fakeVendor(),
            trace: loggerSink(logger),
            store: recordingStore(),
        });
        await call();
        record('loggerSink', logger.text());
    }
    {
        const call = stitch({
            ...base,
            adapter: fakeVendor(),
            store: recordingStore(),
        });
        const w = await call.inspect();
        record('.inspect().raw', bytesOf(w.raw));
        record('JSON.stringify(inspect())', bytesOf(w));
        const r = await call.report();
        record('JSON.stringify(report())', bytesOf(r));
    }
    {
        const call = stitch({
            ...base,
            adapter: fakeVendor({ status: 500 }),
            store: recordingStore(),
        });
        const out = await call.safe();
        record('StitchError.body', bytesOf(out.error?.body));
        record('StitchError.message', String(out.error?.message ?? ''));
    }
    return hits;
}

async function main(): Promise<void> {
    heading('C2 (a) — every mention of `sensitive` in the shipped source');
    {
        const found = grepSensitive();
        const code = found.filter((f) => !isComment(f.text));
        for (const f of found)
            console.log(
                `  ${isComment(f.text) ? 'comment' : 'CODE   '}  ${f.file}:${f.line}  ${f.text.slice(0, 96)}`,
            );
        check('mentions in total', found.length, 6);
        check('of which are CODE, not prose', code.length, 3);
        // Anchored on file + line CONTENT, never on line numbers: unrelated core edits move the
        // coordinates without changing the fact, and a true claim should not fail on a re-grep.
        // (The grep above prints each site's current line for anyone who wants the coordinate.)
        checkSeq(
            'the three code sites (file and line content)',
            code.map((c) => `${c.file}  ${c.text}`),
            [
                'config-anatomy.ts  sensitive: object;',
                'engine.ts  if (!config || cfg.sensitive) return null;',
                'types.ts  sensitive?: boolean;',
            ],
        );
        note(
            'two of the three are DECLARATIONS, not reads: the `types.ts` line is the `StitchConfig` field, and the `config-anatomy.ts` line is the slot description — `sensitive: object`, i.e. no facts at all, which is why the slot rides onto the public `__config` untouched (no `dropped`, no `stage`, no `policy`). That leaves exactly one site that consults the VALUE',
        );
        const engine = readFileSync(join(SRC, 'engine.ts'), 'utf8').split('\n');
        const read = engine
            .map((t, i) => ({ line: i + 1, text: t.trim() }))
            .filter((l) => l.text.includes('cfg.sensitive'));
        check(
            'reads of the resolved value in the entire engine',
            read.length,
            1,
        );
        checkStr(
            'the one read, verbatim',
            read[0]?.text ?? '',
            'if (!config || cfg.sensitive) return null;',
        );
        // The enclosing function, recovered from the source at runtime rather than pinned by line.
        const enclosing = engine
            .slice(0, (read[0]?.line ?? 1) - 1)
            .map(
                (t) =>
                    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/.exec(t)?.[1],
            )
            .filter((n): n is string => n !== undefined)
            .at(-1);
        checkStr('and the function it gates', enclosing ?? '', 'ensureCache');
        note(
            '→ ONE read, in `ensureCache`. Nothing in `trace.ts`, `otlp.ts`, `stitch.ts` or any sink references the slot at all',
        );
    }

    heading('C2 (b) — the battery, with and without `sensitive: true`');
    {
        const without = await battery(false);
        const withIt = await battery(true);
        const keys = [...without.keys()];
        const w = Math.max(...keys.map((k) => k.length));
        console.log(
            `\n  ${'destination'.padEnd(w)}  sentinels without  sentinels with  changed?\n` +
                `  ${'-'.repeat(w)}  -----------------  --------------  --------`,
        );
        let changed = 0;
        let destinations = 0;
        for (const k of keys) {
            const a = without.get(k) ?? -1;
            const b = withIt.get(k) ?? -1;
            // Rows indented with `└` are counters (store writes), not destinations — excluded from
            // the tally so "1 of 11 destinations changed" counts destinations.
            const isDest = !k.startsWith('  └');
            if (isDest) destinations++;
            if (isDest && a !== b) changed++;
            console.log(
                `  ${k.padEnd(w)}  ${String(a).padStart(17)}  ${String(b).padStart(14)}  ${a === b ? 'no' : 'YES'}`,
            );
        }
        check('destinations measured', destinations, 11);
        check(
            'destinations whose leak changed when `sensitive: true` was set',
            changed,
            1,
        );
        check(
            'and the one that changed is the cache: writes without',
            without.get('  └ store writes'),
            1,
        );
        check('writes with', withIt.get('  └ store writes'), 0);
        check(
            'the cache entry bytes went from 7 sentinels …',
            without.get('cache entry (store.set)'),
            7,
        );
        check('… to 0', withIt.get('cache entry (store.set)'), 0);
        check(
            'the JSONL sink is UNCHANGED — still all 7',
            withIt.get('fileSink (default)'),
            7,
        );
        check(
            'the `result` event is UNCHANGED — still all 7',
            withIt.get('event:result'),
            7,
        );
        check(
            '`.inspect().raw` is UNCHANGED — still all 7',
            withIt.get('.inspect().raw'),
            7,
        );
        check(
            '`StitchError.body` is UNCHANGED — still all 7',
            withIt.get('StitchError.body'),
            7,
        );
    }

    heading('C2 (c) — and it announces itself on the redacted config');
    {
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            cache: { ttl: '60s' },
            sensitive: true,
        });
        const r = await call.report();
        check(
            '`sensitive: true` survives onto the PUBLIC `__config`',
            (r.config as { sensitive?: unknown }).sensitive,
            true,
        );
        note(
            'the redacted config keys',
            Object.keys(r.config).sort().join(','),
        );
        note(
            '→ a small compounding hazard: the slot that does NOT stop logging is itself logged, so a `.report()` line reads `"sensitive":true` beside the customer record it did not protect',
        );
    }

    heading('C2 (d) — the thing it is not: a `sensitive` stitch with no cache');
    {
        const t = tempFileSink();
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            trace: t.sink,
            sensitive: true,
        });
        await call();
        const text = t.text();
        check(
            '`sensitive: true` with no `cache` block: JSONL still holds all 7',
            scan(text, SENTINELS).size,
            7,
        );
        note(
            'so the slot is accepted, changes nothing, and writes the whole record to disk',
        );
        t.cleanup();
    }

    finish(
        'C2',
        'CONFIRMED — the pre-registered suspicion holds exactly, and the measurement is unusually clean. `sensitive: true` changed the leak at 1 of 11 destinations, and that destination is the cache: store writes 1 → 0, cache-entry sentinels 7 → 0. Every other destination is byte-for-byte unaffected: the `result` event 7/7, the JSONL sink 7/7, `.inspect().raw` 7/7, `.report()` 7/7, `StitchError.body` 7/7, consoleSink/loggerSink 0/0 either way. The source agrees: across the whole of `packages/core/src` there are 6 mentions of the identifier, 3 of them code and 2 of THOSE declarations (the `StitchConfig` field in `types.ts`, the slot description in `config-anatomy.ts`) — exactly ONE site reads the value, `if (!config || cfg.sensitive) return null`, inside `ensureCache` (the grep above prints its current line). No sink, no trace module, and no event builder references it. Stated plainly: `sensitive: true` means DO NOT PERSIST THIS TO THE CACHE. It does not mean do not log, do not trace, do not put on an error, or do not write to disk — and the JSONL sink will still write the full body to a file while the slot is set. It also survives onto the public `__config`, so `.report()` prints `"sensitive":true` next to the unredacted record',
    );
}

void main();
