// Pins N8 (best-effort): a TLS handshake failure must REJECT cleanly and never hang, surfacing the
// generic transport error (the specific TLS/cert cause rides the stripped transport cause, per the M2
// finding). Modelled deterministically by pointing an `https://` request at a server that is NOT
// speaking TLS — a raw net.Server that destroys the socket the moment the client's ClientHello arrives,
// so the handshake cannot complete. A genuine expired/self-signed-CERT failure needs cert-generation
// infra (out of scope for a zero-dep test); a non-TLS peer is a handshake failure that needs none, and
// undici (which rejects unauthorized TLS by default) treats both as the same generic transport failure.
import { download } from '../../src/download';
import { startRawServer } from '../support/hostile-net';
import type { RawServer } from '../support/hostile-net';

let raw: RawServer;
beforeAll(async () => {
    // Destroy the socket as soon as the client's TLS ClientHello arrives → the handshake fails.
    raw = await startRawServer((socket) => {
        socket.on('data', () => socket.destroy());
    });
});
afterAll(async () => {
    await raw.close();
});

test('an https request whose TLS handshake fails rejects cleanly (never hangs)', async () => {
    const getIt = download({
        baseUrl: raw.url('https'),
        path: '/file.bin',
        timeout: 4000,
        retry: { attempts: 1 },
    });

    const started = Date.now();
    const err = await getIt().then(
        () => {
            throw new Error('TLS-failing download unexpectedly resolved');
        },
        (e: unknown) => e,
    );
    expect(Date.now() - started).toBeLessThan(4000); // never hangs
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/fetch failed/i);
});
