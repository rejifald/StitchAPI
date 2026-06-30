// Engine-level cache + coalescing behaviour (ADR 0003) driven through the public `stitch`/`seam`
// surfaces against a counting adapter — so "served from cache" is observable as "the origin was
// not called again". Covers hit/miss, TTL, in-process coalescing, exact + bulk invalidation, LRU
// eviction, the `sensitive` bypass, principal scope isolation, re-validate-on-hit + the
// `version` fast path, and the cacheable-method gate (GraphQL opt-in).
import { graphql, memoryStore, seam, stitch } from '../src';
import type { Adapter } from '../src';
import { clearFingerprinters, registerFingerprinter } from '../src/fingerprint';
import type { SchemaFingerprinter } from '../src/fingerprint';
import type { StandardSchemaV1 } from '../src/standard-schema';

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

// A minimal Standard Schema carrying an inspectable `__desc` (mirrors fingerprint.spec). It rides
// through `toValidator`, which preserves it as the Validator's non-enumerable `source` so the cache
// can fingerprint it; `~standard.validate` accepts the value unchanged.
function fpSchema(
    desc: unknown,
    vendor = 'test',
): StandardSchemaV1 & { __desc: unknown } {
    return {
        '~standard': {
            version: 1,
            vendor,
            validate: (value: unknown) => ({ value }),
        },
        __desc: desc,
    };
}

// Reference strategy: distinct `__desc` → distinct token; ABSTAINS (value null) on `{ opaque }`.
const testFingerprinter: SchemaFingerprinter = {
    vendor: 'test',
    supports: '*',
    fingerprint(schema) {
        const desc = (schema as { __desc?: unknown }).__desc;
        if (desc && typeof desc === 'object' && 'opaque' in desc)
            return { token: null, strength: 'strong' };
        return { token: JSON.stringify(desc), strength: 'strong' };
    },
};

// Drain a stitch's event stream and collect the `cache`-phase trace details (hit/miss/bypass/…).
async function cacheTrace(
    run: AsyncIterable<{ type: string; phase?: string; detail?: string }>,
): Promise<string[]> {
    const details: string[] = [];
    for await (const ev of run)
        if (ev.type === 'progress' && ev.phase === 'cache' && ev.detail)
            details.push(ev.detail);
    return details;
}

// An adapter that counts origin calls and returns a JSON body. `body(callNo, req)` defaults to
// `{ n: callNo }`, so a stable cached response still lets a test prove freshness by call count.
function counting(opts?: {
    body?: (callNo: number, req: { url: string; method: string }) => unknown;
    headers?: Record<string, string>;
    delayMs?: number;
    failCall?: number;
}): { adapter: Adapter; calls: () => number } {
    let calls = 0;
    const adapter: Adapter = async (req) => {
        const n = (calls += 1);
        if (opts?.delayMs) await sleep(opts.delayMs);
        if (opts?.failCall === n) throw new Error(`origin failed on call ${n}`);
        return {
            status: 200,
            headers: opts?.headers ?? {},
            body: opts?.body
                ? opts.body(n, { url: req.url, method: req.method })
                : { n },
        };
    };
    return { adapter, calls: () => calls };
}

const URL = 'https://api.test/resource';

describe('cache — hit / miss', () => {
    test('a second identical call is served from cache (origin called once)', async () => {
        const { adapter, calls } = counting();
        const s = stitch({
            url: URL,
            adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app' },
        });
        expect(await s()).toEqual({ n: 1 });
        expect(await s()).toEqual({ n: 1 }); // same value, no second origin call
        expect(calls()).toBe(1);
    });

    test('distinct inputs derive distinct keys (separate entries)', async () => {
        const { adapter, calls } = counting();
        const s = stitch({
            url: URL,
            adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app' },
        });
        await s({ query: { id: 1 } });
        await s({ query: { id: 2 } });
        expect(calls()).toBe(2);
        await s({ query: { id: 1 } }); // hit
        expect(calls()).toBe(2);
    });

    test('an entry expires after its ttl', async () => {
        const { adapter, calls } = counting();
        const s = stitch({
            url: URL,
            adapter,
            trace: false,
            cache: { ttl: 30, scope: 'app' },
        });
        await s();
        await s();
        expect(calls()).toBe(1);
        await sleep(60);
        await s(); // ttl lapsed → refetch
        expect(calls()).toBe(2);
    });

    test('a non-cacheable method (default GET/HEAD set) is never cached', async () => {
        const { adapter, calls } = counting();
        const s = stitch({
            url: URL,
            method: 'POST',
            adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app' },
        });
        await s();
        await s();
        expect(calls()).toBe(2);
    });
});

describe('cache — in-process coalescing', () => {
    test('N concurrent identical callers collapse onto one origin call', async () => {
        const { adapter, calls } = counting({ delayMs: 40 });
        const s = stitch({
            url: URL,
            adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app' },
        });
        const results = await Promise.all([s(), s(), s(), s(), s()]);
        for (const r of results) expect(r).toEqual({ n: 1 });
        expect(calls()).toBe(1);
    });

    test('a leader failure is NOT shared — each waiter re-runs independently', async () => {
        // Only the first origin call fails; the leader rejects, and the two followers proceed on
        // their own (each making its own call), so failure never fans out to the waiters.
        const { adapter, calls } = counting({ delayMs: 30, failCall: 1 });
        const s = stitch({
            url: URL,
            adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app' },
        });
        const settled = await Promise.allSettled([s(), s(), s()]);
        const rejected = settled.filter((r) => r.status === 'rejected');
        expect(rejected).toHaveLength(1); // exactly the leader
        expect(calls()).toBe(3); // leader + two independent re-runs
    });

    test('coalesce:false disables collapsing (still caches)', async () => {
        const { adapter, calls } = counting({ delayMs: 40 });
        const s = stitch({
            url: URL,
            adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app', coalesce: false },
        });
        await Promise.all([s(), s(), s()]); // not collapsed
        expect(calls()).toBe(3);
        await s(); // but the cache is warm now
        expect(calls()).toBe(3);
    });
});

describe('cache — invalidation', () => {
    test('handle.invalidate(input) is an exact eviction', async () => {
        const { adapter, calls } = counting();
        const s = stitch({
            url: URL,
            adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app' },
        });
        await s({ query: { id: 1 } });
        await s({ query: { id: 2 } });
        expect(calls()).toBe(2);

        await s.invalidate({ query: { id: 1 } });
        await s({ query: { id: 1 } }); // evicted → refetch
        await s({ query: { id: 2 } }); // still cached
        expect(calls()).toBe(3);
    });

    test('stitch.cache.invalidate() bulk-evicts every entry (generation bump)', async () => {
        const { adapter, calls } = counting();
        const s = stitch({
            url: URL,
            adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app' },
        });
        await s({ query: { id: 1 } });
        await s({ query: { id: 2 } });
        expect(calls()).toBe(2);

        await s.cache.invalidate();
        await s({ query: { id: 1 } });
        await s({ query: { id: 2 } });
        expect(calls()).toBe(4); // both buckets gone
    });

    test('seam.invalidate() bulk-evicts across the shared store', async () => {
        const { adapter, calls } = counting();
        const api = seam({
            baseUrl: 'https://api.test',
            adapter,
            trace: false,
        });
        const users = api.stitch({
            path: '/users',
            cache: { ttl: '60s', scope: 'app' },
        });
        await users();
        await users();
        expect(calls()).toBe(1);

        await api.invalidate(); // cache-wide
        await users();
        expect(calls()).toBe(2);
    });

    test('seam.invalidate(stitch) targets one member', async () => {
        const { adapter, calls } = counting();
        const api = seam({
            baseUrl: 'https://api.test',
            adapter,
            trace: false,
        });
        const users = api.stitch({
            path: '/users',
            cache: { ttl: '60s', scope: 'app' },
        });
        const orders = api.stitch({
            path: '/orders',
            cache: { ttl: '60s', scope: 'app' },
        });
        await users();
        await orders();
        expect(calls()).toBe(2);

        await api.invalidate(users); // only users
        await users(); // refetch
        await orders(); // still cached
        expect(calls()).toBe(3);
    });

    test('cache.key(input) exposes the derived opaque key', async () => {
        const { adapter } = counting();
        const s = stitch({
            url: URL,
            adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app' },
        });
        const k1 = await s.cache.key({ query: { id: 1 } });
        const k2 = await s.cache.key({ query: { id: 1 } });
        const k3 = await s.cache.key({ query: { id: 2 } });
        expect(k1).toMatch(/^[0-9a-f]{32}$/);
        expect(k1).toBe(k2);
        expect(k1).not.toBe(k3);
    });
});

describe('cache — LRU bound', () => {
    test('entries evicts the least-recently-used entry', async () => {
        const { adapter, calls } = counting();
        const s = stitch({
            url: URL,
            adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app', entries: 2 },
        });
        await s({ query: { id: 1 } }); // 1
        await s({ query: { id: 2 } }); // 2
        await s({ query: { id: 3 } }); // 3 → evicts id:1
        expect(calls()).toBe(3);

        await s({ query: { id: 1 } }); // evicted → refetch
        expect(calls()).toBe(4);
        await s({ query: { id: 3 } }); // still resident → hit
        expect(calls()).toBe(4);
    });
});

describe('cache — sensitive bypass', () => {
    test('sensitive:true never caches and never coalesces', async () => {
        const { adapter, calls } = counting({ delayMs: 30 });
        const s = stitch({
            url: URL,
            adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app' },
            sensitive: true,
        });
        await Promise.all([s(), s()]); // not coalesced
        expect(calls()).toBe(2);
        await s(); // not cached
        expect(calls()).toBe(3);
    });
});

describe('cache — scope isolation', () => {
    test('principal scope (default) never serves one principal another’s entry', async () => {
        const { adapter, calls } = counting();
        const api = seam({
            baseUrl: 'https://api.test',
            adapter,
            trace: false,
        });
        const def = { path: '/me', cache: { ttl: '60s' } }; // default scope: 'principal'
        const alice = api.as('alice').stitch(def);
        const bob = api.as('bob').stitch(def);

        await alice();
        await alice();
        expect(calls()).toBe(1); // alice cached
        await bob();
        expect(calls()).toBe(2); // bob is a different key → miss
        await bob();
        expect(calls()).toBe(2); // bob now cached too
    });

    test('scope:"app" shares one entry across principals', async () => {
        const { adapter, calls } = counting();
        const api = seam({
            baseUrl: 'https://api.test',
            adapter,
            trace: false,
        });
        const def = {
            path: '/pub',
            cache: { ttl: '60s', scope: 'app' as const },
        };
        const alice = api.as('alice').stitch(def);
        const bob = api.as('bob').stitch(def);

        await alice();
        expect(calls()).toBe(1);
        await bob(); // app scope → shares alice's entry
        expect(calls()).toBe(1);
    });
});

describe('cache — re-validate on hit vs version fast path', () => {
    test('onUnfingerprintable:"revalidate" self-heals a stale-shaped hit', async () => {
        // First origin call returns a string `n`; later calls return a number. A loose writer
        // (accept-anything predicate) caches the string; a strict reader (number predicate) sharing
        // the store + key re-validates on hit, finds it stale, evicts, and refetches a conforming
        // value. Both outputs are predicates — un-fingerprintable — so with onUnfingerprintable:
        // 'revalidate' both take policy 'revalidate' and share one (empty-fingerprint) bucket.
        const { adapter, calls } = counting({
            body: (n) => ({ n: n === 1 ? 'oops' : 7 }),
        });
        const store = memoryStore();
        const base = {
            url: URL,
            name: 'reval',
            adapter,
            store,
            trace: false as const,
            cache: {
                ttl: '60s',
                scope: 'app' as const,
                onUnfingerprintable: 'revalidate' as const,
            },
        };
        const writer = stitch({
            ...base,
            output: (v: unknown): v is object => typeof v === 'object',
        });
        const reader = stitch({
            ...base,
            output: (v: unknown): v is { n: number } =>
                typeof (v as { n?: unknown }).n === 'number',
        });

        expect(await writer()).toEqual({ n: 'oops' }); // call 1, cached as-is
        expect(await reader()).toEqual({ n: 7 }); // hit fails revalidation → refetch (call 2)
        expect(calls()).toBe(2);
    });

    test('cache.version pins the schema — a hit is trusted, not re-validated', async () => {
        const { adapter, calls } = counting({
            body: (n) => ({ n: n === 1 ? 'oops' : 7 }),
        });
        const store = memoryStore();
        const base = {
            url: URL,
            name: 'pinned',
            adapter,
            store,
            trace: false as const,
            cache: { ttl: '60s', scope: 'app' as const, version: '1' },
        };
        const writer = stitch(base);
        const reader = stitch({
            ...base,
            output: (v: unknown): v is { n: number } =>
                typeof (v as { n?: unknown }).n === 'number',
        });

        expect(await writer()).toEqual({ n: 'oops' }); // call 1, cached
        // version set → no re-validation: the stale-shaped value is returned as-is, no refetch.
        expect(await reader()).toEqual({ n: 'oops' });
        expect(calls()).toBe(1);
    });
});

describe('cache — schema fingerprint fold (ADR 0004)', () => {
    afterEach(() => {
        clearFingerprinters();
    });

    test('a no-output stitch caches fast — a hit is served without re-validation', async () => {
        const { adapter, calls } = counting();
        const s = stitch({
            url: URL,
            adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app' },
        });
        expect(await s()).toEqual({ n: 1 });
        const trace = await cacheTrace(s.stream());
        expect(trace).toContain('hit'); // policy 'fast' → plain 'hit', not 'hit (revalidated)'
        expect(trace).not.toContain('hit (revalidated)');
        expect(calls()).toBe(1);
    });

    test('a registered fingerprinter takes the fast path; a changed schema is a new generation → miss', async () => {
        registerFingerprinter(testFingerprinter);
        const { adapter, calls } = counting();
        const store = memoryStore();
        const base = {
            url: URL,
            name: 'fp',
            adapter,
            store,
            trace: false as const,
            cache: { ttl: '60s', scope: 'app' as const },
        };
        const v1 = stitch({ ...base, output: fpSchema('v1') });
        expect(await v1()).toEqual({ n: 1 });
        expect(await v1()).toEqual({ n: 1 }); // sound fingerprint → fast hit
        expect(calls()).toBe(1);

        // Ship a changed output schema (new __desc → new fingerprint token) → new bucket → miss.
        const v2 = stitch({ ...base, output: fpSchema('v2') });
        expect(await v2()).toEqual({ n: 2 });
        expect(calls()).toBe(2);

        // The old schema's entry lives in its own bucket — still a hit, not clobbered.
        expect(await v1()).toEqual({ n: 1 });
        expect(calls()).toBe(2);
    });

    test('an un-fingerprintable schema is refused by default (fail-closed) and surfaces why', async () => {
        registerFingerprinter(testFingerprinter); // registered, but ABSTAINS on { opaque }
        const { adapter, calls } = counting();
        const s = stitch({
            url: URL,
            adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app' },
            output: fpSchema({ opaque: true }),
        });
        const trace = await cacheTrace(s.stream());
        expect(trace.some((d) => d.startsWith('bypass:'))).toBe(true);
        expect(trace.join(' ')).toContain('abstained'); // the reason is not swallowed
        await s();
        expect(calls()).toBe(2); // never cached — each call is live
    });

    test('onUnfingerprintable:"revalidate" caches and re-validates the stored value on each hit', async () => {
        registerFingerprinter(testFingerprinter);
        const { adapter, calls } = counting();
        const s = stitch({
            url: URL,
            adapter,
            trace: false,
            cache: {
                ttl: '60s',
                scope: 'app',
                onUnfingerprintable: 'revalidate',
            },
            output: fpSchema({ opaque: true }), // abstains → policy 'revalidate'
        });
        expect(await s()).toEqual({ n: 1 });
        const trace = await cacheTrace(s.stream());
        expect(trace).toContain('hit (revalidated)'); // re-validated, then served
        expect(calls()).toBe(1); // value re-validates fine → still cached
    });

    test('an opaque transform refuses to cache unless a transformVersion makes it sound', async () => {
        const refused = counting();
        const r = stitch({
            url: URL,
            name: 'tx',
            adapter: refused.adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app' },
            transform: (b) => b, // opaque closure, no transformVersion/trustTransform → refuse
        });
        const trace = await cacheTrace(r.stream());
        expect(trace.some((d) => d.startsWith('bypass:'))).toBe(true);
        expect(trace.join(' ')).toContain('transform'); // reason names the transform
        await r();
        expect(refused.calls()).toBe(2); // not cached

        const versioned = counting();
        const v = stitch({
            url: URL,
            name: 'txv',
            adapter: versioned.adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app', transformVersion: '1' },
            transform: (b) => b, // now sound (version named) → fast
        });
        await v();
        await v();
        expect(versioned.calls()).toBe(1); // second call is a hit
    });
});

describe('cache — GraphQL opt-in', () => {
    test('a GraphQL query caches only when its method opts in', async () => {
        const { adapter, calls } = counting({
            body: () => ({ data: { me: { id: 1 } } }),
        });
        const q = graphql({
            url: 'https://api.test/graphql',
            query: '{ me { id } }',
            adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app', methods: ['POST'] },
        });
        expect(await q()).toEqual({ me: { id: 1 } });
        await q();
        expect(calls()).toBe(1); // POST opted in → cached
    });

    test('a GraphQL query without the opt-in is not cached', async () => {
        const { adapter, calls } = counting({
            body: () => ({ data: { me: { id: 1 } } }),
        });
        const q = graphql({
            url: 'https://api.test/graphql',
            query: '{ me { id } }',
            adapter,
            trace: false,
            cache: { ttl: '60s', scope: 'app' }, // default methods GET/HEAD → POST excluded
        });
        await q();
        await q();
        expect(calls()).toBe(2);
    });
});

describe('cache — non-storable pass-through', () => {
    test('a binary responseType warns and passes through (never throws)', async () => {
        const { adapter, calls } = counting();
        const s = stitch({
            url: URL,
            adapter,
            responseType: 'arrayBuffer',
            trace: false,
            cache: { ttl: '60s', scope: 'app' },
        });
        let bypass = false;
        for await (const ev of s.stream()) {
            if (ev.type === 'progress' && ev.phase === 'cache')
                bypass = ev.detail?.startsWith('bypass') ?? false;
        }
        expect(bypass).toBe(true);
        await s();
        expect(calls()).toBe(2); // not cached
    });
});
