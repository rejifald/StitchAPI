// Pins Z4: a 200 response whose body is an HTML error/login page instead of the expected binary is
// "successful but wrong". The download surface applies NO content-type enforcement (by design — it
// returns the bytes as a Blob), so it RESOLVES with the HTML as the blob rather than failing. This
// documents that detecting "looks-OK-but-isn't" is a CALLER concern (a BYO content-type / checksum
// check) — core won't silently guard it; the blob DOES carry the server's content-type, so a caller
// (or the future @stitchapi/download package, via an opt-in guard) can catch the mismatch.
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

const blobText = async (b: Blob): Promise<string> =>
    new TextDecoder().decode(await b.arrayBuffer());

test('a 200 HTML error page is returned as a Blob (no content-type enforcement — caller must check)', async () => {
    const HTML =
        '<!doctype html><title>Sign in</title><body>Please sign in</body>';
    server.route('GET', '/asset.bin', {
        statuses: [200],
        rawBody: HTML,
        headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    const out = await download({ baseUrl: server.url, path: '/asset.bin' })();

    // It RESOLVES (a 200 is success to the transport) with the HTML bytes verbatim — NOT rejected.
    expect(await blobText(out.blob)).toBe(HTML);
    // The blob carries the server's content-type, so a caller CAN detect the mismatch — but core won't.
    expect(out.blob.type).toMatch(/text\/html/);
});
