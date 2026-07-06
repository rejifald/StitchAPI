// Pins: a `download` that follows a SAME-ORIGIN redirect KEEPS its credential/custom headers — the
// cross-origin strip must not OVER-strip on a hop that never leaves the origin. Proven end-to-end
// through the download surface, over a real socket.
//
// The companion to download-redirect-cross-origin.spec.ts. When an API answers with a redirect to a
// path on the SAME origin (same scheme + host + port), auth has to keep working: `headersForRedirect`
// returns the headers unchanged for a same-origin hop, and `download()` inherits that via
// fetchAdapter's manual-follow loop. Here A 302s to another path on A itself; the second (same-origin)
// request must still carry `x-api-key` and the SigV4-style headers, and the download must resolve
// with the file. A single server ⇒ one origin ⇒ same-origin by construction.
//
// Real-timer, loose bounds (a socket test): the hop is local and prompt. The server is closed in
// afterAll.
import { apiKey, env } from '../../src';
import { download } from '../../src/download';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

const API_KEY = 'sk-secret-same-origin';
const AWS_AUTH = 'AWS4-HMAC-SHA256 Credential=AKIA.../...';

const hdr = (h: Record<string, string>, name: string): string | undefined => {
    const k = Object.keys(h).find(
        (x) => x.toLowerCase() === name.toLowerCase(),
    );
    return k ? h[k] : undefined;
};

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

const FILE_BYTES = 'SAME-ORIGIN-REDIRECT-TARGET-BODY';

test('a same-origin redirect KEEPS x-api-key / authorization / x-amz-* on the second request and resolves the file (no over-strip)', async () => {
    // A 302s to another PATH on the SAME server (a relative Location → same scheme+host+port).
    server.route('GET', '/entry', {
        statuses: [302],
        redirectTo: '/final',
    });
    server.route('GET', '/final', {
        statuses: [200],
        rawBody: FILE_BYTES,
        headers: { 'content-disposition': 'attachment; filename="kept.bin"' },
    });

    process.env['SAMEORIGIN_REDIRECT_KEY'] = API_KEY;
    const getFile = download({
        baseUrl: server.url,
        path: '/entry',
        auth: apiKey({ value: env('SAMEORIGIN_REDIRECT_KEY') }),
        headers: {
            authorization: AWS_AUTH,
            'x-amz-date': '20260706T000000Z',
            'x-amz-content-sha256': 'abc123def456',
        },
        timeout: 5000,
        retry: { attempts: 1 },
    });

    const out = await getFile();

    // The second (same-origin) request STILL carries every sensitive header — auth keeps working.
    const second = server.calls('/final')[0];
    expect(second).toBeDefined();
    const kept = second?.headers ?? {};
    expect(hdr(kept, 'x-api-key')).toBe(API_KEY);
    expect(hdr(kept, 'authorization')).toBe(AWS_AUTH);
    expect(hdr(kept, 'x-amz-date')).toBe('20260706T000000Z');
    expect(hdr(kept, 'x-amz-content-sha256')).toBe('abc123def456');

    // The download resolves with the redirect target's body + filename.
    expect(new TextDecoder().decode(await out.blob.arrayBuffer())).toBe(
        FILE_BYTES,
    );
    expect(out.filename).toBe('kept.bin');
});
