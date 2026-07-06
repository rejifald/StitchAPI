// Pins: a `download` that follows a CROSS-ORIGIN redirect must NOT forward credential/custom headers
// to the redirect target — proven end-to-end through the download surface, over real sockets.
//
// This is the signed-URL → CDN pattern (X2/D2b): a client hits a trusted API with an API key / AWS
// SigV4 headers; the API answers `302 Location: https://cdn.other/…` (a different origin); the CDN
// serves the actual bytes. The default HTTP redirect policy re-sends every request header to the
// target, and undici/axios strip only `authorization`/`cookie` on a cross-origin hop — never custom
// headers like `x-api-key`/`x-amz-*`. `download()` rides fetchAdapter, which follows redirects
// itself (`redirect: 'manual'` + `headersForRedirect`) and drops every non-CORS-safelisted header on
// a cross-origin hop, so the strip is INHERITED here — this is not a new fix, it pins the composed
// behavior: the strip + the buffered download + filename resolution across the hop.
//
// Two independent mock servers → a real cross-origin pair: each `startMockServer()` binds its own
// ephemeral 127.0.0.1 port, and `sameOrigin` treats different ports as cross-origin (host includes
// the port). A serves the 302; B serves the file. We assert on B's RECEIVED request headers (what
// actually crossed the wire), that the download RESOLVES with B's body, and that `out.filename` comes
// from B's `Content-Disposition` — the FINAL hop, not A.
//
// Real-timer, loose bounds (a socket test): the hop is local and prompt; the only time assertion is a
// wide ceiling proving it never hangs. Both servers are closed in afterAll.
import { apiKey, env } from '../../src';
import { download } from '../../src/download';
import { startMockServer } from '../support/mock-server';
import type { MockServer, ReqInfo } from '../support/mock-server';

// The sensitive headers that must never survive a cross-origin hop (an API key + a SigV4 set).
const API_KEY = 'sk-secret-cross-origin';
const AWS_AUTH = 'AWS4-HMAC-SHA256 Credential=AKIA.../...';

// Pull a header case-insensitively from a recorded request (matches redirect-credential-leak.spec).
const hdr = (h: Record<string, string>, name: string): string | undefined => {
    const k = Object.keys(h).find(
        (x) => x.toLowerCase() === name.toLowerCase(),
    );
    return k ? h[k] : undefined;
};

let a: MockServer; // the trusted API that 302s away
let b: MockServer; // the "CDN" on another origin that serves the file

beforeAll(async () => {
    a = await startMockServer();
    b = await startMockServer();
});
afterAll(async () => {
    // Close BOTH servers so the suite exits cleanly.
    await Promise.all([a.close(), b.close()]);
});
beforeEach(() => {
    a.reset();
    b.reset();
});

// The file B hands back once the redirect lands — asserted byte-for-byte on the resolved Blob.
const FILE_BYTES = 'CDN-SERVED-ASSET-BODY-0123456789';

test('a cross-origin redirect drops x-api-key / authorization / x-amz-* before the target is hit, resolves B’s body, and names the file from B’s final-hop Content-Disposition', async () => {
    // A: any request 302s to B's /file (an ABSOLUTE, cross-origin URL — different ephemeral port).
    a.route('GET', '/signed', {
        statuses: [302],
        redirectTo: `${b.url}/file`,
    });
    // B: serves the actual bytes + a Content-Disposition naming the download.
    b.route('GET', '/file', {
        statuses: [200],
        rawBody: FILE_BYTES,
        headers: {
            'content-disposition': 'attachment; filename="asset.bin"',
        },
    });

    // Distinct ephemeral ports ⇒ a real cross-origin pair. Guards the fixture's core premise.
    expect(new URL(a.url).port).not.toBe(new URL(b.url).port);

    process.env['XORIGIN_REDIRECT_KEY'] = API_KEY;
    const getAsset = download({
        baseUrl: a.url,
        path: '/signed',
        // apiKey() writes `x-api-key`; the SigV4-style headers are set directly (awsSigV4 isn't a
        // public export) — together they cover the full credential/custom-header set the strip must drop.
        auth: apiKey({ value: env('XORIGIN_REDIRECT_KEY') }),
        headers: {
            authorization: AWS_AUTH,
            'x-amz-date': '20260706T000000Z',
            'x-amz-content-sha256': 'abc123def456',
        },
        timeout: 5000,
        retry: { attempts: 1 },
    });

    const started = Date.now();
    const out = await getAsset();
    expect(Date.now() - started).toBeLessThan(5000); // never hangs

    // (a) NONE of the credential/custom headers reached B (the cross-origin target).
    const received: ReqInfo | undefined = b.calls('/file')[0];
    expect(received).toBeDefined();
    const leaked = received?.headers ?? {};
    expect(hdr(leaked, 'x-api-key')).toBeUndefined();
    expect(hdr(leaked, 'authorization')).toBeUndefined();
    expect(hdr(leaked, 'x-amz-date')).toBeUndefined();
    expect(hdr(leaked, 'x-amz-content-sha256')).toBeUndefined();

    // Sanity: A DID receive the key on the first (trusted, same-origin) hop — the strip is scoped to
    // the cross-origin follow, not an over-strip that never sent the credential at all.
    expect(hdr(a.calls('/signed')[0]?.headers ?? {}, 'x-api-key')).toBe(
        API_KEY,
    );

    // (b) The download RESOLVES with B's body.
    expect(new TextDecoder().decode(await out.blob.arrayBuffer())).toBe(
        FILE_BYTES,
    );

    // (c) The filename comes from B's Content-Disposition — the FINAL hop, not A's URL/headers.
    expect(out.filename).toBe('asset.bin');
});
