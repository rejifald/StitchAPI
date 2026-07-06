// Pins X10 (S3): a 429 carrying `Retry-After` is honored on the DOWNLOAD path — the retry waits EXACTLY
// the Retry-After delta before re-attempting, then succeeds. Driven on a `manualClock` so the wait is
// virtual-time-exact (deterministic, zero wall-clock): the retry is gated until the clock is advanced
// past the delta. 429 ∈ the default retry set; `respectRetryAfter` routes the wait through the header
// value instead of the computed backoff (resilience.ts `parseRetryAfter`).
import { download } from '../../src/download';
import type { DownloadResult } from '../../src/download';
import { manualClock } from '../../src/test-clock';
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

const blobText = async (b: Blob): Promise<string> =>
    new TextDecoder().decode(await b.arrayBuffer());

// Poll a real condition (a real fetch landing) up to a ceiling — an event-wait, not a timing measure.
const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > ms)
            throw new Error(`until: condition not met within ${ms}ms`);
        await new Promise((r) => setTimeout(r, 5));
    }
};

const FILE = 'RATE-LIMITED-THEN-OK-9876543210';

test('a 429 Retry-After is honored on the download path — the retry waits the delta, then succeeds', async () => {
    const clock = manualClock();
    server.route('GET', '/limited', {
        statuses: [429, 200],
        retryAfterSeconds: 1, // Retry-After: 1 (delta-seconds → 1000ms of virtual wait)
        rawBody: FILE,
    });

    const getLimited = download({
        baseUrl: server.url,
        path: '/limited',
        retry: { attempts: 2, respectRetryAfter: true }, // 429 ∈ default on
        clock,
    });

    // Drive the cold StitchResult in the background; capture its settlement for later.
    let out: DownloadResult | undefined;
    let error: unknown;
    const done = (async () => {
        try {
            out = await getLimited();
        } catch (e) {
            error = e;
        }
    })();

    // Attempt 1 hits the server (429) and schedules the Retry-After wait on the virtual clock.
    await until(
        () => server.callCount('/limited') === 1 && clock.pending() === 1,
    );
    // The retry is GATED on virtual time — it has NOT re-attempted yet (proof the wait is real, not 0).
    expect(server.callCount('/limited')).toBe(1);

    // Advance past the 1s Retry-After delta → the retry fires → attempt 2 (200) → resolves.
    await clock.advance(1000);
    await done;

    expect(error).toBeUndefined();
    expect(server.callCount('/limited')).toBe(2);
    expect(await blobText(out!.blob)).toBe(FILE);
    expect(clock.pending()).toBe(0); // nothing leaked
});
