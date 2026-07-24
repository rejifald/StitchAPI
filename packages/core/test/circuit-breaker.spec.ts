// Circuit breaker: after N consecutive failures the breaker OPENS and calls fast-fail
// without touching the network (proven by an unchanged server hit-count) while emitting a
// `circuit` event; after the cooldown it goes HALF-OPEN and a trial request can recover it.
import { stitch } from '../src';
import type { StitchEvent } from '../src';
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

test('the @deprecated failureThreshold alias still trips the breaker (P4)', async () => {
    server.route('GET', '/svc', {
        statuses: [500, 500, 200],
        body: { ok: true },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/svc',
        // Pre-rename spelling — must behave identically to `failures` until the GA cut.
        circuit: { failureThreshold: 2, cooldown: 300 },
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
