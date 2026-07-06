// Pins: a download that STALLS mid-body (bytes stop arriving, socket held open) must REJECT with a
// timeout — never hang, never resolve a partial Blob.
//
// The stall is the worst case of M1's clean-FIN truncation: the server writes some bytes and then
// simply stops, holding the connection open with no FIN and no reset. undici blocks forever waiting
// for the rest of the promised body, so the buffered `download` never resolves. The ONLY thing that
// cuts it is the engine's per-attempt/total `timeout` (TimeoutOptions, both wall-clock — there is no
// idle/forward-progress timeout), which aborts the in-flight fetch (engine.ts:681 withTimeout links
// the abort signal to the transport). No `src/` change: this pins that a bounded `timeout` turns an
// idle stall into a deterministic reject.
//
// EMPIRICAL FINDING (Node 24 undici): the reject is the engine's timeout/abort error — reported in
// the loose message assertion below.
//
// Real-timer, LOOSE bounds (a socket test): a short `timeout` cuts the hang; the assertion only
// requires the call to reject comfortably before a generous real-time ceiling, so it can't itself
// hang the suite. `stallAfterBytes` holds a socket open — teardown force-destroys it (mock-server
// tracks live sockets and destroys them on reset()/close()), so the suite still exits.
import { download } from '../../src/download';
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

// 64 bytes advertised, 8 written, then the connection is held open with no further bytes — an idle
// stall. A 300ms total timeout must cut it; the call rejects well under a 5s real-time ceiling and
// never resolves a partial Blob.
test('an idle stall mid-body rejects via timeout — never hangs, never a partial Blob', async () => {
    server.route('GET', '/stall', {
        statuses: [200],
        rawBody:
            'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ012', // 64 bytes
        declaredLength: 64, // advertise 64…
        stallAfterBytes: 8, // …write 8, then hold the socket open forever
    });

    const getStall = download({
        baseUrl: server.url,
        path: '/stall',
        timeout: 300, // ≡ { total: 300 } — the only cure for an idle stall
        retry: { attempts: 1 },
    });

    const started = Date.now();
    const err = await getStall().then(
        () => {
            throw new Error('download resolved despite a mid-body stall');
        },
        (e: unknown) => e,
    );
    const elapsed = Date.now() - started;

    // Rejected (not resolved), and cut by the timeout — comfortably under a loose real-time ceiling.
    expect(err).toBeInstanceOf(Error);
    expect(elapsed).toBeLessThan(5000);
    // The reject is the engine's timeout/abort — assert loosely so it survives wording drift.
    expect((err as Error).message).toMatch(/timeout|timed out|abort|aborted/i);
});
