// Pins N11: a server that ACCEPTS the connection then immediately FINs (closes) WITHOUT ever writing an
// HTTP status line — "no HTTP response" — must make the download REJECT, never hang. `node:http` can't
// express "accept then send nothing", so this needs the raw-socket escape hatch (startRawServer).
import { download } from '../../src/download';
import { startRawServer } from '../support/hostile-net';
import type { RawServer } from '../support/hostile-net';

let raw: RawServer;
beforeAll(async () => {
    // FIN the socket the instant it connects — a graceful close before any HTTP bytes are written.
    raw = await startRawServer((socket) => socket.end());
});
afterAll(async () => {
    await raw.close();
});

test('a server that hangs up with no HTTP response rejects the download (never hangs)', async () => {
    const getIt = download({
        baseUrl: raw.url(),
        path: '/file.bin',
        timeout: 4000,
        retry: { attempts: 1 },
    });

    const started = Date.now();
    const err = await getIt().then(
        () => {
            throw new Error('hangup download unexpectedly resolved');
        },
        (e: unknown) => e,
    );
    expect(Date.now() - started).toBeLessThan(4000); // never hangs
    expect(err).toBeInstanceOf(Error);
    // undici: the socket closed before a response line arrived → a generic transport failure.
    expect((err as Error).message).toMatch(/fetch failed/i);
});
