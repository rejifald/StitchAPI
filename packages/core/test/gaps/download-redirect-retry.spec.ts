// Pins (D6): the cross-origin credential strip holds even when the RETRIED attempt is the one that
// redirects. A transient failure (503) is retried by the engine; the retried attempt answers a
// cross-origin 302, and the strip must still drop the credential/custom headers on that hop.
//
// This composes the retry policy with the redirect strip through the download surface, over real
// sockets. A's route is scripted `[503, 302]`: the first attempt gets a retryable 503 (503 is in the
// default retry set), the engine retries, and the second attempt 302s to B on another origin. B
// serves the file. We assert B NEVER received the credential/custom headers (the strip held on the
// retried attempt), the download resolved with B's body, and — belt-and-braces — that A really was
// hit twice (the 503 then the 302). No `src/` change is involved; the strip is inherited from
// fetchAdapter, the retry from the engine.
//
// Real-timer, loose bounds (a socket test): a tiny `backoff.base` keeps the single backoff negligible;
// the only time assertion is a wide ceiling. Both servers are closed in afterAll.
import { apiKey, env } from '../../src/auth';
import { download } from '../../src/download';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

const API_KEY = 'sk-secret-retry-redirect';
const AWS_AUTH = 'AWS4-HMAC-SHA256 Credential=AKIA.../...';

const hdr = (h: Record<string, string>, name: string): string | undefined => {
    const k = Object.keys(h).find(
        (x) => x.toLowerCase() === name.toLowerCase(),
    );
    return k ? h[k] : undefined;
};

let a: MockServer;
let b: MockServer;
beforeAll(async () => {
    a = await startMockServer();
    b = await startMockServer();
});
afterAll(async () => {
    await Promise.all([a.close(), b.close()]);
});
beforeEach(() => {
    a.reset();
    b.reset();
});

const FILE_BYTES = 'RETRIED-THEN-REDIRECTED-CDN-BODY';

test('the strip holds when the RETRIED attempt is the one that redirects cross-origin', async () => {
    // A: first call 503 (retryable), second call 302 → B (cross-origin). The 503 falls through to a
    // normal body response; only the 302 call redirects.
    a.route('GET', '/flaky', {
        statuses: [503, 302],
        redirectTo: `${b.url}/file`,
    });
    b.route('GET', '/file', {
        statuses: [200],
        rawBody: FILE_BYTES,
        headers: { 'content-disposition': 'attachment; filename="late.bin"' },
    });

    process.env['RETRY_REDIRECT_KEY'] = API_KEY;
    const getAsset = download({
        baseUrl: a.url,
        path: '/flaky',
        auth: apiKey({ secret: env('RETRY_REDIRECT_KEY') }),
        headers: {
            authorization: AWS_AUTH,
            'x-amz-date': '20260706T000000Z',
            'x-amz-content-sha256': 'abc123def456',
        },
        // Allow one retry so the 503 is not terminal; a tiny backoff keeps the test fast.
        retry: { attempts: 2, on: [503], backoff: { base: 5 } },
        timeout: 5000,
    });

    const out = await getAsset();

    // A was hit TWICE: the 503, then the 302 (guards that the retry actually happened).
    expect(a.callCount('/flaky')).toBe(2);

    // The strip held on the retried, cross-origin hop: NONE of the sensitive headers reached B.
    const leaked = b.calls('/file')[0]?.headers ?? {};
    expect(hdr(leaked, 'x-api-key')).toBeUndefined();
    expect(hdr(leaked, 'authorization')).toBeUndefined();
    expect(hdr(leaked, 'x-amz-date')).toBeUndefined();
    expect(hdr(leaked, 'x-amz-content-sha256')).toBeUndefined();

    // The download still resolved with B's body + final-hop filename.
    expect(new TextDecoder().decode(await out.blob.arrayBuffer())).toBe(
        FILE_BYTES,
    );
    expect(out.filename).toBe('late.bin');
});
