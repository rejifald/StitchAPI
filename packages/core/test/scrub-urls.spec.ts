// `scrubUrl` (src/util.ts) on FREE TEXT — the one URL scrubber, which began life as #891's separate
// `scrubUrls` and was consolidated with the config-URL scrubber (#873); every case below is #891's
// and passes unchanged against it. The engine runs every thrown
// message through it where the throw becomes the error event (#890), and the MCP boundary runs every
// error text through it again as defence in depth (#866). transport-error-scrub.spec.ts and
// mcp.spec.ts prove those end to end; these pin the scanner itself: which spans count as a URL, the
// parser-rejected fallback, and that the scan stays linear on untrusted text (CodeQL flagged the
// first, single-regex version as polynomial on a long run of scheme characters).
import { scrubUrl } from '../src/util';

describe('scrubUrl', () => {
    test('scrubs every URL in the text and leaves the prose around it alone', () => {
        expect(
            scrubUrl(
                'GET https://u:pw@a.test/x?token=t1 failed; retry http://b.test/y?page=2&api_key=k2.',
            ),
        ).toBe(
            'GET https://a.test/x?token=REDACTED failed; retry http://b.test/y?page=2&api_key=REDACTED.',
        );
    });

    test('a clean URL and URL-free text come back byte-identical', () => {
        const clean =
            'see https://a.test/x?page=2&sort=asc (and ftp://b.test/)';
        expect(scrubUrl(clean)).toBe(clean);
        expect(scrubUrl('no url here: a://')).toBe('no url here: a://');
        expect(scrubUrl('')).toBe('');
    });

    test('a URL the WHATWG parser rejects is scrubbed lexically', () => {
        expect(
            scrubUrl(
                'Failed to parse URL from http://ops:p@ss@api.test:99999/v1?api_key=k&page=1#frag',
            ),
        ).toBe(
            'Failed to parse URL from http://api.test:99999/v1?api_key=REDACTED&page=1#frag',
        );
    });

    test('the URL ends at a quote, a bracket or a backslash, so JSON-ish text stays intact', () => {
        expect(
            scrubUrl(
                '{"url":"https://a.test/x?token=t1","next":"<https://b.test/>"}',
            ),
        ).toBe(
            '{"url":"https://a.test/x?token=REDACTED","next":"<https://b.test/>"}',
        );
        expect(scrubUrl('\\"https://u:pw@a.test:99999/\\"')).toBe(
            '\\"https://a.test:99999/\\"',
        );
    });

    test('the scheme is never inspected: only what follows `://` is rewritten', () => {
        expect(scrubUrl('1+http://u:pw@a.test:99999/')).toBe(
            '1+http://a.test:99999/',
        );
        expect(scrubUrl('(https://u:pw@a.test/?token=t )')).toBe(
            '(https://a.test/?token=REDACTED )',
        );
    });

    test('punctuation that closes the sentence or the bracket around a URL is not part of it', () => {
        expect(scrubUrl('(https://a.test/x?key=K), retry')).toBe(
            '(https://a.test/x?key=REDACTED), retry',
        );
        expect(scrubUrl('see [https://a.test/x?key=K].')).toBe(
            'see [https://a.test/x?key=REDACTED].',
        );
        expect(scrubUrl('https://u:pw@a.test/x?key=K;')).toBe(
            'https://a.test/x?key=REDACTED;',
        );
        expect(
            scrubUrl('first https://a.test/x?key=K, then https://b.test/'),
        ).toBe('first https://a.test/x?key=REDACTED, then https://b.test/');
        // a clean URL keeps its closing punctuation too, byte for byte
        const clean = 'ok (https://a.test/x?page=2), and https://b.test/.';
        expect(scrubUrl(clean)).toBe(clean);
    });

    test('only the TRAILING run is dropped: a credential may hold those characters inside', () => {
        // a JWT is dotted, so cutting the value at the first `.` would leave its tail in the clear
        expect(
            scrubUrl('https://a.test/x?token=eyJhbGc.eyJzdWIi.sig, ok'),
        ).toBe('https://a.test/x?token=REDACTED, ok');
        expect(scrubUrl('https://a.test/x?key=a),b;c')).toBe(
            'https://a.test/x?key=REDACTED',
        );
        // nothing but punctuation after `://` is not a URL
        expect(scrubUrl('proto://. and ://), x')).toBe('proto://. and ://), x');
    });

    test('userinfo runs to the last `@` of the authority; an `@` in the path or query is left alone', () => {
        expect(scrubUrl('http://user@a.test/x')).toBe('http://a.test/x');
        expect(scrubUrl('http://u:p@w@a.test/x')).toBe('http://a.test/x');
        const clean = 'http://a.test/u@b?mail=x@y.test#a@b';
        expect(scrubUrl(clean)).toBe(clean);
    });

    test('a secret in a repeated key, a fragment, or a percent-encoded key is redacted too', () => {
        expect(scrubUrl('http://a.test/?k=1&token=a&token=b&k=2')).toBe(
            'http://a.test/?k=1&token=REDACTED&token=REDACTED&k=2',
        );
        expect(scrubUrl('http://a.test/cb#access_token=t&state=s')).toBe(
            'http://a.test/cb#access_token=REDACTED&state=s',
        );
        expect(scrubUrl('http://a.test/?%61pi_key=k&%5Bbad=1')).toBe(
            'http://a.test/?%61pi_key=REDACTED&%5Bbad=1',
        );
        // a stray `%` makes the key undecodable — it is matched by its raw spelling, not skipped
        expect(scrubUrl('http://a.test/?secret%=k&bad%zz=v')).toBe(
            'http://a.test/?secret%=REDACTED&bad%zz=v',
        );
    });

    // Every one of these is a shape that makes a careless scan quadratic: a long run of scheme
    // characters, a long run of `?` / `&` / `@` delimiters, and back-to-back `://`.
    test.each([
        [
            'scheme characters',
            `${'a'.repeat(200_000)}:/${'a'.repeat(200_000)}://`,
        ],
        ['query delimiters', `http://a.test/${'?'.repeat(200_000)}`],
        ['pair delimiters', `http://a.test/?${'&'.repeat(200_000)}`],
        ['userinfo markers', `http://${'@'.repeat(200_000)}`],
        ['bare separators', '://'.repeat(100_000)],
        ['keys without a value', `http://a.test/?${'k'.repeat(200_000)}`],
        ['trailing punctuation', `http://a.test/?k=${'.'.repeat(200_000)}`],
        [
            'punctuation only after the separator',
            `://${'.,;)]'.repeat(40_000)}`,
        ],
        ['separators each followed by dots', '://....'.repeat(50_000)],
    ])('stays linear on a long run of %s', (_label, hostile) => {
        const started = performance.now();
        scrubUrl(hostile);
        expect(performance.now() - started).toBeLessThan(1000);
    });

    test('a hostile input that holds no URL comes back byte-identical', () => {
        const hostile = `${'a'.repeat(200_000)}:/${'a'.repeat(200_000)}://`;
        expect(scrubUrl(hostile)).toBe(hostile);
    });
});
