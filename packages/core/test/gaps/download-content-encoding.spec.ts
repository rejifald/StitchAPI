// Pins B7/B8 (the "progress lies" trap): when the body is served with a real `Content-Encoding`
// (gzip/br), undici auto-decodes it, so the download resolves with the DECOMPRESSED bytes intact — but
// byte progress reports `loaded` in DECOMPRESSED bytes against a `total` taken from the COMPRESSED
// `Content-Length`, so `loaded` can EXCEED `total`. The percentage a naive UI computes would be wrong;
// the future @stitchapi/download must suppress it (byte-count/spinner) when the response is encoded.
// This pins that the bytes are correct AND that the progress numbers are the misleading ones.
import { download } from '../../src/download';
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

const blobText = async (b: Blob): Promise<string> =>
    new TextDecoder().decode(await b.arrayBuffer());

// Highly compressible so the compressed Content-Length is far below the decoded size — the gap is the lie.
const BIG = 'A'.repeat(8192);

for (const encoding of ['gzip', 'br'] as const) {
    test(`a ${encoding} body decodes intact while progress total (compressed) is below loaded (decoded)`, async () => {
        server.route('GET', '/asset', {
            statuses: [200],
            rawBody: BIG,
            contentEncoding: encoding, // server sends compressed bytes + compressed Content-Length
        });

        const seen: AdapterProgress[] = [];
        const out = await download({
            baseUrl: server.url,
            path: '/asset',
        })({ onProgress: (p) => seen.push(p) });

        // The download resolves with the FULL, correctly DECOMPRESSED body.
        expect(out.blob.size).toBe(BIG.length);
        expect(await blobText(out.blob)).toBe(BIG);

        // The final progress `loaded` is the decoded byte count…
        const last = seen[seen.length - 1];
        expect(last?.loaded).toBe(BIG.length);
        // …and the advertised `total` — the COMPRESSED Content-Length, which undici keeps verbatim
        // through auto-decode — is SMALLER than the decoded `loaded`. That inversion is the lie: a
        // naive `loaded/total` percentage would exceed 100%, so a downloader must suppress it when the
        // response carries a real Content-Encoding.
        expect(last?.total).toBeLessThan(BIG.length);
    });
}
