// Edge-branch coverage for the `download` surface's filename parsing (src/download.ts).
// download.spec.ts covers the common cases (quoted / token / filename* / preference / whitespace /
// URL fallback / none). These exercise the fallback branches it leaves open:
//   filenameFromDisposition — malformed filename* percent-encoding → the raw value is kept; a
//                             filename* with a non-empty language tag; a Content-Disposition that
//                             carries NO filename, and an empty quoted filename — both fall through.
//   filenameFromUrl         — the last path segment is percent-DECODED; malformed encoding keeps the
//                             raw segment; a trailing slash uses the last NON-empty segment; a
//                             non-absolute URL yields undefined.
import { download } from '../src/download';
import type { Adapter, AdapterResponse } from '../src/types';

// A fake adapter that hands back a Blob body plus optional response headers / final url
// (mirrors download.spec.ts's blobAdapter).
function blobAdapter(init: {
    headers?: Record<string, string>;
    url?: string;
}): Adapter {
    return () => {
        const res: AdapterResponse = {
            status: 200,
            headers: init.headers ?? {},
            body: new Blob(['x']),
        };
        if (init.url !== undefined) res.url = init.url;
        return Promise.resolve(res);
    };
}

const filenameFor = async (
    cd: string | undefined,
    url?: string,
): Promise<string | undefined> => {
    const headers = cd ? { 'content-disposition': cd } : {};
    const adapter = blobAdapter(url !== undefined ? { headers, url } : { headers });
    const d = download({ url: 'https://x.test/f', adapter });
    return (await d()).filename;
};

describe('filenameFromDisposition (fallback branches)', () => {
    it('keeps the raw filename* value when percent-decoding fails', async () => {
        // %ZZ is not valid percent-encoding → decodeURIComponent throws → the raw value is returned.
        expect(await filenameFor("attachment; filename*=UTF-8''bad%ZZ.txt")).toBe(
            'bad%ZZ.txt',
        );
    });

    it('parses a filename* that carries a language tag', async () => {
        expect(await filenameFor("attachment; filename*=UTF-8'en'report.txt")).toBe(
            'report.txt',
        );
    });

    it('falls back to the URL when Content-Disposition has no filename param', async () => {
        expect(
            await filenameFor('attachment', 'https://h.test/a/file.zip'),
        ).toBe('file.zip');
    });

    it('treats an empty quoted filename as absent and falls back to the URL', async () => {
        expect(
            await filenameFor('attachment; filename=""', 'https://h.test/a/real.zip'),
        ).toBe('real.zip');
    });
});

describe('filenameFromUrl (fallback branches)', () => {
    it('percent-decodes the last path segment', async () => {
        expect(
            await filenameFor(undefined, 'https://h.test/files/r%C3%A9sum%C3%A9.pdf'),
        ).toBe('résumé.pdf');
    });

    it('keeps the raw segment when its percent-encoding is malformed', async () => {
        expect(
            await filenameFor(undefined, 'https://h.test/files/bad%ZZ.bin'),
        ).toBe('bad%ZZ.bin');
    });

    it('uses the last NON-empty segment when the URL ends in a slash', async () => {
        expect(await filenameFor(undefined, 'https://h.test/a/b/')).toBe('b');
    });

    it('yields undefined for a non-absolute response URL', async () => {
        expect(await filenameFor(undefined, 'relative/path')).toBeUndefined();
    });
});
