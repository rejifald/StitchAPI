// C8 — assemble the best available "no customer data reaches a log" setup, count the lines, name
// the seams, and state what it costs.
//
// Three variants are built and measured, because the measurements in C5 and C6 turn out to be in
// tension and the tension is the finding:
//
//   A  the ALLOWLIST alone     — `output: drift(SAFE)`. Every destination that reads the validated
//                                value goes clean, and the "vendor added a field" signal survives.
//                                Two destinations do not: `.inspect().raw`, and `StitchError.body`
//                                on any non-2xx.
//   B  the BOUNDARY alone      — `hooks.onResponse` mutating `res.body`. EVERY destination goes
//                                clean, including the two A leaves. And the drift signal goes to
//                                zero, because drift diffs the body against the schema and the
//                                boundary removed the body before the schema ever saw it.
//   C  BOTH, plus a hand-rolled key inventory — clean everywhere AND a names-only signal, at the
//                                cost of writing the walker `drift.ts` already contains.
//
// The line counts are read off THIS FILE at runtime, between the `>>> BEGIN USER CODE` markers, so
// they are the real number rather than an estimate.
//
//   pnpm exec tsx docs/scenarios/proofs/pii-in-the-logs/c8-assembled.ts
import { drift, stitch } from '../../../../packages/core/src/index';
import type {
    AdapterResponse,
    DriftFinding,
    StitchConfig,
} from '../../../../packages/core/src/types';
import {
    BASE,
    SENTINELS,
    bytesOf,
    canary,
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
    finish,
    heading,
    leakRow,
    note,
    printLeakTable,
    resetLeakTable,
    scan,
} from './harness';
import { z } from './zod';

import { readFileSync } from 'node:fs';

// ===========================================================================
// >>> BEGIN USER CODE — variant A: the allowlist
// ===========================================================================
const SAFE = z.object({
    id: z.string(),
    plan: z.string(),
    profile: z.object({ locale: z.string() }),
    contacts: z.array(z.object({ label: z.string() })),
});

const variantA = {
    output: drift(SAFE, { severity: ['info', 'warn'] }),
} satisfies Partial<StitchConfig>;
// ===========================================================================
// <<< END USER CODE — variant A
// ===========================================================================

// ===========================================================================
// >>> BEGIN USER CODE — variant B: the boundary
// ===========================================================================
const variantB = {
    hooks: {
        onResponse: ({ res }: { res?: AdapterResponse }) => {
            if (res) res.body = SAFE.safeParse(res.body).data ?? null;
        },
    },
} satisfies Partial<StitchConfig>;
// ===========================================================================
// <<< END USER CODE — variant B
// ===========================================================================

// ===========================================================================
// >>> BEGIN USER CODE — variant C: the boundary that reports before it strips
// ===========================================================================
/** Every key path in `body` that the allowlist does not declare. Names only — never a value. */
function undeclared(body: unknown, allow: unknown, at = ''): string[] {
    if (Array.isArray(body))
        return Array.isArray(allow) && allow.length > 0
            ? [
                  ...new Set(
                      body.flatMap((v) => undeclared(v, allow[0], `${at}[]`)),
                  ),
              ]
            : [];
    if (
        !body ||
        typeof body !== 'object' ||
        !allow ||
        typeof allow !== 'object'
    )
        return [];
    const shape = allow as Record<string, unknown>;
    return Object.entries(body as Record<string, unknown>).flatMap(([k, v]) => {
        const path = at ? `${at}.${k}` : k;
        if (!(k in shape)) return [path];
        return undeclared(v, shape[k], path);
    });
}

/** The allowlist as plain data, so it can drive both the strip and the inventory. */
const SHAPE = {
    id: 1,
    plan: 1,
    profile: { locale: 1 },
    contacts: [{ label: 1 }],
};

const seen = new Set<string>();

const variantC = {
    output: drift(SAFE, { severity: ['info', 'warn'] }),
    hooks: {
        onResponse: ({ res }: { res?: AdapterResponse }) => {
            if (!res) return;
            for (const p of undeclared(res.body, SHAPE)) seen.add(p);
            res.body = SAFE.safeParse(res.body).data ?? null;
        },
    },
} satisfies Partial<StitchConfig>;
// ===========================================================================
// <<< END USER CODE — variant C
// ===========================================================================

/**
 * Executable (non-blank, non-comment) lines between a BEGIN/END marker pair in this file.
 *
 * Counted at runtime off the file on disk, so the number in the verdict is the real one — and the
 * one this repository's Prettier config produces, which is the honest unit for "what would this
 * cost me in my codebase" rather than a hand-minified best case.
 */
function userLines(variant: string): number {
    const src = readFileSync(process.argv[1] ?? '', 'utf8').split('\n');
    const start = src.findIndex((l) =>
        l.includes(`>>> BEGIN USER CODE — variant ${variant}`),
    );
    const end = src.findIndex((l) =>
        l.includes(`<<< END USER CODE — variant ${variant}`),
    );
    if (start < 0 || end < 0) return -1;
    return src
        .slice(start + 2, end - 1)
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('//') && !l.startsWith('*'))
        .length;
}

/** Run every C1 destination against one config and return the sentinel count per destination. */
async function battery(
    extra: Partial<StitchConfig>,
    status = 200,
): Promise<Map<string, number>> {
    const hits = new Map<string, number>();
    const base = {
        name: 'getCustomer',
        baseUrl: BASE,
        path: '/v1/customers/1',
        cache: { ttl: '60s' },
        ...extra,
    } as StitchConfig;
    const mk = (over: Partial<StitchConfig>) =>
        stitch({
            ...base,
            adapter: fakeVendor({ status }),
            store: recordingStore(),
            ...over,
        } as StitchConfig);

    const t = tempFileSink();
    const store = recordingStore();
    await mk({ trace: t.sink, store }).safe();
    hits.set('fileSink (JSONL)', scan(t.text(), SENTINELS).size);
    hits.set('cache entry', scan(store.text(), SENTINELS).size);
    t.cleanup();

    const spine = collectingSink();
    await mk({ trace: spine }).safe();
    hits.set('raw event spine', scan(spine.text(), SENTINELS).size);

    const cap = captureStderr();
    try {
        await mk({ trace: 'console' }).safe();
    } finally {
        cap.restore();
    }
    hits.set('consoleSink', scan(cap.text(), SENTINELS).size);

    const logger = captureLogger();
    const { loggerSink } = await import('../../../../packages/core/src/trace');
    await mk({ trace: loggerSink(logger) }).safe();
    hits.set('loggerSink', scan(logger.text(), SENTINELS).size);

    const probe = mk({});
    const w = await probe.inspect();
    hits.set('.inspect().raw', scan(bytesOf(w.raw), SENTINELS).size);
    hits.set('.inspect() wrapper', scan(bytesOf(w), SENTINELS).size);
    hits.set('.report()', scan(bytesOf(await probe.report()), SENTINELS).size);
    const out = await probe.safe();
    hits.set(
        'StitchError.body',
        scan(bytesOf(out.error?.body), SENTINELS).size,
    );
    hits.set(
        'JSON.stringify(error)',
        scan(bytesOf(out.error ?? null), SENTINELS).size,
    );
    return hits;
}

async function findingsFor(
    extra: Partial<StitchConfig>,
): Promise<DriftFinding[]> {
    const call = stitch({
        name: 'getCustomer',
        baseUrl: BASE,
        path: '/v1/customers/1',
        adapter: fakeVendor(),
        ...extra,
    } as StitchConfig);
    return (await call.inspect()).findings;
}

function printBattery(label: string, m: Map<string, number>): number {
    const w = Math.max(...[...m.keys()].map((k) => k.length));
    console.log(`\n  ${label}`);
    let leaking = 0;
    for (const [k, v] of m) {
        if (v > 0) leaking++;
        console.log(
            `    ${k.padEnd(w)}  ${String(v).padStart(2)}${v > 0 ? '   LEAKS' : ''}`,
        );
    }
    return leaking;
}

async function main(): Promise<void> {
    heading(
        'C8 (a) — the baseline: a well-instrumented stitch with no protection',
    );
    const bare200 = await battery({});
    const bare500 = await battery({}, 500);
    {
        const leak200 = printBattery('nothing configured, 200', bare200);
        const leak500 = printBattery('nothing configured, 500', bare500);
        check('destinations measured per run', bare200.size, 10);
        check('destinations leaking on a 200', leak200, 6);
        check('destinations leaking on a 500', leak500, 4);
    }

    heading('C8 (b) — variant A: the allowlist alone');
    {
        const a200 = await battery(variantA);
        const a500 = await battery(variantA, 500);
        const leak200 = printBattery('output: drift(SAFE), 200', a200);
        const leak500 = printBattery('output: drift(SAFE), 500', a500);
        check('user-code lines', userLines('A'), 9);
        check('destinations still leaking on a 200', leak200, 1);
        check('and it is `.inspect().raw`', a200.get('.inspect().raw'), 7);
        check('destinations still leaking on a 500', leak500, 4);
        check(
            'the drift signal SURVIVES — undeclared findings',
            (await findingsFor(variantA)).filter(
                (f) => f.change === 'undeclared',
            ).length,
            7,
        );
    }

    heading('C8 (c) — variant B: the boundary alone');
    {
        const b200 = await battery(variantB);
        const b500 = await battery(variantB, 500);
        const leak200 = printBattery('hooks.onResponse, 200', b200);
        const leak500 = printBattery('hooks.onResponse, 500', b500);
        check('user-code lines', userLines('B'), 7);
        check('destinations leaking on a 200', leak200, 0);
        check('destinations leaking on a 500', leak500, 0);
        check(
            'but the drift signal is GONE — 0 findings',
            (await findingsFor(variantB)).length,
            0,
        );
        note(
            '→ the tension, measured. Drift diffs the response body against the validated value; the boundary removed the body before the schema ever saw it, so there is nothing left to diff. You cannot have the earliest boundary AND the built-in "a new field appeared" signal, because the signal is computed from exactly the bytes the boundary removes',
        );
    }

    heading(
        'C8 (d) — variant C: strip at the boundary, report the names first',
    );
    {
        seen.clear();
        const c200 = await battery(variantC);
        const c500 = await battery(variantC, 500);
        const leak200 = printBattery(
            'onResponse + output allowlist, 200',
            c200,
        );
        const leak500 = printBattery(
            'onResponse + output allowlist, 500',
            c500,
        );
        check('user-code lines', userLines('C'), 42);
        check('destinations leaking on a 200', leak200, 0);
        check('destinations leaking on a 500', leak500, 0);
        checkSeq(
            'and the undeclared inventory the hook recorded, names only',
            [...seen].sort(),
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
            'the inventory carries no value',
            scan(bytesOf([...seen]), SENTINELS).size,
            0,
        );
        check(
            'and it catches a NEW field the day it appears',
            (() => {
                seen.clear();
                return undeclared({ ...canary(), taxId: 'x' }, SHAPE).includes(
                    'taxId',
                );
            })(),
            true,
        );
    }

    heading('C8 (e) — the final table: variant C, every destination');
    {
        resetLeakTable();
        const cfg = {
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            cache: { ttl: '60s' },
            ...variantC,
        } as StitchConfig;
        const t = tempFileSink();
        const store = recordingStore();
        await stitch({
            ...cfg,
            adapter: fakeVendor(),
            trace: t.sink,
            store,
        })();
        leakRow(
            'fileSink (JSONL)',
            t.text(),
            SENTINELS,
            'default 2048-char cap',
        );
        leakRow('cache entry', store.text(), SENTINELS, '');
        t.cleanup();

        const spine = collectingSink();
        await stitch({
            ...cfg,
            adapter: fakeVendor(),
            trace: spine,
            store: recordingStore(),
        })();
        leakRow(
            'raw event spine',
            spine.text(),
            SENTINELS,
            'a naive custom sink',
        );

        const cap = captureStderr();
        try {
            await stitch({
                ...cfg,
                adapter: fakeVendor(),
                trace: 'console',
                store: recordingStore(),
            })();
        } finally {
            cap.restore();
        }
        leakRow('consoleSink', cap.text(), SENTINELS, '');

        const probe = stitch({
            ...cfg,
            adapter: fakeVendor(),
            store: recordingStore(),
        });
        const w = await probe.inspect();
        leakRow('.inspect().raw', bytesOf(w.raw), SENTINELS, '');
        leakRow('.inspect() wrapper', bytesOf(w), SENTINELS, '');
        leakRow('.report()', bytesOf(await probe.report()), SENTINELS, '');

        const failing = stitch({
            ...cfg,
            adapter: fakeVendor({ status: 500 }),
            store: recordingStore(),
        });
        const out = await failing.safe();
        leakRow('StitchError.body', bytesOf(out.error?.body), SENTINELS, '');
        leakRow(
            'JSON.stringify(error)',
            bytesOf(out.error ?? null),
            SENTINELS,
            'what a structured logger writes',
        );
        const tally = printLeakTable(SENTINELS);
        check('destinations still leaking under variant C', tally.leaking, 0);
        check('destinations measured', tally.leaking + tally.clean, 9);
    }

    heading('C8 (f) — what it does NOT buy you');
    {
        // The one thing no seam can fix: the transport already read the bytes. Anything that
        // logged inside the adapter, or a proxy in front of it, is upstream of every seam here.
        const vendor = fakeVendor();
        let adapterSaw = '';
        const spy = (async (req) => {
            const res = await vendor(req);
            adapterSaw = bytesOf(res.body);
            return res;
        }) as typeof vendor;
        await stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: spy,
            ...variantC,
        } as StitchConfig)();
        check(
            'a wrapper INSIDE the adapter still sees all 7',
            scan(adapterSaw, SENTINELS).size,
            7,
        );
        note(
            "→ `hooks.onResponse` is the earliest seam the LIBRARY offers, not the earliest seam that exists. A custom adapter, an HTTP proxy, a service mesh access log, or the vendor's own logs are all upstream of it. This directory measures the library's boundary; the network's is elsewhere",
        );
    }

    finish(
        'C8',
        'ASSEMBLED and measured. Baseline: a stitch with a trace sink, a cache and a `.report()` leaks the customer record at 6 of 10 destinations on a 200 and 4 of 10 on a 500. Variant A — the allowlist alone, `output: drift(SAFE, …)`, 9 executable lines, one seam (`output`) — takes that to 1 of 10 on a 200 (only `.inspect().raw`, by design) and leaves the 500 path untouched at 4 of 10. Variant B — the boundary alone, `hooks.onResponse` mutating `res.body`, 7 executable lines, one seam — takes BOTH to 0 of 10, including `StitchError.body` and `JSON.stringify(error)`, and costs the entire drift signal: 0 findings, because drift diffs the response against the schema and the boundary removed the response first. Variant C — both plus a 23-line hand-rolled key walker, 42 executable lines, two seams (`hooks.onResponse` + `output`) — is 0 of 9 destinations on both the success and the failure path AND recovers a names-only inventory of every undeclared field (7 paths, 0 sentinels), which is the "log the detection, not the data" shape the scenario\'s own sources recommend. The costs, stated: (1) 42 lines (as this repo\'s Prettier formats them), of which 23 re-implement a walker `drift.ts` already contains and does not export; (2) the allowlist must be written and maintained — the whole response shape, which is the thing that drifts; (3) `res.body = …` inside a `(ctx) => void` hook is nowhere documented as a privacy mechanism, so the correct construction is discoverable only by reading the engine; (4) `.inspect().raw` is deliberately unreachable by any of this on variant A and is only covered in B/C because the body was destroyed before capture — which also means `.inspect()` can no longer answer the question it exists for; and (5) none of it is upstream of the Adapter, which read the bytes first — measured, a spy inside the transport still sees all 7',
    );
}

void main();
