// Pins N9: a download to a port where nothing is listening REJECTS promptly with ECONNREFUSED,
// surfaced as the generic transport error (the ECONNREFUSED detail rides the stripped cause). Returns
// effectively instantly — there is nothing to wait for — so it must never hang.
//
// Deterministic: `unusedPort()` binds an ephemeral port, captures it, and closes it, so the connect is
// refused (nothing accepts) rather than hitting a live listener.
import { download } from '../../src/download';
import { unusedPort } from '../support/hostile-net';

test('a download to a refused connection (nothing listening) rejects promptly', async () => {
    const port = await unusedPort();
    const getIt = download({
        baseUrl: `http://127.0.0.1:${port}`,
        path: '/file.bin',
        timeout: 4000,
        retry: { attempts: 1 },
    });

    const started = Date.now();
    const err = await getIt().then(
        () => {
            throw new Error(
                'refused-connection download unexpectedly resolved',
            );
        },
        (e: unknown) => e,
    );
    // ECONNREFUSED returns at once (no listener), comfortably under the ceiling — never a hang.
    expect(Date.now() - started).toBeLessThan(4000);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/fetch failed/i);
    // The raw ECONNREFUSED detail rides the stripped transport cause; the caller sees only the generic text.
    expect((err as Error).message).not.toMatch(/ECONNREFUSED/);
});
