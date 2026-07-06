// Pins P7 (download-test-rig-spec §2.8): multi-host fairness — a SATURATED host must not stall an
// INDEPENDENT host's schedule. `pool:'host'` keys the budget by URL host, so two mock servers on
// different ephemeral ports are two distinct hosts with two independent budgets (the same mechanism
// download-redirect-cross-origin.spec.ts uses for a cross-origin pair). A batch that spans hosts must
// let each host make progress at its own pace; host A being pinned at its cap can't starve host B.
//
// Setup: host A is deliberately throttled to concurrency 1 and given M slow items → it drains SERIALLY.
// Host B has concurrency 2 and a couple of items → it runs them concurrently. All are fired together.
// The oracles are COUNTS + ordering (robust), not a wall-clock gap:
//   • B finishes while A is still draining  → A.callCount() < M at the moment B is done (B was not
//     stuck behind A's saturated queue).
//   • B genuinely ran its own concurrency    → B.maxOpen() reaches 2.
//   • A really was capped at 1               → A.maxOpen() === 1.
// Real-timer, LOOSE bounds: A's serial drain (M×150ms) dwarfs B's (~150ms), a wide margin; held
// sockets are destroyed at teardown on BOTH servers.
//
// Deferred (batch-orchestrator scope): aggregate cross-host progress/ETA (P8) and priority/fair
// SCHEDULING across hosts (P21, which core `throttle` has no knob for) — this pins only that the two
// hosts' budgets are independent, the substrate any cross-host scheduler builds on.
import { download } from '../../src/download';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

let a: MockServer; // the saturated host (concurrency 1)
let b: MockServer; // the independent host that must not be stalled
beforeAll(async () => {
    a = await startMockServer();
    b = await startMockServer();
});
afterAll(async () => {
    await Promise.all([a.close(), b.close()]);
});
beforeEach(() => {
    a.reset();
    b.reset();
});

const blobText = async (blob: Blob): Promise<string> =>
    new TextDecoder().decode(await blob.arrayBuffer());

test('a saturated host does not stall an independent host’s schedule (per-host budgets)', async () => {
    const M = 4; // host A items — drained one at a time (concurrency 1)
    const aPaths = Array.from({ length: M }, (_, i) => `/a-${i}`);
    const bPaths = ['/b-0', '/b-1'];

    // Distinct ephemeral ports ⇒ two real, independent hosts under pool:'host'.
    expect(new URL(a.url).port).not.toBe(new URL(b.url).port);

    for (const p of aPaths)
        a.route('GET', p, {
            statuses: [200],
            rawBody: `A${p}`,
            ttfbDelay: 150, // each A item holds its single slot ~150ms → serial ~600ms total
        });
    for (const p of bPaths)
        b.route('GET', p, {
            statuses: [200],
            rawBody: `B${p}`,
            ttfbDelay: 50, // B is fast — it finishes well before A drains, a wide margin
        });

    const aRuns = aPaths.map((p) =>
        download({
            baseUrl: a.url,
            path: p,
            throttle: { concurrency: 1, pool: 'host' }, // A: saturated, serial
            retry: { attempts: 1 },
        })(),
    );
    const bRuns = bPaths.map((p) =>
        download({
            baseUrl: b.url,
            path: p,
            throttle: { concurrency: 2, pool: 'host' }, // B: its own budget, unaffected by A
            retry: { attempts: 1 },
        })(),
    );

    // StitchResults are COLD — they start on subscribe, not on creation. Launch A NOW (concurrently
    // with B) by subscribing via `allSettled`, and keep the promise to await after we've measured —
    // otherwise A would not even start until we awaited it, and the probe would read an idle host A.
    const aDone = Promise.allSettled(aRuns);

    // B completes on its OWN schedule — it does not wait behind A's saturated queue. (Reaching here
    // means neither B call rejected — `Promise.all` would have thrown otherwise.)
    const bResults = await Promise.all(bRuns);
    expect(bResults).toHaveLength(2);
    expect(await blobText(bResults[0]!.blob)).toBe(`B${bPaths[0]!}`);
    expect(await blobText(bResults[1]!.blob)).toBe(`B${bPaths[1]!}`);

    // At the instant B is done, A is STILL draining — proof B was never stalled behind A.
    expect(a.callCount()).toBeLessThan(M);
    // B genuinely ran its two downloads concurrently (its budget, not throttled down by A).
    expect(b.maxOpen()).toBe(2);
    // …and A really was pinned at its cap of 1 the whole time (the saturation was real).
    expect(a.maxOpen()).toBe(1);

    // Let A finish so teardown is clean; every A item still downloads correctly once its turn comes.
    const aSettled = await aDone;
    expect(aSettled.map((s) => s.status)).toEqual(Array(M).fill('fulfilled'));
    for (let i = 0; i < M; i++) {
        const r = aSettled[i] as PromiseFulfilledResult<{ blob: Blob }>;
        expect(await blobText(r.value.blob)).toBe(`A${aPaths[i]!}`);
    }
    expect(a.maxOpen()).toBe(1); // never exceeded its cap across the whole drain
});
