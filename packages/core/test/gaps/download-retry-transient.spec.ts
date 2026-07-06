// Pins X9 (S7/S11): a transient 503 is RETRIED, and each attempt re-downloads the WHOLE file from
// byte 0 — a buffered download has no resume, so NO attempt ever sends a `Range` — finally resolving
// with the intact body once the server recovers. 503 ∈ the default retry set ([429,502,503,504]); a
// small fixed backoff keeps the retry prompt (real timer, loose — the assertion is on the OUTCOME, not
// the delay).
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

const FILE = 'THE-REAL-FILE-BODY-0123456789-abcdefghij';

test('a transient 503 is retried and the whole file re-downloaded (no Range), resolving intact', async () => {
    server.route('GET', '/flaky', {
        statuses: [503, 200], // first attempt fails transiently, second succeeds
        rawBody: FILE, // the 503 body is irrelevant (engine throws ≥400 → retry)
    });

    const getFlaky = download({
        baseUrl: server.url,
        path: '/flaky',
        retry: { attempts: 2, backoff: 'fixed', baseMs: 10 }, // 503 ∈ default on; prompt backoff
    });

    const out = await getFlaky();

    // Retried exactly once — two attempts reached the server (503 then 200).
    expect(server.callCount('/flaky')).toBe(2);
    // Every attempt was a FULL GET from byte 0: a retry RE-DOWNLOADS, it does not resume, so no attempt
    // ever carries a `Range` header (the buffered surface has no byte-offset resume — that is new code
    // for the future @stitchapi/download package, not a property of raw download()).
    for (const c of server.calls('/flaky'))
        expect(c.headers['range']).toBeUndefined();
    // …and it resolved with the complete, correct file.
    expect(await blobText(out.blob)).toBe(FILE);
});
