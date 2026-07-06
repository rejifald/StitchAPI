// Pins X11 (S8/S9): the DOWNLOAD path inherits stitch's retry-SET decisions — 500 and 408 are NOT in
// the default retry set ([429,502,503,504]), so a download sees them ONCE and fails; opting in via
// `retry.on` restores retries. Two easy-to-miss defaults a downloader built on top must respect or
// deliberately override. (The engine retries a status only when `retryMatch(status) && attempt<max`;
// otherwise a ≥400 throws terminally past the transport-retry catch — engine.ts.)
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

const FILE = 'RECOVERED-BODY-abcdefghij';

test('500 is NOT retried by default — one attempt, then it fails', async () => {
    server.route('GET', '/err', { statuses: [500, 200], rawBody: FILE });

    const getErr = download({
        baseUrl: server.url,
        path: '/err',
        retry: { attempts: 3 }, // 500 ∉ default on → the extra attempts are never used
    });

    const err = await getErr().then(
        () => {
            throw new Error('500 download unexpectedly resolved');
        },
        (e: unknown) => e,
    );
    // Exactly ONE request — a 500 is terminal by default, the [500→200] recovery is never reached.
    expect(server.callCount('/err')).toBe(1);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/500/);
});

test('500 IS retried when opted in via retry.on', async () => {
    server.route('GET', '/err', { statuses: [500, 200], rawBody: FILE });

    const getErr = download({
        baseUrl: server.url,
        path: '/err',
        retry: { attempts: 2, on: [500], backoff: 'fixed', baseMs: 10 },
    });

    const out = await getErr();
    // Opting 500 into the retry set reaches the [500→200] recovery: two attempts, then success.
    expect(server.callCount('/err')).toBe(2);
    expect(await blobText(out.blob)).toBe(FILE);
});

test('408 is NOT retried by default — one attempt, then it fails', async () => {
    server.route('GET', '/req-timeout', {
        statuses: [408, 200],
        rawBody: FILE,
    });

    const getIt = download({
        baseUrl: server.url,
        path: '/req-timeout',
        retry: { attempts: 3 }, // 408 ∉ default on
    });

    const err = await getIt().then(
        () => {
            throw new Error('408 download unexpectedly resolved');
        },
        (e: unknown) => e,
    );
    expect(server.callCount('/req-timeout')).toBe(1);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/408/);
});
