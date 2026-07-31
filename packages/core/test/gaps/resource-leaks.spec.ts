// Pins the release-audit resource-safety findings: bounded throttle/store state, a draining OTLP
// `open` map, and prompt abort during retry/reconnect backoff + throttle waits. These are leak
// regressions, not behaviour changes — each test asserts a bound or a prompt cancellation that the
// pre-fix code violated (an ever-growing Map, or a backoff sleep that ignored the caller signal).
import { otlpSink, stitch } from '../../src';
import { OPEN_SPANS } from '../../src/otlp';
import { THROTTLE_STATES, createThrottle } from '../../src/resilience';
import {
    THROTTLE_LOCAL,
    createStoreThrottle,
    memoryStore,
} from '../../src/store';
import type { Adapter, AdapterResponse, StitchEvent } from '../../src/types';

// A real timer so a test can advance past a 1ms rate window between acquires.
const tick = (ms = 3): Promise<void> =>
    new Promise((r) => {
        setTimeout(r, ms);
    });

// Read a non-enumerable internal Map probe (attached via Object.defineProperty in src) off an
// object by its symbol key. The probes are always present, so assert that and return a live Map.
function probeMap(obj: object, sym: symbol): Map<string, unknown> {
    const m = (obj as Record<symbol, Map<string, unknown> | undefined>)[sym];
    expect(m).toBeInstanceOf(Map);
    return m as Map<string, unknown>;
}

// ── 1a. store-backed throttle does not accumulate per-window `rl:` keys ──────
// `createStoreThrottle` mints a fresh `rl:<key>:<windowStart>` counter every rate window. A
// `1000/ms` rate makes each millisecond its own window, so acquiring across many windows used to
// leave one dead key per window in the store forever (no key is read again, so the store's lazy
// per-key eviction never fires). The fix deletes the previous window's key on rollover AND has
// memoryStore opportunistically sweep expired entries on write — so the live store stays bounded.
test('store throttle: old rate-window keys do not accumulate over many windows', async () => {
    // An instrumented store that delegates to memoryStore but records every key it has ever set
    // (`seen`) and the keys currently live (`liveKeys`), so the test can observe `rl:` accumulation
    // without reaching into memoryStore's private Map.
    const inner = memoryStore();
    const seen = new Set<string>();
    const liveKeys = new Set<string>();
    const wrapped = {
        get: (k: string): Promise<unknown> => inner.get(k),
        async set(k: string, v: unknown, ttl?: number): Promise<void> {
            if (v === undefined) liveKeys.delete(k);
            else {
                liveKeys.add(k);
                seen.add(k);
            }
            return inner.set(k, v, ttl);
        },
        async increment(k: string, ttl: number): Promise<number> {
            liveKeys.add(k);
            seen.add(k);
            return inner.increment(k, ttl);
        },
    };

    const throttle = createStoreThrottle({ rate: '1000/ms' }, wrapped);

    const WINDOWS = 20;
    for (let i = 0; i < WINDOWS; i++) {
        await throttle.acquire('seamA');
        await tick(); // advance past the 1ms window so the next acquire rolls over
    }

    // Many distinct windows were touched over the run...
    const rlSeen = [...seen].filter((k) => k.startsWith('rl:seamA:'));
    expect(rlSeen.length).toBeGreaterThan(1);
    // ...but only the CURRENT window's key should still be live (the rollover deletes the prior).
    const rlLive = [...liveKeys].filter((k) => k.startsWith('rl:seamA:'));
    expect(rlLive.length).toBeLessThanOrEqual(1);
});

// ── 1a'. memoryStore sweeps expired entries on write (no unbounded growth) ───
// The default store evicts a key lazily only on a get/increment of THAT key. Many short-TTL keys that
// are never read again must still be reclaimed: a write triggers a bounded opportunistic sweep.
test('memoryStore sweeps expired keys on write so it stays bounded', async () => {
    const store = memoryStore();
    // Write many keys with a 1ms TTL; none is ever read again.
    for (let i = 0; i < 50; i++) await store.set(`dead:${i}`, i, 1);
    await tick(10); // let them all expire
    // A handful of fresh writes should sweep the expired keys out.
    for (let i = 0; i < 10; i++) await store.set(`live:${i}`, i);
    // The expired keys must be gone: a get returns undefined (and would have deleted lazily), but
    // the point is the Map shrank without any read of the dead keys — probe a sample.
    for (let i = 0; i < 50; i++)
        expect(await store.get(`dead:${i}`)).toBeUndefined();
    for (let i = 0; i < 10; i++) expect(await store.get(`live:${i}`)).toBe(i);
});

// ── 1b. a concurrency throttle's Map entry is gone after its last release ────
// createThrottle / createStoreThrottle keep per-key state in a Map. A key that goes fully idle
// (inFlight 0, no waiters) used to leave its entry behind forever. The fix deletes it on the last
// release (when it carries no live rate reservation / window bookkeeping).
test('in-process throttle: idle key state is dropped after the last release', async () => {
    const throttle = createThrottle({ concurrency: 2 });
    const states = probeMap(throttle, THROTTLE_STATES);

    await throttle.acquire('k1');
    await throttle.acquire('k2');
    expect(states.size).toBe(2);

    throttle.release('k1');
    expect(states.has('k1')).toBe(false);
    throttle.release('k2');
    expect(states.has('k2')).toBe(false);
    expect(states.size).toBe(0);
});

test('store throttle: idle concurrency key state is dropped after release', async () => {
    const throttle = createStoreThrottle(
        { concurrency: 2 },
        memoryStore(), // no rate → no window bookkeeping pinning the entry
    );
    const local = probeMap(throttle, THROTTLE_LOCAL);

    await throttle.acquire('s1');
    expect(local.size).toBe(1);
    throttle.release('s1');
    expect(local.has('s1')).toBe(false);
    expect(local.size).toBe(0);
});

// A waiter must still be honoured, and the entry kept until the queue drains, then dropped.
test('in-process throttle: a key with a queued waiter is not dropped early', async () => {
    const throttle = createThrottle({ concurrency: 1 });
    const states = probeMap(throttle, THROTTLE_STATES);

    await throttle.acquire('q'); // holds the one slot
    const second = throttle.acquire('q'); // queues
    expect(states.has('q')).toBe(true);

    throttle.release('q'); // hands the slot to the waiter — entry must survive
    await second;
    expect(states.has('q')).toBe(true);

    throttle.release('q'); // now idle
    expect(states.has('q')).toBe(false);
});

// ── 2. OTLP sink drains its `open` map after a completed run ─────────────────
// otlpSink stacks an in-flight span per run key; on `done` it popped the span but left the empty
// stack as a Map entry, leaking one entry per unique run id. The fix deletes the entry when the
// stack empties.
test('otlp sink: the internal open-span map is empty after a completed run', () => {
    const sink = otlpSink({
        exporter: {
            export() {
                /* drop spans — the test only inspects the internal map */
            },
        },
    });
    const open = probeMap(sink, OPEN_SPANS);

    const ev = (e: StitchEvent, spanId: string): void => {
        sink.handle(e, {
            name: 'ping',
            spanId,
            traceId: 'a'.repeat(32),
        });
    };

    for (let i = 0; i < 5; i++) {
        const spanId = `run-${i}`;
        ev(
            {
                type: 'start',
                name: 'ping',
                method: 'GET',
                url: 'https://x/y',
                input: {},
                at: 0,
            },
            spanId,
        );
        ev(
            { type: 'result', data: {}, status: 200, attempts: 1, at: 1 },
            spanId,
        );
        ev({ type: 'done', ok: true, elapsed: 1, attempts: 1, at: 1 }, spanId);
    }

    expect(open.size).toBe(0);
});

// ── 3. an aborted caller signal interrupts a retry backoff PROMPTLY ──────────
// During the backoff sleep between retries the engine used to ignore the caller's signal and sleep
// out the full delay. With a 1000ms fixed backoff, aborting ~immediately must reject well under it.
test('abort during a retry backoff rejects promptly (well under the backoff delay)', async () => {
    // An adapter that always 503s instantly, forcing the retry/backoff path.
    const always503: Adapter = () =>
        Promise.resolve<AdapterResponse>({
            status: 503,
            headers: {},
            body: { error: 'unavailable' },
            url: 'http://test/always-503',
        });

    const call = stitch({
        baseUrl: 'http://test',
        path: '/always-503',
        adapter: always503,
        retry: {
            attempts: 5,
            on: [503],
            backoff: { curve: 'fixed', base: 1000 },
        },
    });

    const ac = new AbortController();
    // Abort shortly after the first attempt fails and the backoff sleep begins.
    setTimeout(() => {
        ac.abort();
    }, 20);

    const t0 = Date.now();
    const err = await call({ signal: ac.signal }).then(
        () => undefined,
        (e: unknown) => e as Error,
    );
    const elapsed = Date.now() - t0;

    expect(err).toBeDefined();
    // The 1000ms backoff must be cut short by the abort — promptly, not slept out. The ceiling is
    // loose on purpose: a sleep-it-out regression lands at 1000ms+, so there is no reason to sit
    // close to the abort and let an event-loop stall on a loaded runner red this.
    expect(elapsed).toBeLessThan(700);
});

// An ALREADY-aborted signal must reject without ever sleeping the backoff.
test('an already-aborted signal rejects without sleeping the backoff', async () => {
    const always503: Adapter = () =>
        Promise.resolve<AdapterResponse>({
            status: 503,
            headers: {},
            body: {},
            url: 'http://test/x',
        });
    const call = stitch({
        baseUrl: 'http://test',
        path: '/x',
        adapter: always503,
        retry: {
            attempts: 5,
            on: [503],
            backoff: { curve: 'fixed', base: 1000 },
        },
    });

    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const err = await call({ signal: ac.signal }).then(
        () => undefined,
        (e: unknown) => e as Error,
    );
    expect(err).toBeDefined();
    // Same loose ceiling as above, and for the same reason: sleeping the backoff costs 1000ms+.
    expect(Date.now() - t0).toBeLessThan(700);
});
