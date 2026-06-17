// The `download` surface (ADR 0005 Decision 8): a buffered binary GET → `{ blob, filename }`.
// GET + responseType:'blob' (forced by the surface), byte progress (Decision 9 `onProgress`),
// `Content-Disposition` filename (filename* / filename) with a URL-last-segment fallback, and a
// per-call `AbortSignal`. Never writes to disk — it returns a Blob. Tests drive a fake adapter for
// the unit cases and the real fetch + mock server for the round-trip (browser-first).
import { seam, stitch } from '../src';
import { download, downloadSurface } from '../src/download';
import type { DownloadResult } from '../src/download';
import type { Adapter, AdapterProgress, AdapterResponse } from '../src/types';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CORE = join(import.meta.dirname, '..');

// A fake adapter that hands back a Blob body (as the blob responseType would decode to), plus
// optional response headers / final url. Records the last request it saw.
function blobAdapter(
    bytes: string,
    init: {
        headers?: Record<string, string>;
        url?: string;
        status?: number;
    } = {},
): Adapter & { last?: Parameters<Adapter>[0] } {
    const fn = ((req) => {
        fn.last = req;
        const res: AdapterResponse = {
            status: init.status ?? 200,
            headers: init.headers ?? {},
            body: new Blob([bytes]),
        };
        if (init.url !== undefined) res.url = init.url;
        return Promise.resolve(res);
    }) as Adapter & { last?: Parameters<Adapter>[0] };
    return fn;
}

const bytesOf = (blob: Blob): Promise<Uint8Array> =>
    blob.arrayBuffer().then((ab) => new Uint8Array(ab));

describe('download surface identity (Decisions 8, 11)', () => {
    test('downloadSurface has id "download", buildRequest + interpret, and NO stream hook', () => {
        expect(downloadSurface.id).toBe('download');
        expect(typeof downloadSurface.buildRequest).toBe('function');
        expect(typeof downloadSurface.interpret).toBe('function');
        expect(downloadSurface.stream).toBeUndefined(); // buffered, not a streaming surface
    });

    test('kind round-trips through __config as the id string "download"', () => {
        const d = download({ url: 'https://x.test/f' });
        const json = JSON.parse(JSON.stringify(d.__config)) as {
            kind?: unknown;
        };
        expect(json.kind).toBe('download');
    });
});

describe('download shaping (Decision 8)', () => {
    test('forces GET + responseType "blob" regardless of config', async () => {
        const adapter = blobAdapter('x');
        const d = download({
            url: 'https://x.test/f',
            method: 'POST',
            adapter,
        });
        await d();
        expect(adapter.last?.method).toBe('GET');
        expect(adapter.last?.responseType).toBe('blob');
    });

    test('resolves to { blob, filename }; the blob carries the bytes', async () => {
        const adapter = blobAdapter('hello bytes', {
            headers: {
                'content-disposition': 'attachment; filename="report.pdf"',
            },
        });
        const d = download({ url: 'https://x.test/f', adapter });

        const out: DownloadResult = await d();
        expect(out.filename).toBe('report.pdf');
        expect(out.blob).toBeInstanceOf(Blob);
        expect(new TextDecoder().decode(await bytesOf(out.blob))).toBe(
            'hello bytes',
        );
    });
});

describe('filename parsing (Decision 8)', () => {
    const filenameFor = async (
        cd: string | undefined,
        url?: string,
    ): Promise<string | undefined> => {
        const headers = cd ? { 'content-disposition': cd } : {};
        const adapter = url
            ? blobAdapter('x', { headers, url })
            : blobAdapter('x', { headers });
        const d = download({ url: 'https://x.test/f', adapter });
        return (await d()).filename;
    };

    test('quoted filename', async () => {
        expect(await filenameFor('attachment; filename="a b.pdf"')).toBe(
            'a b.pdf',
        );
    });

    test('unquoted token filename', async () => {
        expect(await filenameFor('attachment; filename=report.csv')).toBe(
            'report.csv',
        );
    });

    test('RFC 5987 filename* is percent-decoded', async () => {
        expect(
            await filenameFor(
                "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
            ),
        ).toBe('résumé.pdf');
    });

    test('filename* is preferred over a plain filename', async () => {
        expect(
            await filenameFor(
                'attachment; filename="fallback.txt"; filename*=UTF-8\'\'real.txt',
            ),
        ).toBe('real.txt');
    });

    // The `filename*` pattern is linear (no `\s*`/`[^']*` overlap that would let a crafted
    // header backtrack quadratically), and still tolerates whitespace around the `=`.
    test('filename* tolerates whitespace around the "="', async () => {
        expect(
            await filenameFor("attachment; filename* = UTF-8''spaced.txt"),
        ).toBe('spaced.txt');
    });

    test('falls back to the URL last path segment when no Content-Disposition', async () => {
        expect(
            await filenameFor(undefined, 'https://h.test/a/b/file.zip'),
        ).toBe('file.zip');
    });

    test('filename is undefined when neither header nor URL yields one', async () => {
        expect(await filenameFor(undefined)).toBeUndefined();
    });
});

describe('byte progress (Decision 9, threaded per-call)', () => {
    test('input.onProgress is threaded into the request and fired', async () => {
        const adapter: Adapter = (req) => {
            req.onProgress?.({ phase: 'download', loaded: 5, total: 10 });
            req.onProgress?.({ phase: 'download', loaded: 10, total: 10 });
            return Promise.resolve({
                status: 200,
                headers: {},
                body: new Blob(['x']),
            });
        };
        const d = download({ url: 'https://x.test/f', adapter });

        const seen: AdapterProgress[] = [];
        await d({
            onProgress: (p) => {
                seen.push(p);
            },
        });
        expect(seen).toEqual([
            { phase: 'download', loaded: 5, total: 10 },
            { phase: 'download', loaded: 10, total: 10 },
        ]);
    });
});

describe('AbortSignal (Decision 8, per-call)', () => {
    test('an already-aborted signal rejects the call', async () => {
        const adapter = blobAdapter('x');
        const d = download({ url: 'https://x.test/f', adapter });
        const ctrl = new AbortController();
        ctrl.abort();
        await expect(d({ signal: ctrl.signal })).rejects.toThrow();
    });

    test('aborting in flight rejects the call (the signal reaches the adapter)', async () => {
        // The adapter parks until its (combined) signal aborts — proving the caller's signal is
        // threaded through the engine + timeout link to the transport.
        const adapter: Adapter = (req) =>
            new Promise((_, reject) => {
                req.signal?.addEventListener(
                    'abort',
                    () => {
                        reject(new Error('aborted by signal'));
                    },
                    { once: true },
                );
            });
        const d = download({ url: 'https://x.test/f', adapter });
        const ctrl = new AbortController();
        const p = d({ signal: ctrl.signal });
        ctrl.abort();
        await expect(p).rejects.toThrow(/aborted/);
    });
});

describe('download over real fetch + mock server (browser-first)', () => {
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

    // every byte value 0..255 — catches any text-coercion corruption on the blob path
    const payload = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

    test('downloads a binary body to a Blob with the Content-Disposition filename; bytes round-trip', async () => {
        server.route('GET', '/file', {
            body: payload,
            headers: {
                'content-disposition': 'attachment; filename="data.bin"',
            },
        });
        const seen: AdapterProgress[] = [];
        const getFile = download({ baseUrl: server.url, path: '/file' });

        const out = await getFile({
            onProgress: (p) => {
                seen.push(p);
            },
        });
        expect(out.filename).toBe('data.bin');
        expect(out.blob).toBeInstanceOf(Blob);
        expect(Buffer.from(await out.blob.arrayBuffer()).equals(payload)).toBe(
            true,
        );
        // progress fired for the download phase
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.every((p) => p.phase === 'download')).toBe(true);
        expect(server.calls('/file')[0]?.method).toBe('GET');
    });

    test('filename falls back to the URL last segment when the server sends no Content-Disposition', async () => {
        server.route('GET', '/reports/q3.csv', {
            body: Buffer.from('a,b\n1,2'),
        });
        const getCsv = download({
            baseUrl: server.url,
            path: '/reports/q3.csv',
        });
        expect((await getCsv()).filename).toBe('q3.csv');
    });
});

describe('download authoring helpers (Decision 3)', () => {
    test('download.surface is the Surface; download.stitch aliases the callable', () => {
        expect(download.surface).toBe(downloadSurface);
        const a = download({ url: 'https://x.test/f' });
        const b = download.stitch({ url: 'https://x.test/f' });
        expect(a.__config.kind).toBe(b.__config.kind);
    });

    test('download.seam(existingSeam).stitch(...) creates a download member of that seam', async () => {
        const api = seam({ baseUrl: 'https://x.test' });
        const getThing = download.seam(api).stitch({
            path: '/thing',
            adapter: blobAdapter('thing-bytes', {
                headers: {
                    'content-disposition': 'attachment; filename=thing.bin',
                },
            }),
        });
        const out = await getThing();
        expect(out.filename).toBe('thing.bin');
        expect(new TextDecoder().decode(await bytesOf(out.blob))).toBe(
            'thing-bytes',
        );
    });

    test('a generic stitch({ kind: downloadSurface }) downloads the same way', async () => {
        const d = stitch({
            kind: downloadSurface,
            url: 'https://x.test/f',
            adapter: blobAdapter('z', {
                headers: {
                    'content-disposition': 'attachment; filename=z.bin',
                },
            }),
        });
        // the generic stitch({ kind }) overload stays Stitch<unknown> (surface-driven result
        // typing is the monomorphic helper's job) — cast to assert the runtime shape
        const out = (await d()) as DownloadResult;
        expect(out.filename).toBe('z.bin');
    });
});

describe('download holds the browser-first + bundle-frugal gates (ADR 0005)', () => {
    test('src/download.ts uses no node:* / fs / EventSource (browser-first)', () => {
        const src = readFileSync(join(CORE, 'src/download.ts'), 'utf8');
        expect(src).not.toMatch(/from\s*['"]node:/);
        expect(src).not.toMatch(/\bEventSource\b/);
        expect(src).not.toMatch(/\bfs\b/);
    });

    test('src/index.ts and src/engine.ts never statically import ./download (bundle-frugal)', () => {
        for (const rel of ['src/index.ts', 'src/engine.ts']) {
            const src = readFileSync(join(CORE, rel), 'utf8');
            expect(src).not.toMatch(/['"]\.\/download['"]/);
        }
    });
});
