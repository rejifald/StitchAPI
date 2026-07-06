// Pins Z1/Z2/Z3 + the 204 path: the buffered download handles the size boundary values correctly —
// a 0-byte body (no divide-by-zero), a 204 No Content (interpret's other accepted status), a 1-byte
// body, and a multi-MB body (generated, not stored) buffered intact. These are the corners a
// Blob-buffering surface is most likely to get subtly wrong.
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

test('a 0-byte 200 resolves as an empty Blob', async () => {
    server.route('GET', '/empty', { statuses: [200], rawBody: '' }); // Content-Length: 0
    const out = await download({ baseUrl: server.url, path: '/empty' })();
    expect(out.blob.size).toBe(0);
});

test('a 204 No Content resolves as an empty Blob (interpret accepts 204)', async () => {
    server.route('GET', '/nc', { statuses: [204], rawBody: '' });
    const out = await download({ baseUrl: server.url, path: '/nc' })();
    expect(out.blob.size).toBe(0);
});

test('a 1-byte body resolves exactly', async () => {
    server.route('GET', '/one', { statuses: [200], rawBody: 'X' });
    const out = await download({ baseUrl: server.url, path: '/one' })();
    expect(out.blob.size).toBe(1);
    expect(await blobText(out.blob)).toBe('X');
});

test('a multi-MB generated body buffers intact', async () => {
    // 4 MB generated in-memory (not a stored fixture) — exercises buffered-Blob assembly at size.
    const big = Buffer.alloc(4 * 1024 * 1024, 0x61); // 4 MiB of 'a'
    server.route('GET', '/big', { statuses: [200], rawBody: big });

    const out = await download({ baseUrl: server.url, path: '/big' })();
    expect(out.blob.size).toBe(big.length);
    // Spot-check the first and last byte rather than stringifying 4 MB.
    const head = new Uint8Array(await out.blob.slice(0, 1).arrayBuffer())[0];
    const tail = new Uint8Array(
        await out.blob.slice(big.length - 1).arrayBuffer(),
    )[0];
    expect(head).toBe(0x61);
    expect(tail).toBe(0x61);
});
