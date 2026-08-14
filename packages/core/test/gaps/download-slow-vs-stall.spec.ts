// Pins (THE FINDING): a HEALTHY-but-slow download — one whose bytes keep arriving, just slowly — is
// killed by the SAME wall-clock `timeout` as a dead stall. The engine's `TimeoutOptions` is
// `{ total, perAttempt }`, BOTH wall-clock (types.ts:317); there is NO idle / forward-progress /
// no-bytes-for-N-ms timeout. So once total elapsed exceeds the budget, the call rejects even though
// the transfer was making steady forward progress the whole time — indistinguishable, to the engine,
// from a socket that stalled at byte 0.
//
// This test proves the body was HEALTHY (progressing), not stalled, by threading an `onProgress`
// callback: it records a strictly-increasing `loaded` across several chunks BEFORE the timeout
// reject. A stall (download-stall.spec.ts) would show `loaded` frozen; here it climbs, then the call
// still fails — that is the finding.
//
// DESIGN FINDING, NOT A BUG TO FIX NOW: this motivates an IDLE / forward-progress timeout — one that
// resets its countdown on each `onProgress` chunk, so a slow-but-progressing transfer is allowed to
// continue while only a genuine no-bytes stall trips it. The engine lacks that today (only wall-clock
// total/perAttempt). A future `@stitchapi/download` should add an idle-timeout option layered on the
// `onProgress` byte stream. No `src/` change is made here — this pins present behavior and documents
// the gap.
//
// DRIVEN, NOT RACED (why this one is not a loose real-timer test like its download siblings): the
// two halves of the finding — "several chunks arrived" and "the budget fired anyway" — used to race
// each other on the wall clock, chunk cadence tuned to land inside the budget. Under a full parallel
// suite the budget could win before the second chunk was read, tripping `seen.length > 1`. Both
// halves are now driven:
//   • the transport stays REAL — a real socket, a real chunked body, undici's reader and the real
//     `readWithProgress` (http-adapter.ts) — but the fixture's `chunkForever` trickle NEVER ends, so
//     the call cannot resolve out from under the test however slowly the chunks arrive. The test
//     WAITS for real progress instead of assuming it landed in time;
//   • the budget rides an injected `manualClock` (ADR 0010): with one attempt, `timeout.total` IS
//     this attempt's abort (engine.ts clamps `attemptMs` to what's left of the budget), and
//     `withTimeout` arms that abort on `clock.setTimer` — so it fires exactly when this test spends
//     it, and only AFTER real bytes have been observed. (Per ADR 0010 the budget's DEADLINE
//     arithmetic stays wall-clock; what the clock drives is the countdown it is clamped into.)
// The guarantee is unchanged, and sharper: real bytes arrived, the countdown was never re-armed by
// them (exactly ONE pending timer throughout), and spending the budget still killed a live transfer.
import { download } from '../../src/download';
import { manualClock } from '../../src/test-clock';
import type { AdapterProgress } from '../../src/types';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

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

// Poll a real condition (real bytes landing off a real socket) up to a ceiling — an event-wait, not
// a timing measure: it waits as long as a loaded machine needs, and fails LOUDLY if the bytes never
// come. Same helper, and same reason, as download-retry-after.spec.ts.
const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > ms)
            throw new Error(`until: condition not met within ${ms}ms`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

const BUDGET = 400; // the whole wall-clock budget for the call — spent by hand, on the manual clock
const CHUNKS_BEFORE_KILL = 3; // real chunks that must land off the socket before we spend it

// A steady 8-bytes-per-chunk trickle that never finishes (`chunkForever` wraps the 64-byte body), so
// the transfer is still HEALTHY — bytes arriving — at the instant the budget is spent. The
// wall-clock timeout kills it anyway; `onProgress` proves the progress was real before the reject.
test('a healthy-but-slow (steadily progressing) download is killed by the same wall-clock timeout as a stall', async () => {
    const clock = manualClock();
    server.route('GET', '/trickle', {
        statuses: [200],
        rawBody:
            'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ012', // 64 bytes
        chunkBytes: 8, // 8 bytes per chunk…
        chunkDelay: 20, // …every 20ms — a steady trickle…
        chunkForever: true, // …that never completes: only the timeout below can end this call
    });

    const seen: AdapterProgress[] = [];
    let settled = false;
    const getTrickle = download({
        baseUrl: server.url,
        path: '/trickle',
        timeout: BUDGET, // ≡ { total: 400 } — wall-clock; no idle/progress timeout exists
        retry: { attempts: 1 }, // one attempt → the total budget IS this attempt's abort…
        clock, // …which `withTimeout` arms on this clock, so the test spends it by hand
    });

    const started = Date.now();
    const outcome = getTrickle({
        onProgress: (p) => {
            seen.push(p);
        },
    }).then(
        () => {
            settled = true;
            throw new Error(
                'slow-but-progressing download unexpectedly resolved',
            );
        },
        (e: unknown) => {
            settled = true;
            return e;
        },
    );

    // Wait for REAL forward progress off the socket. Virtual time is frozen while we wait, so the
    // budget cannot fire underneath us — this is a synchronization point, not a race.
    await until(() => seen.length >= CHUNKS_BEFORE_KILL);
    const beforeKill = seen.length;

    // The transfer is healthy right now: bytes have been arriving and the call is still in flight…
    expect(settled).toBe(false);
    // …and the countdown was armed ONCE, at attempt start, and NOT re-armed by any of those chunks —
    // exactly one pending timer. That missing per-chunk re-arm IS the absent idle/forward-progress
    // timeout this test documents.
    expect(clock.pending()).toBe(1);

    // Spend the budget. Nothing else changed — the body is still trickling — and it dies anyway.
    await clock.advance(BUDGET);
    const err = await outcome;
    const elapsed = Date.now() - started;

    // It REJECTED (the wall-clock budget fired) and was cut by the timeout — not resolved.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timeout|timed out|abort|aborted/i);
    expect(elapsed).toBeLessThan(5000); // real time: the call never hangs past its virtual budget
    expect(clock.pending()).toBe(0); // the budget's timer fired; nothing leaked

    // …and it was HEALTHY, not stalled: progress fired and `loaded` climbed across chunks BEFORE the
    // reject. This is the evidence that a *progressing* transfer — not a dead one — was killed by the
    // wall-clock timeout, which is exactly the finding an idle/forward-progress timeout would fix.
    expect(beforeKill).toBeGreaterThan(1);
    expect(seen.every((p) => p.direction === 'download')).toBe(true);
    const loaded = seen.map((p) => p.loaded);
    const lastLoaded = loaded[loaded.length - 1] ?? 0;
    const firstLoaded = loaded[0] ?? 0;
    expect(lastLoaded).toBeGreaterThan(firstLoaded); // strictly increasing → real forward progress
    // Non-decreasing throughout (a chunked read only ever adds bytes).
    for (let i = 1; i < loaded.length; i++)
        expect(loaded[i]!).toBeGreaterThanOrEqual(loaded[i - 1]!);
});
