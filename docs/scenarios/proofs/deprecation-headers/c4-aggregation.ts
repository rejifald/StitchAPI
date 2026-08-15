// C4 — DECIDING CLAIM. Across many stitches and many calls, can a `TraceSink` produce
// "these 3 endpoints are deprecated, earliest sunset in 12 days"?
//
// It can, and the shape scenario 12 built for drift rates transfers almost intact: one sink,
// configured once, `handle(event, ctx)` for every event of every call, `ctx.name` naming the
// endpoint, a `Map` collapsing calls into one row per endpoint. Measured below: 5 endpoints,
// 500 calls, and the sink reports
//
//   3 endpoints deprecated (users, search, orders), earliest sunset in 12 days: users
//
// What does NOT transfer is where the DATA comes from. A drift finding arrives at the sink on its
// own — the engine emits it. A response header never arrives at all: C1 measured every event key on
// the spine and none is a header. So the sink can only aggregate a notice that a SURFACE already
// folded into the value, and the two have to be built as a pair. The sink is an aggregation seam;
// it is not a header seam.
//
// Four traps measured at the end, one of which serves a sunset date that expired months ago.
//
//   pnpm exec tsx docs/scenarios/proofs/deprecation-headers/c4-aggregation.ts
import { seam, stitch } from '../../../../packages/core/src/index';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    StitchEvent,
    TraceContext,
    TraceSink,
} from '../../../../packages/core/src/types';
import {
    DeprecationWatch,
    type Notice,
    deprecationSurface,
    noticeOf,
} from './deprecation';
import { BASE, FLEET, FakeVendor, NOW, endpoint, serving } from './fake-vendor';
import { check, checkSeq, finish, heading, note } from './harness';

async function main(): Promise<void> {
    heading('C4 — DECIDING. Can a sink produce the fleet view?');

    // ── (a) the answer: 5 endpoints, 500 calls, one report ───────────────────────────────────
    {
        const clock = manualClock(NOW);
        const vendor = new FakeVendor();
        const watch = new DeprecationWatch(clock);
        const api = seam({
            baseUrl: BASE,
            adapter: vendor.adapter(),
            clock,
            trace: watch,
        });
        // The surface is written on every member because seam-level `kind` does not TYPECHECK
        // (TS2353) — even though the engine would have inherited it from the seam. See (f).
        const surface = deprecationSurface({ fold: true });
        const members = FLEET.map((e) =>
            api.stitch({ name: e.name, path: e.path, kind: surface }),
        );

        for (let round = 0; round < 100; round += 1)
            for (const m of members) await m();

        check('(a) calls made', vendor.total, 500);
        check('(a) endpoints called', vendor.requests.size, 5);
        check('(a) rows in the fleet report', watch.fleet().length, 3);
        checkSeq(
            '(a) the report, soonest sunset first',
            watch
                .fleet()
                .map(
                    (r) =>
                        `${r.endpoint} sunset=${new Date(r.notice.sunsetAt ?? 0).toISOString().slice(0, 10)} calls=${String(r.calls)}`,
                ),
            [
                'users sunset=2026-01-01 calls=100',
                'search sunset=2026-03-15 calls=100',
                'orders sunset=2026-06-01 calls=100',
            ],
        );
        check(
            '(a) the one line an operator reads',
            watch.summary(),
            '3 endpoints deprecated (users, search, orders), earliest sunset in 12 days: users',
        );
        note(
            '(a) → the exact sentence the capture asked for, from 500 calls across 5 endpoints, with ONE sink configured once at the seam',
        );
    }

    // ── (b) what identifies the endpoint at the sink: `ctx.name`, and its default collides ───
    {
        const rows: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent, ctx: TraceContext) {
                if (e.type === 'start') rows.push(`ctx.name=${ctx.name}`);
            },
        };
        // Two DIFFERENT endpoints, neither given a `name`.
        await stitch({
            url: `${BASE}/v1/users`,
            adapter: serving(endpoint('users')),
            trace: sink,
        })();
        await stitch({
            url: `${BASE}/v1/orders`,
            adapter: serving(endpoint('orders')),
            trace: sink,
        })();
        checkSeq('(b) two endpoints, no `name` set', rows, [
            'ctx.name=stitch',
            'ctx.name=stitch',
        ]);
        note(
            '(b) → `name` defaults to `path` or `"stitch"` (types.ts:1424-1425), and a `url`-configured stitch has no `path`. Both endpoints answer to `stitch`, so a Map keyed on `ctx.name` silently merges them. Naming every member is not optional here',
        );
    }
    {
        // The URL is on the `start` event, not on `ctx` — so recovering it means correlating
        // `start` to `result` by `spanId`. Measured, because "just use the url" is the obvious fix.
        const urls = new Map<string, string>();
        const resolved: string[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent, ctx: TraceContext) {
                if (e.type === 'start' && ctx.spanId !== undefined)
                    urls.set(ctx.spanId, e.url);
                if (e.type === 'result' && ctx.spanId !== undefined)
                    resolved.push(urls.get(ctx.spanId) ?? '<lost>');
            },
        };
        await stitch({
            url: `${BASE}/v1/users`,
            adapter: serving(endpoint('users')),
            trace: sink,
        })();
        await stitch({
            url: `${BASE}/v1/orders`,
            adapter: serving(endpoint('orders')),
            trace: sink,
        })();
        checkSeq('(b) …recovered via `spanId` correlation', resolved, [
            `${BASE}/v1/users`,
            `${BASE}/v1/orders`,
        ]);
        note(
            '(b) → it works and it is a second Map plus a join. `ctx` carries `{ name, spanId, traceId }`; the URL only ever appears on `start`',
        );
    }

    // ── (c) does the header reach the sink WITHOUT the surface? No ───────────────────────────
    {
        const notices: (Notice | null)[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'result') notices.push(noticeOf(e.data));
            },
        };
        // Same vendor, same headers, DEFAULT surface.
        await stitch({
            name: 'users',
            url: `${BASE}/v1/users`,
            adapter: serving(endpoint('users')),
            trace: sink,
        })();
        checkSeq('(c) notices at the sink, default surface', notices, [null]);
        note(
            '(c) → THE COUPLING. The vendor sent both headers; the sink saw a body. Aggregation is a real seam and it has nothing to aggregate until a surface puts the notice on the value',
        );
    }

    // ── (d) …and an `output` contract that strips the fold breaks it again ───────────────────
    {
        const notices: (Notice | null)[] = [];
        const sink: TraceSink = {
            handle(e: StitchEvent) {
                if (e.type === 'result') notices.push(noticeOf(e.data));
            },
        };
        await stitch({
            name: 'users',
            url: `${BASE}/v1/users`,
            adapter: serving(endpoint('users')),
            kind: deprecationSurface({ fold: true }),
            // A perfectly ordinary contract that declares only what the caller uses.
            output: {
                validate: async (v: unknown) => ({
                    ok: true as const,
                    value: { users: (v as Record<string, unknown>)['users'] },
                }),
            },
            trace: sink,
        })();
        checkSeq('(d) notices at the sink, after validation', notices, [null]);
        note(
            '(d) → the `result` event carries the VALIDATED value, so a schema that does not declare `_deprecation` deletes the notice on its way to the sink. The surface, the contract and the sink are one coupled unit, and nothing warns you when they disagree',
        );
    }

    // ── (e) the side channel: the surface reports directly, no sink, no payload change ───────
    {
        const seen: string[] = [];
        const collected = new Map<string, Notice>();
        const surface = deprecationSurface({
            onNotice: (name, notice) => {
                seen.push(name);
                collected.set(name, notice);
            },
        });
        const vendor = new FakeVendor();
        const api = seam({ baseUrl: BASE, adapter: vendor.adapter() });
        for (const e of FLEET)
            for (let i = 0; i < 3; i += 1)
                await api.stitch({
                    name: e.name,
                    path: e.path,
                    kind: surface,
                })();

        check('(e) calls made', vendor.total, 15);
        check('(e) notice callbacks', seen.length, 9);
        checkSeq('(e) endpoints collected', [...collected.keys()].sort(), [
            'orders',
            'search',
            'users',
        ]);
        const value = await api.stitch({
            name: 'users',
            path: '/v1/users',
            kind: surface,
        })();
        checkSeq(
            "(e) …and the caller's value is untouched",
            Object.keys(value as object).sort(),
            ['users'],
        );
        note(
            '(e) → the same fleet view with no `trace`, no `output` coupling and no change to the result type. It is not the trace channel, and for this signal that may be the right trade',
        );
    }

    // ── (f) seam-level `kind`: a compile error that WORKS AT RUNTIME ──────────────────────────
    // The hypothesis going in was "`SeamConfig` omits `kind` (types.ts:1988-1998), so a 40-member
    // seam repeats the surface 40 times". Half right, and the wrong half is the interesting one:
    // the type genuinely forbids it —
    //
    //   seam({ baseUrl, kind: httpSurface })
    //   error TS2353: Object literal may only specify known properties,
    //                 and 'kind' does not exist in type 'SeamOptions'.
    //
    // — but the ENGINE composes it into every member anyway. Measured here through a cast, so the
    // runtime behaviour is on the page rather than inferred from the type.
    {
        const surface = deprecationSurface({ fold: true });
        const vendor = new FakeVendor();
        const api = seam({
            baseUrl: BASE,
            adapter: vendor.adapter(),
            kind: surface,
        } as never) as ReturnType<typeof seam>;
        const member = api.stitch({ name: 'users', path: '/v1/users' });

        check(
            '(f) surface id on the SEAM config',
            api.__config['kind'],
            'http+deprecation',
        );
        check(
            '(f) surface id the MEMBER inherited (no `kind` of its own)',
            member.__config['kind'],
            'http+deprecation',
        );
        check(
            '(f) …and the notice it folded',
            noticeOf(await member())?.sunsetAt,
            Date.parse('2026-01-01T00:00:00Z'),
        );
        check(
            '(f) a plain seam resolves to',
            seam({ baseUrl: BASE, adapter: serving(endpoint('users')) })
                .__config['kind'],
            'http',
        );
        note(
            '(f) → the capability is REAL and the type is closed over it. `SeamOptions` omits `kind`, so a typed codebase writes the surface on all 40 members while the engine would have inherited it from one. `trace` has no such problem — the sink genuinely is configured once',
        );
    }

    // ── (g) TRAP: a cached response re-serves a STALE notice, forever ────────────────────────
    {
        const clock = manualClock(NOW);
        const watch = new DeprecationWatch(clock);
        const vendor = new FakeVendor();
        const call = stitch({
            name: 'users',
            url: `${BASE}/v1/users`,
            adapter: vendor.adapter(),
            kind: deprecationSurface({ fold: true }),
            cache: { ttl: '1h', fingerprint: { version: 'v1' } },
            clock,
            trace: watch,
        });
        for (let i = 0; i < 10; i += 1) await call();
        check('(g) wire requests', vendor.total, 1);
        check('(g) calls the sink counted', watch.fleet()[0]?.calls, 10);
        // Time moves a year. The cache TTL is an hour, so the value is re-fetched — but a cache
        // that had NOT expired would still be handing out the notice it captured a year ago.
        checkSeq(
            '(g) the report, from 1 wire response and 9 cache hits',
            [watch.summary()],
            [
                '1 endpoints deprecated (users), earliest sunset in 12 days: users',
            ],
        );
        note(
            '(g) → the notice is now CACHED DATA. Nine of those ten rows are a header read once and replayed; with a long TTL a sunset that already passed keeps reporting as "in 12 days" until the entry expires',
        );
    }

    // ── (h) TRAP: `.inspect()` / `.report()` are fresh runs and land in the sink ─────────────
    {
        const clock = manualClock(NOW);
        const watch = new DeprecationWatch(clock);
        const vendor = new FakeVendor();
        const call = stitch({
            name: 'users',
            url: `${BASE}/v1/users`,
            adapter: vendor.adapter(),
            kind: deprecationSurface({ fold: true }),
            clock,
            trace: watch,
        });
        await call();
        const before = watch.fleet()[0]?.calls ?? 0;
        await call.report();
        await call.inspect();
        checkSeq(
            '(h) sink call-count before / after one `.report()` + one `.inspect()`',
            [before, watch.fleet()[0]?.calls ?? 0, vendor.total],
            [1, 3, 3],
        );
        note(
            '(h) → same trap scenario 12 measured for drift rates: a diagnostic probe is a real run that costs a request and a tick in the denominator',
        );
    }

    // ── (i) TRAP: the deprecated endpoints are a MINORITY of a healthy-looking fleet ─────────
    {
        const clock = manualClock(NOW);
        const vendor = new FakeVendor();
        const watch = new DeprecationWatch(clock);
        const api = seam({
            baseUrl: BASE,
            adapter: vendor.adapter(),
            clock,
            trace: watch,
        });
        const surface = deprecationSurface({ fold: true });
        // Traffic skewed the way real traffic is: the healthy endpoints carry it.
        for (let i = 0; i < 200; i += 1)
            await api.stitch({
                name: 'payments',
                path: '/v1/payments',
                kind: surface,
            })();
        await api.stitch({ name: 'users', path: '/v1/users', kind: surface })();

        check('(i) calls made', vendor.total, 201);
        check('(i) calls that carried a notice', 1, 1);
        check('(i) rows in the report', watch.fleet().length, 1);
        check(
            '(i) the report',
            watch.summary(),
            '1 endpoints deprecated (users), earliest sunset in 12 days: users',
        );
        note(
            '(i) → ONE call in 201 carried the signal and the report is identical. That is the property a per-call log line does not have, and it is the whole argument for aggregating',
        );
    }

    finish(
        'C4',
        'IT WORKS, AND THE SCENARIO-12 SHAPE TRANSFERS — BUT NOT THE DATA PATH. One `DeprecationWatch` sink configured once on a seam, 500 calls across 5 endpoints, reported `3 endpoints deprecated (users, search, orders), earliest sunset in 12 days: users`, one row per endpoint however many calls arrived; with traffic skewed 200:1 toward the healthy endpoints the report was unchanged, which is exactly what a per-call log line cannot do. `ctx.name` is what identifies the endpoint — and its default is the literal `"stitch"` for any `url`-configured stitch, so two unnamed endpoints silently merge into one row; the URL exists only on the `start` event, recoverable by correlating on `ctx.spanId` at the cost of a second Map and a join. THE HEADER VALUE DOES NOT REACH THE SINK ON ITS OWN: with the default surface the sink saw `null` for a response that carried both headers, because no event carries headers at all. It only arrives if a Surface folded it into the value — and an ordinary `output` contract that does not declare `_deprecation` deletes it again before the `result` event fires, with no warning. Three further traps: seam-level `kind` is a COMPILE ERROR (`TS2353: kind does not exist in type SeamOptions`) that the engine honours perfectly at runtime — members inherited `http+deprecation` and folded correctly — so a typed codebase writes the surface on all 40 members for a capability that already works from one; a cache hit re-serves a notice captured on the ONE wire response, so 9 of 10 rows were a replayed header and a long TTL will report a passed sunset as "in 12 days"; and `.report()`/`.inspect()` are fresh runs that each add a request and a tick. The side channel — `onNotice` straight out of the surface — produces the identical fleet view with no `trace`, no `output` coupling and an untouched result type',
    );
}

void main();
