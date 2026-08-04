// Circuit breaker: after N consecutive failures the breaker OPENS and calls fast-fail
// without touching the network (proven by an unchanged server hit-count) while emitting a
// `circuit` event; after the cooldown it goes HALF-OPEN and a trial request can recover it.
import { memoryStore, stitch } from '../src';
import type { StitchEvent } from '../src';
import { createCircuit } from '../src/resilience';
import { manualClock, mockAdapter } from '../src/testing';
import type { CircuitOptions } from '../src/types';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-circuit-${process.pid}.jsonl`,
);

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const collect = async (s: {
    stream(): AsyncGenerator<StitchEvent>;
}): Promise<StitchEvent[]> => {
    const events: StitchEvent[] = [];
    for await (const ev of s.stream()) events.push(ev);
    return events;
};

test('opens after N consecutive failures, fast-fails without hitting the server, then recovers', async () => {
    // 3×500 then 200. Fast-failed calls never reach the server, so the status sequence
    // only advances on REAL hits — the 4th real hit (recovery) gets the 200.
    server.route('GET', '/svc', {
        statuses: [500, 500, 500, 200],
        body: { ok: true },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/svc',
        // default retry attempts = 1, so each call is exactly one server hit = one failure.
        circuit: { failures: 3, cooldown: 300 },
    });

    // Three failing calls trip the breaker.
    for (let i = 0; i < 3; i++) await expect(call()).rejects.toBeDefined();
    expect(server.callCount('/svc')).toBe(3);

    // 4th call: breaker OPEN → fast-fail. A `circuit` event fires, an error is emitted,
    // and the server is NOT hit.
    const events = await collect(call());
    expect(
        events.some((e) => e.type === 'progress' && e.phase === 'circuit'),
    ).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(server.callCount('/svc')).toBe(3); // unchanged — no network during cooldown

    // The await form fast-fails too (503), still without a server hit.
    await expect(call()).rejects.toMatchObject({ status: 503 });
    expect(server.callCount('/svc')).toBe(3);

    // Wait out the cooldown → HALF-OPEN. The trial reaches the server (now 200) → closes.
    await sleep(350);
    await expect(call()).resolves.toEqual({ ok: true });
    expect(server.callCount('/svc')).toBe(4); // the trial request hit the server
});

test('a success resets the consecutive-failure count', async () => {
    // fail, fail, succeed, fail, fail — never 3 failures in a row, so it never opens
    // and every call reaches the server (none is fast-failed).
    server.route('GET', '/svc', {
        statuses: [500, 500, 200, 500, 500],
        body: { ok: true },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/svc',
        circuit: { failures: 3, cooldown: 300 },
    });

    await expect(call()).rejects.toBeDefined(); // failures = 1
    await expect(call()).rejects.toBeDefined(); // failures = 2
    await expect(call()).resolves.toEqual({ ok: true }); // success → reset to 0
    await expect(call()).rejects.toBeDefined(); // failures = 1
    await expect(call()).rejects.toBeDefined(); // failures = 2

    expect(server.callCount('/svc')).toBe(5); // all 5 hit the server → breaker never opened
});

test('the positional [failures, cooldown] shorthand trips the breaker (P15)', async () => {
    server.route('GET', '/svc', {
        statuses: [500, 500, 200],
        body: { ok: true },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/svc',
        // `[2, 300]` ≡ `{ failures: 2, cooldown: 300 }` — compose expands the tuple.
        circuit: [2, 300],
    });

    for (let i = 0; i < 2; i++) await expect(call()).rejects.toBeDefined();
    expect(server.callCount('/svc')).toBe(2);
    // 3rd call: breaker OPEN → fast-fail, server NOT hit.
    await collect(call());
    expect(server.callCount('/svc')).toBe(2);
});

test('cooldown accepts a duration string (P17 widening)', async () => {
    const call = stitch({
        baseUrl: server.url,
        path: '/svc',
        circuit: { failures: 1, cooldown: '50ms' },
    });
    server.route('GET', '/svc', { statuses: [500], body: {} });
    await expect(call()).rejects.toBeDefined(); // opens immediately (failures: 1)
    await collect(call()); // fast-fail
    expect(server.callCount('/svc')).toBe(1);
});

// The stored record keeps "has it tripped" as its own flag instead of overloading a timestamp
// value. The regression: `openedAt: 0` used to double as the closed sentinel, so a breaker that
// opened at clock time 0 read back as CLOSED and never fast-failed. Unreachable on the system clock
// (epoch 0 is 1970) but the default seed of `manualClock()` (ADR 0010) — i.e. it broke exactly the
// tool the repo ships for testing time-driven behaviour, which is why no clock seeding is needed
// anywhere in this file.
describe('a breaker driven by a default-seeded manualClock (ADR 0010)', () => {
    test('trips at clock time 0, fast-fails, and recovers after the cooldown', async () => {
        const clock = manualClock(); // starts at 0 — the old closed sentinel
        const api = mockAdapter({
            match: '/svc',
            // 2 failures trip it; the half-open trial (the only later request that reaches the
            // adapter) gets the 200.
            respond: [{ status: 500 }, { status: 500 }, { body: { ok: true } }],
        });
        const call = stitch({
            baseUrl: 'https://api.test',
            path: '/svc',
            adapter: api,
            circuit: { failures: 2, cooldown: 30_000 },
            clock,
        });

        // Two failures at virtual time 0 open the breaker — it records `openedAt: 0`.
        await expect(call()).rejects.toBeDefined();
        await expect(call()).rejects.toBeDefined();
        expect(api.callCount()).toBe(2);

        // OPEN → fast-fail (503) without touching the adapter. Before the fix this call sailed
        // through to the transport, because `openedAt: 0` read back as closed.
        await expect(call()).rejects.toMatchObject({ status: 503 });
        expect(api.callCount()).toBe(2);

        // The cooldown is measured FROM 0, so advancing past it goes half-open: the trial reaches
        // the adapter and closes the breaker.
        await clock.advance(30_000);
        await expect(call()).resolves.toEqual({ ok: true });
        expect(api.callCount()).toBe(3);
    });
});

// The record lives in the StitchStore, so with a shared/durable store (redis, deno-kv,
// cloudflare-kv) it outlives a deploy: the new code has to read records written by the old shape,
// which carried no `tripped` flag and meant "closed" by `openedAt: 0`. A legacy record is
// recognizable structurally (no flag), so folding it in can never swallow a genuine `openedAt: 0`.
describe('records written before the `tripped` flag existed', () => {
    const legacyStore = async (record: unknown) => {
        const store = memoryStore();
        await store.set('circuit:legacy', record); // `circuit.key` pins the namespaced key
        return store;
    };
    const failing = () =>
        mockAdapter({ match: '/svc', respond: { status: 500 } });
    const callWith = (
        store: Awaited<ReturnType<typeof legacyStore>>,
        api: ReturnType<typeof failing>,
    ) =>
        stitch({
            baseUrl: 'https://api.test',
            path: '/svc',
            adapter: api,
            circuit: { key: 'legacy', failures: 3, cooldown: 30_000 },
            store,
            clock: manualClock(1_000),
        });

    test('a legacy CLOSED record (openedAt: 0) still reads as closed, keeping its failure count', async () => {
        const api = failing();
        const call = callWith(
            await legacyStore({ failures: 2, openedAt: 0 }),
            api,
        );

        // Closed with 2 of 3 failures banked: this call must REACH the adapter (a record misread as
        // open would fast-fail here) and be the 3rd failure that opens the breaker.
        await expect(call()).rejects.not.toMatchObject({ status: 503 });
        expect(api.callCount()).toBe(1);

        await expect(call()).rejects.toMatchObject({ status: 503 });
        expect(api.callCount()).toBe(1); // now open — no network
    });

    test('a legacy OPEN record (openedAt: a real timestamp) still reads as open', async () => {
        const api = failing();
        // Opened at the clock's current time, so the cooldown has not elapsed.
        const call = callWith(
            await legacyStore({ failures: 3, openedAt: 1_000 }),
            api,
        );

        await expect(call()).rejects.toMatchObject({ status: 503 });
        expect(api.callCount()).toBe(0); // fast-failed on the legacy record alone
    });
});

test('throws when neither failures nor cooldown is set (required-by-design, P15)', async () => {
    const call = stitch({
        baseUrl: server.url,
        path: '/svc',
        circuit: { key: 'orphan-breaker' },
    });
    await expect(call()).rejects.toThrow(
        /circuit requires `failures` and `cooldown`/,
    );
});

// The open → half-open boundary, pinned to the millisecond on an injected clock (ADR 0010).
// These were the missing tests: `phase()` is the ONLY place the boundary is decided, and until
// now nothing asserted *when* it moves — which is how a second, redundant knob (`halfOpenAfter`,
// removed per CONTRACT.md P1) sat on the surface unnoticed, defaulting to `cooldown` and doing
// nothing else. Driving time directly (rather than sleeping) is what makes the instant assertable.
describe('the open → half-open boundary is `cooldown`, and only `cooldown`', () => {
    test('stays open until `cooldown` elapses, then goes half-open on the exact ms', async () => {
        const clock = manualClock();
        const c = createCircuit(
            { failures: 2, cooldown: '30s' },
            memoryStore(),
            'boundary',
            clock,
        );

        expect(await c.phase()).toBe('closed');
        expect(await c.onFailure()).toBe(false); // 1 of 2 — not yet
        expect(await c.phase()).toBe('closed');
        expect(await c.onFailure()).toBe(true); // 2 of 2 — newly OPEN
        expect(await c.phase()).toBe('open');

        await clock.advance(29_999);
        expect(await c.phase()).toBe('open'); // one ms short — still fast-failing

        await clock.advance(1); // exactly `cooldown`
        expect(await c.phase()).toBe('half-open'); // the trial is admitted here, not later

        await clock.advance(60_000); // and it stays half-open until the trial settles
        expect(await c.phase()).toBe('half-open');
    });

    test('a failed trial re-opens and arms a fresh cooldown from that instant', async () => {
        const clock = manualClock();
        const c = createCircuit(
            { failures: 1, cooldown: 30_000 },
            memoryStore(),
            'reopen',
            clock,
        );

        expect(await c.onFailure()).toBe(true); // opens immediately (failures: 1)
        await clock.advance(30_000);
        expect(await c.phase()).toBe('half-open');

        // The trial fails. Not "newly opened" — it was already open — but the window restarts.
        expect(await c.onFailure()).toBe(false);
        expect(await c.phase()).toBe('open');

        await clock.advance(29_999);
        expect(await c.phase()).toBe('open'); // measured from the re-open, not the first open
        await clock.advance(1);
        expect(await c.phase()).toBe('half-open');
    });

    test('a successful trial closes the breaker and clears the count', async () => {
        const clock = manualClock();
        const c = createCircuit(
            { failures: 1, cooldown: 30_000 },
            memoryStore(),
            'recover',
            clock,
        );

        await c.onFailure();
        await clock.advance(30_000);
        expect(await c.phase()).toBe('half-open');

        await c.onSuccess();
        expect(await c.phase()).toBe('closed');

        // Count cleared: it takes a full `failures` run to trip again, not one more failure.
        expect(await c.onFailure()).toBe(true);
    });

    test('`cooldown` is the one input that moves the boundary', async () => {
        // Same failure history, same clock, different `cooldown` → different instant. This is the
        // assertion the old `halfOpenAfter` could never make: it varied while the phase did not.
        const phaseAt = async (cooldown: number | string, elapsed: number) => {
            const clock = manualClock();
            const c = createCircuit(
                { failures: 1, cooldown },
                memoryStore(),
                'sole-knob',
                clock,
            );
            await c.onFailure();
            await clock.advance(elapsed);
            return c.phase();
        };

        expect(await phaseAt('1s', 999)).toBe('open');
        expect(await phaseAt('1s', 1000)).toBe('half-open');
        expect(await phaseAt('10m', 999)).toBe('open');
        expect(await phaseAt('10m', 1000)).toBe('open'); // still open — the knob moved it
        expect(await phaseAt('10m', 600_000)).toBe('half-open');
    });

    test('`halfOpenAfter` is off the type surface — one boundary, one name (P1)', () => {
        const opts: CircuitOptions = {
            failures: 1,
            cooldown: '30s',
            // @ts-expect-error — `halfOpenAfter` is removed; `cooldown` IS the half-open boundary,
            // so a second knob could only restate it (CONTRACT.md P1, hard break under P19).
            halfOpenAfter: '60s',
        };
        expect(opts.cooldown).toBe('30s');
    });

    // The `circuit:` slot rejects it too, since `NoUnknownNestedKeys` began descending into the
    // house envelopes — when this test was written only the direct annotation above was guarded,
    // and a stale key at the slot compiled clean. The runtime nudge is now the SECOND line of
    // defence rather than the only one: it still fires for JS callers and for anyone who silences
    // the error, which is exactly what the suppression below stands in for.
    test('a stale `halfOpenAfter` warns at construction rather than changing timing in silence', () => {
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        try {
            stitch({
                name: 'orders',
                baseUrl: 'https://api.test',
                path: '/svc',
                // @ts-expect-error — rejected at the slot now; suppressed so the RUNTIME nudge
                // below is still exercised on the shape a JS caller can still hand us.
                circuit: { failures: 1, cooldown: '30s', halfOpenAfter: '60s' },
            });
            expect(warn).toHaveBeenCalledTimes(1);
            const msg = String(warn.mock.calls[0]?.[0]);
            expect(msg).toContain('`orders`');
            expect(msg).toContain('halfOpenAfter');
            expect(msg).toContain('30s'); // the boundary it actually gets now
        } finally {
            warn.mockRestore();
        }
    });

    test('a circuit without the removed key stays quiet', () => {
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        try {
            stitch({
                baseUrl: 'https://api.test',
                path: '/svc',
                circuit: { failures: 1, cooldown: '30s' },
            });
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });
});
