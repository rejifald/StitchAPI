// `scrubUrl` (src/util.ts) is textual: it rewrites a string in place instead of parsing it, so one
// function serves a config endpoint of ANY shape and the free text of an error message. These pin
// the shapes (#873 review: a relative or templated endpoint used to slip through `new URL`), the
// free-text behaviour a URL quoted in prose or JSON needs, and that the scan stays linear on
// hostile text. The `redactKeys` modes that share its denylist are pinned at the bottom.
import { redactKeys, scrubUrl } from '../src/util';

import { describe, expect, test } from 'vitest';

describe('scrubUrl — endpoint shapes', () => {
    test.each([
        [
            'absolute',
            'https://u:p@h.test/a?x=1&api_key=K',
            'https://h.test/a?x=1&api_key=REDACTED',
        ],
        ['relative path', '/a/b?token=K&page=2', '/a/b?token=REDACTED&page=2'],
        ['relative, no slash', 'a?secret=K', 'a?secret=REDACTED'],
        [
            'protocol-relative with userinfo',
            '//u:p@h.test/a?sig=K',
            '//h.test/a?sig=REDACTED',
        ],
        ['userinfo only', 'https://svc@h.test/a', 'https://h.test/a'],
        [
            'an `@` in the password (last `@` ends userinfo)',
            'http://ops:p@ss@h.test/',
            'http://h.test/',
        ],
        [
            'an unparseable port',
            'http://u:p@h.test:99999/v1?api_key=K',
            'http://h.test:99999/v1?api_key=REDACTED',
        ],
        [
            'repeated key keeps its arity',
            'https://h.test/?token=a&token=b',
            'https://h.test/?token=REDACTED&token=REDACTED',
        ],
        [
            'a fragment pair (OAuth implicit flow)',
            'https://h.test/cb#access_token=K&state=s',
            'https://h.test/cb#access_token=REDACTED&state=s',
        ],
        [
            'an encoded key is decoded for the denylist',
            'https://h.test/?api%5Fkey=K&page=1',
            'https://h.test/?api%5Fkey=REDACTED&page=1',
        ],
        [
            'a malformed escape matches the raw spelling',
            'https://h.test/?token%=K&page=1',
            'https://h.test/?token%=REDACTED&page=1',
        ],
        [
            'an empty value',
            'https://h.test/?api_key=&page=1',
            'https://h.test/?api_key=REDACTED&page=1',
        ],
        [
            'a `?` after the `#` is fragment text, not a pair',
            'https://h.test/p#a?b',
            'https://h.test/p#a?b',
        ],
    ])('%s', (_name, input, expected) => {
        expect(scrubUrl(input)).toBe(expected);
    });

    test('a clean URL — any shape — comes back byte-for-byte', () => {
        for (const clean of [
            'https://api.example.com/x',
            'https://api.example.com',
            'https://h.test/x?page=2&sort=name#top',
            '/relative/a b?x=1',
            '',
            'stitch',
            'shell:ls -la',
            'https://h.test/@handle/a//b@c',
        ])
            expect(scrubUrl(clean)).toBe(clean);
    });
});

describe('scrubUrl — RFC 6570 templates are parameter names, not credentials', () => {
    test.each([
        'https://h.test/a{?page,token}',
        'https://h.test/a{?api_key}',
        'https://h.test/a{&token}',
        'https://h.test/a?api_key={apiKey}',
        'https://h.test/a?page={page}&token={token}',
        'https://{user}:{pass}@h.test/a',
        '{+base}/a/{id}{?token}',
        'https://h.test/a%7Bb%7D',
    ])('%s is left exactly as written', (template) => {
        expect(scrubUrl(template)).toBe(template);
    });

    test('a literal credential next to a template is still scrubbed', () => {
        expect(scrubUrl('https://h.test/a/{id}?api_key=K&page={page}')).toBe(
            'https://h.test/a/{id}?api_key=REDACTED&page={page}',
        );
    });
});

describe('scrubUrl — free text that quotes URLs', () => {
    test('scrubs every URL in the text and leaves the prose around it alone', () => {
        expect(
            scrubUrl(
                'GET https://u:pw@a.test/x?token=t1 failed; retry http://b.test/y?page=2&api_key=k2.',
            ),
        ).toBe(
            'GET https://a.test/x?token=REDACTED failed; retry http://b.test/y?page=2&api_key=REDACTED',
        );
    });

    test('text with no URL, and a clean URL in prose, come back byte-identical', () => {
        const clean =
            'see https://a.test/x?page=2&sort=asc (and ftp://b.test/)';
        expect(scrubUrl(clean)).toBe(clean);
        expect(scrubUrl('no url here: a://')).toBe('no url here: a://');
        expect(scrubUrl('')).toBe('');
    });

    test('a URL the WHATWG parser rejects is scrubbed like any other', () => {
        expect(
            scrubUrl(
                'Failed to parse URL from http://ops:p@ss@api.test:99999/v1?api_key=k&page=1#frag',
            ),
        ).toBe(
            'Failed to parse URL from http://api.test:99999/v1?api_key=REDACTED&page=1#frag',
        );
    });

    test('a URL ends at a quote, a bracket or a backslash, so JSON-ish text stays intact', () => {
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

    test('a scheme-prefixed token and a protocol-relative URL after a space', () => {
        expect(scrubUrl('1+http://u:pw@a.test:99999/')).toBe(
            '1+http://a.test:99999/',
        );
        expect(scrubUrl('request to //u:pw@a.test/x failed')).toBe(
            'request to //a.test/x failed',
        );
    });

    test('prose that merely contains `//` or `@` is not touched', () => {
        const prose = 'ask bob@example.com // see the docs for a//b@c';
        expect(scrubUrl(prose)).toBe(prose);
    });

    test.each([
        ['letters', `${'a'.repeat(200_000)}:/${'a'.repeat(200_000)}://`],
        ['separators', '?'.repeat(200_000)],
        ['slashes', '/'.repeat(200_000)],
        ['pairs', '&a'.repeat(100_000)],
        ['userinfo-like', `//${'a'.repeat(200_000)}`],
        ['colons', ':'.repeat(200_000)],
    ])('stays linear on a long run of %s', (_name, hostile) => {
        const started = performance.now();
        expect(scrubUrl(hostile)).toBe(hostile);
        expect(performance.now() - started).toBeLessThan(1000);
    });
});

// The ONE header-name rule set. `@stitchapi/query-core` and `@stitchapi/swr` mirror it (they cannot
// import core's internal helper without a new public export), and each package's spec pins THIS
// SAME table — change a row here and the two mirrors fail until they follow.
const HEADER_NAME_TABLE: readonly (readonly [string, boolean])[] = [
    ['authorization', true],
    ['Proxy-Authorization', true],
    ['cookie', true],
    ['Set-Cookie', true],
    ['x-api-key', true],
    ['api-key', true], // Azure OpenAI
    ['Ocp-Apim-Subscription-Key', true], // Azure API Management
    ['X-RapidAPI-Key', true],
    ['x-goog-api-key', true],
    ['x-session-id', true],
    ['x-auth-token', true],
    ['x-csrf-token', true],
    ['x-client-secret', true],
    ['x-amz-signature', true],
    ['accept', false],
    ['accept-language', false],
    ['content-type', false],
    ['user-agent', false],
    ['x-request-id', false],
    ['if-none-match', false],
];

describe('redactKeys — header names', () => {
    test.each(HEADER_NAME_TABLE)('%s → secret: %s', (name, secret) => {
        const out = redactKeys({ [name]: 'value' }) as Record<string, string>;
        expect(out[name]).toBe(secret ? '[REDACTED]' : 'value');
    });
});

describe('redactKeys — two grammars', () => {
    test('a map (headers / query): the denylist, the header suffix rules and every stem, any value', () => {
        const out = redactKeys({
            Authorization: 'a',
            'api-key': 'b',
            'Ocp-Apim-Subscription-Key': 'c',
            'X-RapidAPI-Key': 'd',
            'x-goog-api-key': 'e',
            'x-session-id': 'f',
            'x-auth-token': 'g',
            'x-client-secret': 'h',
            code: 'i', // a credential in a URL query
            key: 123, // …whatever its type
            'accept-language': 'en',
            'x-request-id': 'r1',
        });
        expect(out).toEqual({
            Authorization: '[REDACTED]',
            'api-key': '[REDACTED]',
            'Ocp-Apim-Subscription-Key': '[REDACTED]',
            'X-RapidAPI-Key': '[REDACTED]',
            'x-goog-api-key': '[REDACTED]',
            'x-session-id': '[REDACTED]',
            'x-auth-token': '[REDACTED]',
            'x-client-secret': '[REDACTED]',
            code: '[REDACTED]',
            key: '[REDACTED]',
            'accept-language': 'en',
            'x-request-id': 'r1',
        });
    });

    test('a payload: only a non-empty string under a secret-named key; code / key / auth are data', () => {
        expect(
            redactKeys(
                {
                    max_tokens: 10,
                    usage: { total_tokens: 3 },
                    signature_valid: false,
                    password: '',
                    secret: null,
                    code: 'E1',
                    key: 'k',
                    auth: 'basic',
                    client_secret: 's',
                    items: [{ api_key: 'k' }, 'plain'],
                },
                undefined,
                true,
            ),
        ).toEqual({
            max_tokens: 10,
            usage: { total_tokens: 3 },
            signature_valid: false,
            password: '',
            secret: null,
            code: 'E1',
            key: 'k',
            auth: 'basic',
            client_secret: '[REDACTED]',
            items: [{ api_key: '[REDACTED]' }, 'plain'],
        });
    });

    test('the `denylist` widens either grammar and a Date passes through as itself', () => {
        const when = new Date(0);
        expect(redactKeys({ 'x-acme': 'v', at: when }, ['x-acme'])).toEqual({
            'x-acme': '[REDACTED]',
            at: when,
        });
        const out = redactKeys(
            { nested: { 'x-acme': 'v', at: when } },
            ['x-acme'],
            true,
        ) as {
            nested: { at: Date };
        };
        expect(out.nested.at).toBe(when);
    });

    test('a class instance is walked by its own fields, so a DTO cannot carry a secret through', () => {
        class Login {
            username = 'svc';
            password = 'pw';
        }
        expect(redactKeys({ body: new Login() }, undefined, true)).toEqual({
            body: { username: 'svc', password: '[REDACTED]' },
        });
    });

    test('never mutates its input', () => {
        const input = {
            headers: { authorization: 'a' },
            body: { password: 'p' },
        };
        const copy = structuredClone(input);
        redactKeys(input, undefined, true);
        expect(input).toEqual(copy);
    });
});
