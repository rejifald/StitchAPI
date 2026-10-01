// `scrubUrls` (src/util.ts) — the free-text companion to `scrubUrl` that every error text crossing
// the MCP boundary runs through (#866). mcp.spec.ts proves it end to end on the tool result; these
// pin the scanner itself: which spans count as a URL, the parser-rejected fallback, and that the
// scan stays linear on untrusted text (CodeQL flagged the first, single-regex version as
// polynomial on a long run of scheme characters).
import { scrubUrls } from '../src/util';

describe('scrubUrls', () => {
    test('scrubs every URL in the text and leaves the prose around it alone', () => {
        expect(
            scrubUrls(
                'GET https://u:pw@a.test/x?token=t1 failed; retry http://b.test/y?page=2&api_key=k2.',
            ),
        ).toBe(
            'GET https://a.test/x?token=REDACTED failed; retry http://b.test/y?page=2&api_key=REDACTED',
        );
    });

    test('a clean URL and URL-free text come back byte-identical', () => {
        const clean =
            'see https://a.test/x?page=2&sort=asc (and ftp://b.test/)';
        expect(scrubUrls(clean)).toBe(clean);
        expect(scrubUrls('no url here: a://')).toBe('no url here: a://');
        expect(scrubUrls('')).toBe('');
    });

    test('a URL the WHATWG parser rejects is scrubbed lexically', () => {
        expect(
            scrubUrls(
                'Failed to parse URL from http://ops:p@ss@api.test:99999/v1?api_key=k&page=1#frag',
            ),
        ).toBe(
            'Failed to parse URL from http://api.test:99999/v1?api_key=REDACTED&page=1#frag',
        );
    });

    test('the URL ends at a quote, a bracket or a backslash, so JSON-ish text stays intact', () => {
        expect(
            scrubUrls(
                '{"url":"https://a.test/x?token=t1","next":"<https://b.test/>"}',
            ),
        ).toBe(
            '{"url":"https://a.test/x?token=REDACTED","next":"<https://b.test/>"}',
        );
        expect(scrubUrls('\\"https://u:pw@a.test:99999/\\"')).toBe(
            '\\"https://a.test:99999/\\"',
        );
    });

    test('the scheme starts at a letter, as RFC 3986 spells it', () => {
        expect(scrubUrls('1+http://u:pw@a.test:99999/')).toBe(
            '1+http://a.test:99999/',
        );
    });

    test('stays linear on a long run of scheme characters with no URL in it', () => {
        const hostile = `${'a'.repeat(200_000)}:/${'a'.repeat(200_000)}://`;
        const started = performance.now();
        expect(scrubUrls(hostile)).toBe(hostile);
        expect(performance.now() - started).toBeLessThan(1000);
    });
});
