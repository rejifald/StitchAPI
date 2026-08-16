// C5 — can PII be stripped AT THE BOUNDARY, before anything copies it?
//
// Three candidate seams: `hooks.onResponse`, a surface's `interpret`, and `transform`. The capture
// asks which runs earliest and whether a value stripped there stays out of the trace sink AND the
// cache. Both questions are answered by measurement — the ordering by an execution log the three
// seams write to in the order they actually fire, the coverage by re-running the C1 battery with
// each seam installed.
//
// The result has a shape the capture does not anticipate: the three seams are NOT interchangeable
// with different ergonomics. They cover DIFFERENT SETS of destinations, and only one of them —
// `hooks.onResponse` — covers the failure path, because on a non-2xx neither `interpret`'s return
// value nor `transform` is ever consulted: the engine throws carrying the untouched `res`.
//
//   pnpm exec tsx docs/scenarios/proofs/pii-in-the-logs/c5-boundary.ts
import { stitch, verdictOf } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import type {
    AdapterResponse,
    ResolvedStitchConfig,
    StitchConfig,
} from '../../../../packages/core/src/types';
import {
    BASE,
    SENTINELS,
    bytesOf,
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

/** The strip every seam applies: keep the two operational fields, drop everything else. */
function safeShape(body: unknown): unknown {
    const b = (body ?? {}) as Record<string, unknown>;
    return { id: b['id'], plan: b['plan'] };
}

/** A surface whose `interpret` returns the stripped body as the value. */
const strippingSurface: Surface = {
    id: 'stripping',
    interpret: (res: AdapterResponse, cfg: ResolvedStitchConfig) =>
        verdictOf(res, cfg) ?? { ok: true, data: safeShape(res.body) },
};

/** Run the destination battery for one config and report sentinel counts per destination. */
async function battery(
    extra: Partial<StitchConfig>,
    opts: { status?: number } = {},
): Promise<Map<string, number>> {
    const hits = new Map<string, number>();
    const t = tempFileSink();
    const sink = collectingSink();
    const store = recordingStore();
    const base = {
        name: 'getCustomer',
        baseUrl: BASE,
        path: '/v1/customers/1',
        cache: { ttl: '60s' },
        ...extra,
    } as StitchConfig;

    const traced = stitch({
        ...base,
        adapter: fakeVendor({ status: opts.status ?? 200 }),
        trace: t.sink,
        store,
    });
    await traced.safe();
    hits.set('fileSink (JSONL)', scan(t.text(), SENTINELS).size);
    hits.set('cache entry', scan(store.text(), SENTINELS).size);
    t.cleanup();

    const spined = stitch({
        ...base,
        adapter: fakeVendor({ status: opts.status ?? 200 }),
        trace: sink,
        store: recordingStore(),
    });
    await spined.safe();
    hits.set('raw event spine', scan(sink.text(), SENTINELS).size);

    const probed = stitch({
        ...base,
        adapter: fakeVendor({ status: opts.status ?? 200 }),
        store: recordingStore(),
    });
    const w = await probed.inspect();
    hits.set('.inspect().raw', scan(bytesOf(w.raw), SENTINELS).size);
    hits.set('.inspect().data', scan(bytesOf(w.data), SENTINELS).size);

    const failing = stitch({
        ...base,
        adapter: fakeVendor({ status: opts.status ?? 200 }),
        store: recordingStore(),
    });
    const out = await failing.safe();
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
    heading('C5 (a) — the ORDER the three seams actually fire in');
    {
        const order: string[] = [];
        const call = stitch({
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            adapter: fakeVendor(),
            kind: {
                id: 'ordered',
                interpret: (res, cfg) => {
                    order.push('interpret');
                    return verdictOf(res, cfg) ?? { ok: true, data: res.body };
                },
            },
            hooks: {
                onRequest: () => void order.push('hooks.onRequest'),
                onResponse: () => void order.push('hooks.onResponse'),
            },
            transform: (b) => {
                order.push('transform');
                return b;
            },
            output: {
                '~standard': {
                    version: 1,
                    vendor: 'proof',
                    validate: (v: unknown) => {
                        order.push('output.validate');
                        return { value: v };
                    },
                },
            } as never,
        });
        await call();
        checkSeq('measured seam order', order, [
            'hooks.onRequest',
            'hooks.onResponse',
            'interpret',
            'transform',
            'output.validate',
        ]);
        note(
            '→ `hooks.onResponse` is the EARLIEST seam that sees a response body: engine.ts:705, immediately after the transport returns and before the surface is asked what the response means (engine.ts:775). `transform` is third, output validation last',
        );
    }

    heading('C5 (b) — the baseline: no seam installed');
    const baseline = await battery({});
    printBattery('no stripping', baseline);
    check(
        'baseline: the JSONL holds all 7',
        baseline.get('fileSink (JSONL)'),
        7,
    );

    heading('C5 (c) — `hooks.onResponse` mutating `res.body`');
    {
        const withHook = await battery({
            hooks: {
                onResponse: ({ res }) => {
                    if (res) res.body = safeShape(res.body);
                },
            },
        });
        printBattery('hooks.onResponse', withHook, baseline);
        check('JSONL: clean', withHook.get('fileSink (JSONL)'), 0);
        check('cache: clean', withHook.get('cache entry'), 0);
        check('raw event spine: clean', withHook.get('raw event spine'), 0);
        check('.inspect().raw: clean', withHook.get('.inspect().raw'), 0);
        check('.inspect().data: clean', withHook.get('.inspect().data'), 0);
        note(
            'the hook is typed `(ctx) => void | Promise<void>`, so this works by MUTATING `ctx.res.body` in place — the engine passes the live `AdapterResponse` and keeps using it. There is no return-a-new-body form',
        );
    }

    heading('C5 (d) — a surface `interpret` that returns the stripped value');
    {
        const withSurface = await battery({ kind: strippingSurface });
        printBattery('kind: strippingSurface', withSurface, baseline);
        check('JSONL: clean', withSurface.get('fileSink (JSONL)'), 0);
        check('cache: clean', withSurface.get('cache entry'), 0);
        check('.inspect().raw: clean', withSurface.get('.inspect().raw'), 0);
    }

    heading('C5 (e) — `transform`');
    {
        const withTransform = await battery({ transform: safeShape });
        printBattery('transform', withTransform, baseline);
        check('JSONL: clean', withTransform.get('fileSink (JSONL)'), 0);
        check('cache: clean', withTransform.get('cache entry'), 0);
        check(
            '.inspect().raw: ALSO clean — `raw` is captured AFTER transform',
            withTransform.get('.inspect().raw'),
            0,
        );
        note(
            '→ worth pinning: `.inspect().raw` is documented as "the pre-validation body", and pre-validation is exactly what it is — engine.ts:1202 takes `rawBody = value` after `transform` and `pick` have already run. So `transform` covers `raw`, but a drift diff computed against it can no longer see what the vendor really sent',
        );
    }

    heading(
        'C5 (f) — the failure path, where the three seams STOP being equivalent',
    );
    {
        const failBaseline = await battery({}, { status: 500 });
        check(
            'baseline 500: `StitchError.body` holds all 7',
            failBaseline.get('StitchError.body'),
            7,
        );
        const failTransform = await battery(
            { transform: safeShape },
            { status: 500 },
        );
        check(
            '`transform` does NOT protect it — the transform never runs on a 500',
            failTransform.get('StitchError.body'),
            7,
        );
        const failSurface = await battery(
            { kind: strippingSurface },
            { status: 500 },
        );
        check(
            'a stripping `interpret` does not either — its value is discarded, the raw `res` is thrown',
            failSurface.get('StitchError.body'),
            7,
        );
        const failHook = await battery(
            {
                hooks: {
                    onResponse: ({ res }) => {
                        if (res) res.body = safeShape(res.body);
                    },
                },
            },
            { status: 500 },
        );
        check(
            '`hooks.onResponse` DOES — it mutated the object the engine later attaches',
            failHook.get('StitchError.body'),
            0,
        );
        note(
            "→ the decisive C5 result. On a non-2xx the engine builds `e.response = res` from the untouched adapter response (engine.ts:824-831); `transform`/`pick`/output validation are never reached and `interpret`'s success value is discarded. Only a seam that MUTATED `res` in place is still in effect. That makes `hooks.onResponse` the only one of the three that is a boundary in the sense the scenario means",
        );
    }

    heading('C5 (g) — the leak table for the winning seam');
    {
        const t = tempFileSink();
        const store = recordingStore();
        const sink = collectingSink();
        const cfg = {
            name: 'getCustomer',
            baseUrl: BASE,
            path: '/v1/customers/1',
            cache: { ttl: '60s' },
            hooks: {
                onResponse: ({ res }: { res?: AdapterResponse }) => {
                    if (res) res.body = safeShape(res.body);
                },
            },
        } as StitchConfig;
        const a = stitch({
            ...cfg,
            adapter: fakeVendor(),
            trace: t.sink,
            store,
        });
        await a();
        leakRow('fileSink', t.text(), SENTINELS, 'with onResponse installed');
        leakRow('cache entry', store.text(), SENTINELS, '');
        const b = stitch({
            ...cfg,
            adapter: fakeVendor(),
            trace: sink,
            store: recordingStore(),
        });
        await b();
        leakRow('raw event spine', sink.text(), SENTINELS, '');
        const c = stitch({
            ...cfg,
            adapter: fakeVendor(),
            store: recordingStore(),
        });
        const w = await c.inspect();
        leakRow('.inspect() wrapper', bytesOf(w), SENTINELS, '');
        leakRow('.inspect().raw', bytesOf(w.raw), SENTINELS, '');
        const r = await c.report();
        leakRow('.report()', bytesOf(r), SENTINELS, '');
        const d = stitch({
            ...cfg,
            adapter: fakeVendor({ status: 500 }),
            store: recordingStore(),
        });
        const out = await d.safe();
        leakRow('StitchError.body', bytesOf(out.error?.body), SENTINELS, '');
        // The one place it CANNOT reach: the transport itself already saw the bytes.
        const vendor = fakeVendor();
        const e = stitch({ ...cfg, adapter: vendor, store: recordingStore() });
        await e();
        leakRow(
            'the Adapter (upstream of every seam)',
            bytesOf(vendor.seen()),
            SENTINELS,
            'the request only — the response never passes back through it',
        );
        const tally = printLeakTable(SENTINELS);
        check(
            'every destination is clean with one 3-line hook',
            tally.leaking,
            0,
        );
        t.cleanup();
    }

    finish(
        'C5',
        'CONFIRMED, with an ordering result that changes the answer. Measured seam order on a live call: hooks.onRequest → hooks.onResponse → interpret → transform → output.validate. `hooks.onResponse` (engine.ts:705) is the EARLIEST seam that can see a response body — it fires immediately after the transport returns and before the surface is asked to interpret. On the SUCCESS path all three candidate seams work and are equivalent: each one takes the JSONL sink, the cache entry, the raw event spine, `.inspect().raw` and `.inspect().data` from 7 sentinels to 0. On the FAILURE path they are not: a 500 leaves `StitchError.body` at 7/7 under `transform` and at 7/7 under a stripping `interpret`, because the engine throws carrying the untouched `res` (engine.ts:824-831) — `transform` is never reached and `interpret`\'s success value is discarded. Only `hooks.onResponse` still holds, at 0/7, because it MUTATED the response object the error later carries. So there is exactly one seam that is a boundary in the sense this scenario means, it is three lines, and its type is `(ctx) => void` — you strip by mutating `ctx.res.body` in place, which is nowhere described as a privacy mechanism. Two side measurements: `.inspect().raw` is captured AFTER transform/pick (engine.ts:1202), so "pre-validation body" is literal and a transform-based strip also blinds the drift diff; and no seam reaches the Adapter, which necessarily saw the bytes first',
    );
}

void main();
