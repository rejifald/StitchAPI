// Binary/blob responses: `responseType` controls how the adapter reads the body —
// 'arrayBuffer'/'blob' for downloads, 'text' for raw strings, 'json' to force parsing.
// Bytes must round-trip exactly, proven by hashing the payload on both ends.
import { stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STITCH_TRACE_FILE = join(
    tmpdir(),
    `stitch-binary-${process.pid}.jsonl`,
);

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

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
// A deterministic payload spanning every byte value 0..255 (catches encoding corruption).
const payload = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

test('responseType: "arrayBuffer" round-trips raw bytes (hash matches)', async () => {
    server.route('GET', '/blob', { body: payload });
    const download = stitch({
        baseUrl: server.url,
        path: '/blob',
        responseType: 'arrayBuffer',
    });

    const ab = (await download()) as ArrayBuffer;
    expect(ab).toBeInstanceOf(ArrayBuffer);
    expect(sha(Buffer.from(ab))).toBe(sha(payload));
});

test('responseType: "blob" round-trips raw bytes (hash matches)', async () => {
    server.route('GET', '/blob', { body: payload });
    const download = stitch({
        baseUrl: server.url,
        path: '/blob',
        responseType: 'blob',
    });

    const blob = (await download()) as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(sha(Buffer.from(await blob.arrayBuffer()))).toBe(sha(payload));
});

test('responseType: "text" returns the raw decoded string', async () => {
    const text = 'hello bytes — ☃ unicode survives';
    server.route('GET', '/text', { body: Buffer.from(text, 'utf8') });
    const read = stitch({
        baseUrl: server.url,
        path: '/text',
        responseType: 'text',
    });

    await expect(read()).resolves.toBe(text);
});

test('responseType: "json" forces parsing regardless of content-type', async () => {
    // Served as octet-stream bytes, but parsed as JSON because responseType says so.
    server.route('GET', '/forced', {
        body: Buffer.from(JSON.stringify({ forced: true }), 'utf8'),
    });
    const f = stitch({
        baseUrl: server.url,
        path: '/forced',
        responseType: 'json',
    });

    await expect(f()).resolves.toEqual({ forced: true });
});

test('default (no responseType) still auto-parses JSON', async () => {
    server.route('GET', '/json', { body: { a: 1, nested: { b: 2 } } });
    const j = stitch({ baseUrl: server.url, path: '/json' });

    await expect(j()).resolves.toEqual({ a: 1, nested: { b: 2 } });
});
