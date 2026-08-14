// Pins N10: a server that ACCEPTS the connection and then goes silent — never sending a status line,
// holding the socket open — is a black hole at the HTTP layer. There is no idle/forward-progress
// timeout (see download-slow-vs-stall.spec.ts), so ONLY the caller's wall-clock `timeout` can cut it;
// without one it would hang forever. A raw net.Server that does nothing on connect models it
// deterministically (the analogue of an SYN-accepted-but-blackholed connection).
import { download } from '../../src/download';
import { startRawServer } from '../support/hostile-net';
import type { RawServer } from '../support/hostile-net';

let raw: RawServer;
beforeAll(async () => {
    // Accept and hold: never write a byte, never close. Teardown force-destroys the held socket.
    raw = await startRawServer(() => {
        /* silence — the black hole */
    });
});
afterAll(async () => {
    await raw.close();
});

test('a connect that never produces an HTTP response is cut by the caller timeout, not hung', async () => {
    const getIt = download({
        baseUrl: raw.url(),
        path: '/file.bin',
        timeout: 300, // the ONLY cure for a no-response black hole
        retry: { attempts: 1 },
    });

    const started = Date.now();
    const err = await getIt().then(
        () => {
            throw new Error('no-response download unexpectedly resolved');
        },
        (e: unknown) => e,
    );
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(Error);
    expect(elapsed).toBeLessThan(5000); // never hangs
    // It was the ~300ms TIMEOUT that cut it, not an instant transport reject — a clear lower margin.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect((err as Error).message).toMatch(/timeout|timed out|abort|aborted/i);
});
