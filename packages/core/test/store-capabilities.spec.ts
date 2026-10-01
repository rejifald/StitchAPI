// #882 — `StitchStore.increment` is an optional capability, like `reserve` and the lease pair. A
// store needs only `get`/`set`; every feature uses a capability when the store has it and degrades
// visibly when it does not. This file pins each half of that against a get/set-only store:
//
// - bulk cache invalidation needs no counter (a generation is a fresh value written with `set`),
//   and generations a counter wrote before keep their prefix;
// - throttle `rate` falls back reserve → increment → in-process pacing, and the last step (like
//   `concurrency` without leases) announces itself exactly once with `throttle.per-process`;
// - the view forwarders report the backend's real capability instead of inventing `increment`.
import { memoryStore, seam, stitch } from '../src';
import type { Adapter, StitchEvent, StitchStore } from '../src';
import { bumpCacheGeneration } from '../src/cache';
import { chainThrottle, createStoreThrottle, vaultView } from '../src/store';
import type { Throttle } from '../src/store';
import { manualClock } from '../src/test-clock';

const TOPIC = 'throttle.per-process';

// The Workers KV shape: `get`/`set` and nothing else, over a real memoryStore underneath.
const getSetOnly = (base: StitchStore = memoryStore()): StitchStore => ({
    get: (k) => base.get(k),
    set: (k, v, ttl) => base.set(k, v, ttl),
});

// get/set plus the counter — the pre-ADR-0024 shape the counter fallback exists for.
const withCounter = (
    base: StitchStore = memoryStore(),
): StitchStore & { increments: () => number } => {
    let n = 0;
    return {
        get: (k) => base.get(k),
        set: (k, v, ttl) => base.set(k, v, ttl),
        increment: (k, ttl) => {
            n += 1;
            return base.increment!(k, ttl);
        },
        increments: () => n,
    };
};

function counting(): { adapter: Adapter; calls: () => number } {
    let calls = 0;
    const adapter: Adapter = async () => {
        calls += 1;
        return { status: 200, headers: {}, body: { n: calls } };
    };
    return { adapter, calls: () => calls };
}

const notes = (events: StitchEvent[]) =>
    events.filter(
        (e): e is Extract<StitchEvent, { type: 'info' }> =>
            e.type === 'info' && e.topic === TOPIC,
    );

async function drain(run: AsyncIterable<StitchEvent>): Promise<StitchEvent[]> {
    const out: StitchEvent[] = [];
    for await (const e of run) out.push(e);
    return out;
}

describe('cache — bulk invalidation needs no counter', () => {
    test('stitch.cache.invalidate() evicts on a get/set-only store', async () => {
        const { adapter, calls } = counting();
        const s = stitch({
            url: 'https://api.test/r',
            adapter,
            trace: false,
            store: getSetOnly(),
            cache: { ttl: '60s', tenancy: 'app' },
        });
        await s();
        await s();
        expect(calls()).toBe(1); // cached

        await s.cache.invalidate();
        await s();
        expect(calls()).toBe(2); // the bump moved the bucket
        await s();
        expect(calls()).toBe(2); // and the new bucket caches again
    });

    test('seam.invalidate() and seam.invalidate(stitch) evict on a get/set-only store', async () => {
        const { adapter, calls } = counting();
        const api = seam({
            baseUrl: 'https://api.test',
            adapter,
            trace: false,
            store: getSetOnly(),
        });
        const users = api.stitch({
            path: '/users',
            cache: { ttl: '60s', tenancy: 'app' },
        });
        const orders = api.stitch({
            path: '/orders',
            cache: { ttl: '60s', tenancy: 'app' },
        });
        await users();
        await orders();
        expect(calls()).toBe(2);

        await api.invalidate(users); // per-stitch generation
        await users();
        await orders();
        expect(calls()).toBe(3);

        await api.invalidate(); // cache-wide generation
        await users();
        await orders();
        expect(calls()).toBe(5);
    });

    test('every bump writes a fresh generation with set — never the previous value', async () => {
        const store = getSetOnly();
        const seen = new Set<unknown>();
        for (let i = 0; i < 20; i++) {
            await bumpCacheGeneration(store);
            seen.add(await store.get('cache:gen'));
        }
        expect(seen.size).toBe(20);
        for (const g of seen) expect(Number.isSafeInteger(g)).toBe(true);
    });

    test('a generation a counter wrote before keeps its prefix — nothing is stranded', async () => {
        // A store that was bumped by the counter-era `increment` holds plain small integers. The
        // read side folds the number into the key as-is, so entries written under it stay
        // reachable until the next bump, which moves them like any other.
        const base = memoryStore();
        await base.set('cache:gen', 3);
        const keys: string[] = [];
        const store: StitchStore = {
            get: (k) => base.get(k),
            set: (k, v, ttl) => {
                keys.push(k);
                return base.set(k, v, ttl);
            },
        };
        const { adapter, calls } = counting();
        const s = stitch({
            name: 'legacy',
            url: 'https://api.test/r',
            adapter,
            trace: false,
            store,
            cache: { ttl: '60s', tenancy: 'app' },
        });
        await s();
        await s();
        expect(calls()).toBe(1);
        expect(keys.some((k) => k.includes(':g3.0.legacy.'))).toBe(true);

        await s.cache.invalidate();
        await s();
        expect(calls()).toBe(2);
    });
});

describe('throttle rate — reserve, else increment, else in-process', () => {
    test('a get/set-only store paces each process on its own cursor', async () => {
        // Two throttles over one store stand in for two workers. With no shared verb there is
        // nothing to pace the pair against each other: each keeps the declared 500ms spacing, so
        // the fleet emits 2× — the documented per-process residue, not a burst.
        const clock = manualClock(0);
        const store = getSetOnly();
        const ts = [0, 1].map(() =>
            createStoreThrottle({ rate: '2/s' }, store, clock),
        );
        const at: { p: number; t: number }[] = [];
        const all: Promise<void>[] = [];
        for (let i = 0; i < 3; i++)
            for (const p of [0, 1])
                all.push(
                    ts[p]!.acquire('k').then(() => {
                        at.push({ p, t: clock.now() });
                    }),
                );
        await clock.advance(10_000);
        await Promise.all(all);
        for (const p of [0, 1])
            expect(at.filter((x) => x.p === p).map((x) => x.t)).toEqual([
                0, 500, 1000,
            ]);
    });

    test('the cursor survives an idle release, so the next acquire does not burst', async () => {
        const clock = manualClock(0);
        const t = createStoreThrottle(
            { rate: '2/s', concurrency: 1 },
            getSetOnly(),
            clock,
        );
        const first = t.acquire('k');
        await clock.advance(0);
        await first;
        t.release('k'); // idle: nothing in flight, nobody queued
        const second = t.acquire('k');
        await clock.advance(500);
        expect((await second).waited).toBe(500);
    });

    test('the in-process fallback announces itself exactly once', async () => {
        const clock = manualClock(0);
        const t = createStoreThrottle({ rate: '1000/s' }, getSetOnly(), clock);
        const results = [];
        for (let i = 0; i < 4; i++) {
            const p = t.acquire('k');
            await clock.advance(10);
            results.push(await p);
        }
        const withNote = results.filter((r) => r.note);
        expect(withNote).toHaveLength(1);
        expect(results[0]!.note).toBe(
            'rate: the store has no reserve or increment',
        );
    });

    // Two stitches, two calls each, on one host: the in-process limiter pools them through its
    // module-level host registry, so attaching a get/set-only store (say, for caching) must not
    // change that. Each test owns a host so the registry never carries a cursor between tests.
    const grantTimes = async (
        host: string,
        pool: 'host' | 'stitch',
    ): Promise<number[]> => {
        const clock = manualClock(0);
        const at: number[] = [];
        const adapter: Adapter = async () => {
            at.push(clock.now());
            return { status: 200, headers: {}, body: {} };
        };
        const make = () =>
            stitch({
                url: `https://${host}/r`,
                adapter,
                trace: false,
                clock,
                store: getSetOnly(),
                throttle: { rate: '4/s', pool },
            });
        const [a, b] = [make(), make()];
        const all = [a.safe(), b.safe(), a.safe(), b.safe()];
        await clock.advance(10_000);
        await Promise.all(all);
        return at.sort((x, y) => x - y);
    };

    test('`pool: "host"` still pools across stitches on a get/set-only store', async () => {
        expect(await grantTimes('pooled-gs.test', 'host')).toEqual([
            0, 250, 500, 750,
        ]);
    });

    test('without `pool: "host"` each stitch paces on its own — the control', async () => {
        expect(await grantTimes('unpooled-gs.test', 'stitch')).toEqual([
            0, 0, 250, 250,
        ]);
    });

    test('`pool: "host"` pools a get/set-only stitch with a store-less one', async () => {
        // One registry, one budget: the store only decides which limiter runs, not whose cursor.
        const clock = manualClock(0);
        const at: number[] = [];
        const adapter: Adapter = async () => {
            at.push(clock.now());
            return { status: 200, headers: {}, body: {} };
        };
        const throttle = { rate: '4/s', pool: 'host' } as const;
        const url = 'https://mixed-gs.test/r';
        const withStore = stitch({
            url,
            adapter,
            trace: false,
            clock,
            store: getSetOnly(),
            throttle,
        });
        const bare = stitch({ url, adapter, trace: false, clock, throttle });
        const all = [
            withStore.safe(),
            bare.safe(),
            withStore.safe(),
            bare.safe(),
        ];
        await clock.advance(10_000);
        await Promise.all(all);
        expect(at.sort((x, y) => x - y)).toEqual([0, 250, 500, 750]);
    });

    test('with only `increment`, the counter fallback paces — and says nothing', async () => {
        const clock = manualClock(0);
        const store = withCounter();
        const t = createStoreThrottle({ rate: '2/s' }, store, clock);
        const at: number[] = [];
        const said: string[] = [];
        const all = [0, 1, 2].map(() =>
            t.acquire('k').then((r) => {
                at.push(clock.now());
                if (r.note) said.push(r.note);
            }),
        );
        await clock.advance(10_000);
        await Promise.all(all);
        expect(store.increments()).toBe(3); // every grant drew a shared slot
        expect(at).toEqual([0, 500, 1000]);
        expect(said).toEqual([]); // fleet-shared slots: nothing to announce
    });

    test('with `reserve`, neither fallback runs and nothing is announced', async () => {
        const clock = manualClock(0);
        const t = createStoreThrottle(
            { rate: '2/s', concurrency: 2 },
            memoryStore(),
            clock,
        );
        const p = t.acquire('k');
        await clock.advance(0);
        expect((await p).note).toBe('');
    });
});

describe('the one signal for both limits — `throttle.per-process`', () => {
    test('concurrency without the lease pair announces itself the same way', async () => {
        const t = createStoreThrottle({ concurrency: 2 }, withCounter());
        const first = await t.acquire('k');
        expect(first.note).toBe('concurrency: the store has no lease/release');
        t.release('k');
        expect((await t.acquire('k')).note).toBe('');
    });

    test('both limits degraded → one note naming both', async () => {
        const t = createStoreThrottle(
            { rate: '1000/s', concurrency: 2 },
            getSetOnly(),
        );
        expect((await t.acquire('k')).note).toBe(
            'rate: the store has no reserve or increment; ' +
                'concurrency: the store has no lease/release',
        );
    });

    test('a chain keeps every gate’s note', async () => {
        const gate = (note: string): Throttle => {
            let pending = note;
            return {
                acquire: async () => {
                    const r = { waited: 0, note: pending };
                    pending = '';
                    return r;
                },
                release: () => undefined,
            };
        };
        const chain = chainThrottle([gate('a'), gate(''), gate('b')]);
        expect((await chain.acquire('k')).note).toBe('a; b');
        expect((await chain.acquire('k')).note).toBe('');
    });

    test('a stitch emits the info event once, on its first run only', async () => {
        const { adapter } = counting();
        const s = stitch({
            url: 'https://api.test/r',
            adapter,
            trace: false,
            store: getSetOnly(),
            throttle: '1000/s',
        });
        const first = notes(await drain(s.stream()));
        const later = notes([
            ...(await drain(s.stream())),
            ...(await drain(s.stream())),
        ]);
        expect(first).toHaveLength(1);
        expect(first[0]!.detail).toBe(
            'rate: the store has no reserve or increment',
        );
        expect(later).toHaveLength(0);
    });

    test('a default seam (memoryStore) is fleet-capable and stays silent', async () => {
        const { adapter } = counting();
        const api = seam({
            baseUrl: 'https://api.test',
            adapter,
            trace: false,
            throttle: { rate: '1000/s', concurrency: 2 },
        });
        const s = api.stitch('/r');
        expect(notes(await drain(s.stream()))).toHaveLength(0);
    });
});

describe('views report the backend’s real capability', () => {
    test('vaultView over a get/set-only backend has no increment', () => {
        const view = vaultView(getSetOnly());
        expect('increment' in view).toBe(false);
        expect('reserve' in view).toBe(false);
        expect('lease' in view).toBe(false);
    });

    test('vaultView forwards increment, prefixed, when the backend has it', async () => {
        const backend = memoryStore();
        const view = vaultView(backend);
        expect(await view.increment!('n', 1000)).toBe(1);
        expect(await backend.get('vault:n')).toBe(1);
    });
});
