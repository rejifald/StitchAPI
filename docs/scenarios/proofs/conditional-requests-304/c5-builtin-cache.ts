// C5 — can the built-in `cache` participate, storing the ETag alongside the body? And does a cache
// HIT short-circuit before any revalidation could run?
//
// No, and yes. The two are the same fact seen from either end: `cache` is a value store, not a
// response store. Its entry shape is `{ v, s, vary }` (cache.ts:300-304) — the validated VALUE, the
// status, and the learned `Vary` names. Response headers are never carried into it, so there is
// nowhere for an ETag to live; and `runCached` serves a hit at engine.ts:1613-1617 by yielding
// `resultEvt` directly, before `runFrom` is ever entered, so nothing downstream of the lookup runs.
//
// `revalidateOnHit` (cache.ts:441, engine.ts:1604) is a false friend: it re-validates the stored
// value against the `output` SCHEMA (ADR 0004's un-fingerprintable-contract policy). It never
// touches the network.
//
// What the two CAN do is compose, in the one order that makes sense: `cache` outermost for the hot
// window, revalidation underneath for the cold one. That is measured too.
//
//   pnpm exec tsx docs/scenarios/proofs/conditional-requests-304/c5-builtin-cache.ts
import { stitch, verdictOf } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import { clockStore } from './clock-store';
import { FakeEtagApi } from './fake-etag-api';
import { check, checkSeq, finish, heading, note } from './harness';

/** The `execute`-seam revalidator from C3, as a reusable factory for this script. */
function revalidating(api: FakeEtagApi): Surface {
    const store = new Map<string, { etag: string; body: unknown }>();
    const transport = api.adapter();
    return {
        id: 'http+revalidate',
        execute: async (req) => {
            const key = `${req.method} ${req.url}`;
            const entry = store.get(key);
            if (entry) req.headers['If-None-Match'] = entry.etag;
            const res = await transport(req);
            if (res.status === 304 && entry)
                return { ...res, body: entry.body };
            const etag = res.headers['etag'];
            if (res.status === 200 && etag !== undefined)
                store.set(key, { etag, body: res.body });
            return res;
        },
    };
}

async function main(): Promise<void> {
    heading('C5 — the built-in `cache`, and what a hit skips');

    // ── (a) a hit short-circuits EVERYTHING below the lookup ──────────────────────────────────
    // Hooks, the surface's `interpret`, the network. Measured with three counters at once.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const fired: string[] = [];
        let interpretCalls = 0;
        const counting: Surface = {
            id: 'counting',
            interpret: (res, cfg) => {
                interpretCalls++;
                return verdictOf(res, cfg) ?? { ok: true, data: res.body };
            },
        };
        const issues = stitch({
            url: api.url,
            kind: counting,
            adapter: api.adapter(),
            clock,
            store: clockStore(clock),
            cache: { ttl: '60s', tenancy: 'app' },
            hooks: {
                onRequest: () => void fired.push('onRequest'),
                onResponse: () => void fired.push('onResponse'),
            },
        });
        await issues.safe({});
        await issues.safe({});
        await issues.safe({});
        checkSeq('(a) hooks fired across 3 calls', fired, [
            'onRequest',
            'onResponse',
        ]);
        check('(a) `interpret` calls', interpretCalls, 1);
        check('(a) requests reaching the server', api.requests, 1);

        const events: string[] = [];
        for await (const e of issues.stream({}))
            events.push(
                e.type === 'progress' ? `${e.phase}:${e.detail ?? ''}` : e.type,
            );
        checkSeq('(a) event spine on a hit', events, [
            'start',
            'cache:hit',
            'result',
            'done',
        ]);
        note(
            '(a) → there is no `request` phase on a hit, so there is nothing to conditionalise',
            'engine.ts:1613-1617 yields `resultEvt` and returns without entering `runFrom`',
        );
    }

    // ── (b) the entry has no room for an ETag ─────────────────────────────────────────────────
    // The stored value is what the CALLER got — post-`interpret`, post-`transform`, post-validation
    // (engine.ts:1624 stores `out.value`). No headers reach it. The only way to keep a validator
    // alongside the body through `cache` is to fold it INTO the value, which changes the value the
    // caller receives — measured here so the workaround's cost is on the record.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        let lastEtag: string | undefined;
        const issues = stitch({
            url: api.url,
            adapter: api.adapter(),
            clock,
            store: clockStore(clock),
            cache: { ttl: '60s', tenancy: 'app' },
            hooks: {
                onResponse: (ctx) => {
                    lastEtag = ctx.res?.headers['etag'];
                },
            },
            transform: (body) => ({ etag: lastEtag, body }),
        });
        const first = await issues.safe({});
        check(
            '(b) etag reachable only by reshaping the value',
            (first.data as { etag?: string }).etag,
            '"v1.t1"',
        );
        // …and the reshaping is self-defeating: an opaque `transform` cannot be fingerprinted, so
        // ADR 0004's fail-closed policy REFUSES to cache at all. The workaround that makes the ETag
        // storable is the same workaround that turns the cache off.
        const events: string[] = [];
        for await (const e of issues.stream({}))
            if (e.type === 'progress' && e.phase === 'cache')
                events.push(e.detail ?? '');
        check('(b) requests across 2 calls', api.requests, 2);
        check('(b) cache verdict', events[0]?.startsWith('bypass:'), true);
        note('(b) cache bypass reason', events[0] ?? '(none)');
        note(
            '(b) → the caller now unwraps `{ etag, body }` on every call AND loses the cache',
            'an opaque `transform` is un-fingerprintable, so the stitch refuses to cache (ADR 0004)',
        );
    }

    // ── (c) `cache` cannot STORE a 304, and keeps re-requesting one forever ───────────────────
    // Force the conditional request into its own cache key (`vary: ['if-none-match']`) so the 304 is
    // a genuine miss that then gets stored. `op.set` writes `{ v: undefined, s: 304 }`, and `hitFrom`
    // (cache.ts:482) reads `entry.v === undefined` as "no hit" — so the entry is written and can
    // never be read. Every subsequent identical call goes back to the network AND returns `undefined`.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const issues = stitch({
            url: api.url,
            adapter: api.adapter(),
            clock,
            store: clockStore(clock),
            cache: {
                ttl: '600s',
                tenancy: 'app',
                vary: ['if-none-match'],
            },
        });
        await issues.safe({});
        const inm = { 'If-None-Match': api.etagFor('(none)') };
        const r1 = await issues.safe({ headers: inm });
        const r2 = await issues.safe({ headers: inm });
        const r3 = await issues.safe({ headers: inm });
        checkSeq(
            '(c) data across 3 identical conditional calls',
            [r1.data, r2.data, r3.data],
            [undefined, undefined, undefined],
        );
        checkSeq(
            '(c) statuses on the wire',
            api.statuses,
            [200, 304, 304, 304],
        );
        check('(c) requests', api.requests, 4);
        note(
            '(c) → the cache neither serves nor suppresses a 304',
            'it writes `{ v: undefined }`, which cache.ts:482 reads as a permanent miss',
        );
    }

    // ── (d) `cache.vary` cannot key on the ETag anyway — the header is not in the key ──────────
    // Without an explicit `vary`, request headers are absent from `canonicalRequest` (cache.ts:129-147:
    // method, url, body, principal — headers ONLY when `varyNames` is non-empty). So a hand-set
    // `If-None-Match` does not even reach the server: the call hits the cache entry stored for the
    // unconditional request.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const issues = stitch({
            url: api.url,
            adapter: api.adapter(),
            clock,
            store: clockStore(clock),
            cache: { ttl: '600s', tenancy: 'app' },
        });
        await issues.safe({});
        const r = await issues.safe({
            headers: { 'If-None-Match': api.etagFor('(none)') },
        });
        check('(d) conditional call → ok', r.ok, true);
        check(
            '(d) conditional call → data.version',
            (r.data as { version?: number }).version,
            1,
        );
        checkSeq('(d) statuses on the wire', api.statuses, [200]);
        note(
            '(d) → the validator never left the process',
            'the same key served the cached 200, which is correct caching and useless revalidation',
        );
    }

    // ── (e) `cache.ttl` does not honour the injected clock ────────────────────────────────────
    // `memoryStore` reads `now()` = `Date.now()` (store.ts:16,45 via util.ts:4), so a `manualClock`
    // advanced by a virtual HOUR expires nothing. Every other timing knob in the library is
    // clock-driven; this one is not, which makes cache staleness untestable without real sleeping.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const issues = stitch({
            url: api.url,
            adapter: api.adapter(),
            clock,
            cache: { ttl: '1s', tenancy: 'app' }, // default `memoryStore`
        });
        await issues.safe({});
        await clock.advance(3_600_000);
        await issues.safe({});
        check('(e) requests after +1h VIRTUAL on a 1s ttl', api.requests, 1);
        note(
            '(e) → `clock` drives retry/throttle/timeout/circuit, but NOT cache expiry',
            'every claim here that needs an expiring cache injects `clockStore(clock)` instead',
        );
    }

    // ── (f) what DOES work: `cache` outermost, revalidation underneath ────────────────────────
    // The hot window is answered with zero requests; the cold one with a 304 that costs nothing.
    {
        const clock = manualClock();
        const api = new FakeEtagApi({ clock });
        const issues = stitch({
            url: api.url,
            kind: revalidating(api),
            clock,
            store: clockStore(clock),
            cache: { ttl: '60s', tenancy: 'app' },
        });
        await issues.safe({});
        await issues.safe({});
        check('(f) requests inside the TTL window', api.requests, 1);
        await clock.advance(61_000);
        const cold = await issues.safe({});
        check('(f) requests after expiry', api.requests, 2);
        check('(f) billed after expiry', api.billed, 1);
        check(
            '(f) cold-window data.version',
            (cold.data as { version?: number }).version,
            1,
        );
        api.mutate();
        await clock.advance(61_000);
        const changed = await issues.safe({});
        check(
            '(f) picked up the change',
            (changed.data as { version?: number }).version,
            2,
        );
        checkSeq(
            '(f) statuses across the whole run',
            api.statuses,
            [200, 304, 200],
        );
        check('(f) billed across the whole run', api.billed, 2);
    }

    finish(
        'C5',
        'NO on both counts, for one reason: `cache` is a VALUE store, not a response store. Its entry is `{ v, s, vary }` (cache.ts:300-304) and what gets written is `out.value` — the post-`interpret`, post-`transform`, post-validation value (engine.ts:1624) — so no response header, and therefore no ETag, can reach it. `revalidateOnHit` (cache.ts:441) is a false friend: it re-checks the stored value against the `output` SCHEMA (engine.ts:1604), never the network. And a hit short-circuits everything below the lookup — measured across 3 calls: hooks fired `[onRequest, onResponse]` ONCE, `interpret` ran 1 time, 1 request reached the server, and the event spine on a hit is `[start, cache:hit, result, done]` with no `request` phase at all, because engine.ts:1613-1617 yields `resultEvt` and returns without entering `runFrom`. The one workaround — folding the ETag into the VALUE via `transform`, so `{ etag, body }` is what gets stored — is self-defeating: an opaque `transform` is un-fingerprintable, so ADR 0004 fails closed and the stitch refuses to cache at all (measured 2 requests across 2 calls, `bypass: opaque transform without cache.transformVersion or trustTransform`). Two sharper edges: the cache cannot STORE a 304 either — forced into its own key via `vary`, three identical conditional calls measured `[undefined, undefined, undefined]` with statuses `[200,304,304,304]` and 4 network requests, because `op.set` writes `{ v: undefined }` and cache.ts:482 reads that as a permanent miss; and without an explicit `vary`, request headers are not in the key at all (cache.ts:129-147), so a hand-set `If-None-Match` never leaves the process (measured statuses `[200]`). Separately: `cache.ttl` does NOT honour the injected `clock` — `memoryStore` reads `Date.now()` (store.ts:16,45), measured as 1 request after advancing a `manualClock` by a virtual hour against a 1s TTL. What DOES work is composing them: `cache` outermost for the hot window, revalidation underneath for the cold one — measured 1 request inside the TTL, a free 304 after expiry, and version 2 picked up on the next cold poll, at 2 billed responses across the run',
    );
}

void main();
