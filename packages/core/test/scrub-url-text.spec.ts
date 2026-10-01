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
            'GET https://a.test/x?token=REDACTED failed; retry http://b.test/y?page=2&api_key=REDACTED.',
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
        // the shapes that make a careless userinfo / nested-pair scan quadratic
        ['bare authorities', '://'.repeat(100_000)],
        ['user:password openers', ' //a:'.repeat(60_000)],
        ['password runs', `//u:${'/'.repeat(200_000)}`],
        ['escaped authorities', '\\/\\/a:'.repeat(60_000)],
        ['nested pairs', '?a='.repeat(130_000)],
        ['semicolon pairs', ';a'.repeat(100_000)],
        ['escaped ampersands', '\\u0026a'.repeat(60_000)],
        ['userinfo markers', `http://${'@'.repeat(200_000)}`],
        ['keys without a value', `http://a.test/?${'k'.repeat(200_000)}`],
        ['dots', `?token=${'.'.repeat(200_000)}x`],
    ])('stays linear on a long run of %s', (_name, hostile) => {
        const started = performance.now();
        scrubUrl(hostile);
        expect(performance.now() - started).toBeLessThan(1000);
    });

    test.each([
        ['letters', `${'a'.repeat(200_000)}:/${'a'.repeat(200_000)}://`],
        ['separators', '?'.repeat(200_000)],
        ['colons', ':'.repeat(200_000)],
    ])(
        'text with nothing to scrub in a long run of %s comes back identical',
        (_name, hostile) => {
            expect(scrubUrl(hostile)).toBe(hostile);
        },
    );
});

// Gaps the independent review of #891's `://`-anchored free-text scan found. This is the ONE
// scrubber (#891's `scrubUrls` is consolidated into it), so each is pinned here.
describe('scrubUrl — schemeless URLs, nested URLs, awkward userinfo, other separators', () => {
    describe('1. schemeless and relative URLs', () => {
        test.each([
            ['protocol-relative', '//u:p@h/x?token=T', '//h/x?token=REDACTED'],
            ['relative', '/v1?api_key=K', '/v1?api_key=REDACTED'],
            [
                'relative without a slash',
                'v1?api_key=K&page=2',
                'v1?api_key=REDACTED&page=2',
            ],
            [
                'quoted, as the engine prints it',
                'request URL "/v1?api_key=K" is not absolute',
                'request URL "/v1?api_key=REDACTED" is not absolute',
            ],
            [
                'protocol-relative in prose',
                'failed for //u:pw@h.test/x',
                'failed for //h.test/x',
            ],
        ])('%s', (_name, input, expected) => {
            expect(scrubUrl(input)).toBe(expected);
        });
    });

    describe('2. a URL nested in a benign value is scanned', () => {
        test.each([
            [
                'a secret query pair inside',
                'next=https://o/?token=INNER',
                'next=https://o/?token=REDACTED',
            ],
            [
                'inside a query',
                '/a?next=https://o/?token=INNER&x=1',
                '/a?next=https://o/?token=REDACTED&x=1',
            ],
            [
                'userinfo inside',
                '/a?next=https://u:pw@o/',
                '/a?next=https://o/',
            ],
            [
                'protocol-relative userinfo inside',
                '/a?next=//u:pw@o/&x=1',
                '/a?next=//o/&x=1',
            ],
            [
                'two levels deep',
                '/a?n=https://o/?m=https://p/?token=DEEP',
                '/a?n=https://o/?m=https://p/?token=REDACTED',
            ],
            [
                'a nested fragment',
                '/a?back=https://o/cb#access_token=INNER',
                '/a?back=https://o/cb#access_token=REDACTED',
            ],
            [
                'a secret value holding a raw `?`',
                'https://h/?api_key=ab?cd&x=1',
                'https://h/?api_key=REDACTED&x=1',
            ],
        ])('%s', (_name, input, expected) => {
            expect(scrubUrl(input)).toBe(expected);
        });
    });

    describe('3. a raw `/`, `?` or `#` in a userinfo password', () => {
        test.each([
            ['slash', 'https://u:ab/cd@h/x', 'https://h/x'],
            ['question mark', 'https://u:ab?cd@h/x', 'https://h/x'],
            ['hash', 'https://u:ab#cd@h/x', 'https://h/x'],
            [
                'base64 with `+`, `/` and `=`',
                'https://u:Zm9v/YmFy+Zg==@h.test/x?a=1',
                'https://h.test/x?a=1',
            ],
            ['protocol-relative', '//u:ab/cd@h/x', '//h/x'],
            [
                'in a message',
                'Failed to parse URL from https://svc:p/w@api.test:99999/v1',
                'Failed to parse URL from https://api.test:99999/v1',
            ],
        ])('%s', (_name, input, expected) => {
            expect(scrubUrl(input)).toBe(expected);
        });

        test.each([
            'https://h:8080/@scope/pkg', // a port, then a path that starts with `@`
            'https://registry.test:4873/@scope%2fpkg',
            'https://medium.com/@user/post',
            'https://h/@user',
            'https://h.test/a//b@c',
            'https://h/a?mail=x@y.test#a@b',
        ])('a `@` that starts a path is not userinfo: %s', (clean) => {
            expect(scrubUrl(clean)).toBe(clean);
        });

        test('an ordinary userinfo still runs to the LAST `@` of the authority, and no further', () => {
            expect(scrubUrl('https://u:p@h/a@b')).toBe('https://h/a@b');
            expect(scrubUrl('https://u:p@ss@h/x')).toBe('https://h/x');
        });
    });

    describe('4. `;`-separated pairs and JSON-escaped URLs', () => {
        test.each([
            [
                'semicolon-separated pairs',
                '/a?x=1;token=T;y=2',
                '/a?x=1;token=REDACTED;y=2',
            ],
            [
                'a matrix-style param',
                '/a;api_key=K;v=2',
                '/a;api_key=REDACTED;v=2',
            ],
            [
                'an HTML-escaped ampersand',
                '/a?x=1&amp;token=T',
                '/a?x=1&amp;token=REDACTED',
            ],
            [
                'JSON-escaped slashes and userinfo',
                '{"url":"https:\\/\\/u:pw@h\\/x?a=1"}',
                '{"url":"https:\\/\\/h\\/x?a=1"}',
            ],
            [
                'JSON-escaped slashes with a query secret',
                '{"url":"https:\\/\\/u:pw@h\\/x?a=1&token=T"}',
                '{"url":"https:\\/\\/h\\/x?a=1&token=REDACTED"}',
            ],
            [
                "JSON-escaped slashes and Go's escaped ampersand (backslash, u0026)",
                '{"url":"https:\\/\\/u:pw@h\\/x?a=1\\u0026token=T\\u0026b=2"}',
                '{"url":"https:\\/\\/h\\/x?a=1\\u0026token=REDACTED\\u0026b=2"}',
            ],
            [
                'a JSON-escaped protocol-relative URL',
                '"\\/\\/u:pw@h\\/x"',
                '"\\/\\/h\\/x"',
            ],
        ])('%s', (_name, input, expected) => {
            expect(scrubUrl(input)).toBe(expected);
        });
    });

    describe('5. a secret value stops at the punctuation around it', () => {
        test.each([
            [
                'a closing parenthesis',
                'see (https://h/x?api_key=K) now',
                'see (https://h/x?api_key=REDACTED) now',
            ],
            [
                'a closing bracket',
                '[https://h/y?token=T]',
                '[https://h/y?token=REDACTED]',
            ],
            [
                'a comma',
                'https://h/y?token=T, then',
                'https://h/y?token=REDACTED, then',
            ],
            [
                'a list',
                '[https://h/a?token=A,https://h/b?token=B]',
                '[https://h/a?token=REDACTED,https://h/b?token=REDACTED]',
            ],
            [
                'a semicolon',
                'https://h/y?token=T; retry',
                'https://h/y?token=REDACTED; retry',
            ],
            [
                'a period inside the value (a JWT) is part of the secret',
                'GET https://h/x?token=eyJhbGci.eyJzdWIi.sig, then',
                'GET https://h/x?token=REDACTED, then',
            ],
            [
                "a sentence's closing period stays outside it",
                'then https://h/z?sig=S.',
                'then https://h/z?sig=REDACTED.',
            ],
            [
                'a closing period after a JWT too',
                'GET https://h/x?token=eyJhbGci.eyJzdWIi.sig.',
                'GET https://h/x?token=REDACTED.',
            ],
        ])('%s', (_name, input, expected) => {
            expect(scrubUrl(input)).toBe(expected);
        });
    });

    describe('6. a `}` after a secret is text, not a template', () => {
        test.each([
            [
                'a URL closing a JSON-ish bag',
                '{u: https://h/x?token=S}',
                '{u: https://h/x?token=REDACTED}',
            ],
            [
                'a brace between pairs',
                '/a?token=S}&b=1',
                '/a?token=REDACTED}&b=1',
            ],
            [
                'a secret then a brace then more text',
                'see {https://h/x?api_key=K} and {https://h/y?sig=Z}',
                'see {https://h/x?api_key=REDACTED} and {https://h/y?sig=REDACTED}',
            ],
        ])('%s', (_name, input, expected) => {
            expect(scrubUrl(input)).toBe(expected);
        });

        test.each([
            '/a?token={token}',
            '/a?token={token}&x={x}',
            '/a?token=pre{token}post',
            '/a?token={a}}',
            'https://h/{id}?api_key={apiKey}',
        ])('a `{` still opens a template slot, left as written: %s', (tpl) => {
            expect(scrubUrl(tpl)).toBe(tpl);
        });
    });

    // The three properties every scrubbed form shares.
    const CORPUS = [
        '//u:p@h/x?token=T',
        '/v1?api_key=K',
        '/a?next=https://o/?token=INNER&x=1',
        '/a?next=//u:pw@o/&x=1',
        'https://u:ab/cd@h/x',
        'https://u:Zm9v/YmFy+Zg==@h.test/x?a=1',
        'https://u:p@ss@h/x',
        '/a?x=1;token=T;y=2',
        '{"url":"https:\\/\\/u:pw@h\\/x?a=1&token=T"}',
        '{"url":"https:\\/\\/h\\/x?a=1\\u0026token=T"}',
        '{u: https://h/x?token=S}',
        '/a?token=S}&b=1',
        'see (https://h/x?api_key=K) and [https://h/y?token=T], then https://h/z?sig=S.',
        'https://h/?api_key=ab?cd&x=1',
        'https://h/?a=?a=?a=?token=X',
        'https://h/cb#access_token=T&state=s',
        'Failed to parse URL from http://ops:p@ss@api.test:99999/v1?api_key=k&page=1#frag',
        '{"a":"https://x.test/?k=1&token=a&token=b","n":"https://y.test/?sig=z"}',
        'https://h/a{?page,token}',
        'https://h/a?token={token}&x={x}',
    ];

    test.each(CORPUS)(
        'idempotent: scrubbing a scrubbed form changes nothing: %s',
        (input) => {
            const once = scrubUrl(input);
            expect(scrubUrl(once)).toBe(once);
        },
    );

    test.each(CORPUS)('no secret literal survives: %s', (input) => {
        expect(scrubUrl(input)).not.toMatch(
            /INNER|DEEP|pw|:p@|u:ab|Zm9v|YmFy|=T\b|=K\b|=a\b|=b\b|=S\b|ab\?cd|=k&|ss@|\bcd@/,
        );
    });

    test.each([
        'plain prose with no url at all',
        'a == b && c@d // a comment, not a URL',
        'ask bob@example.com about https://example.com/docs/a@b',
        'select * from t where a=1 and b=2;',
        'key=value; other=thing (see ?help) [1,2,3]',
        'https://example.com/path;jsessionid=ABC123?page=2',
        'C:\\Users\\me\\file.txt and http://localhost:3000/@me',
        'the ratio 3:4 // and 12:30',
        'foo?bar=baz&qux=1#frag',
        '{"ok":true,"url":"https://a.test/x?page=2&sort=asc","n":3}',
        '$ curl -H "Accept: */*" https://a.test/x?limit=10',
    ])('non-URL text and benign URLs are not damaged: %s', (clean) => {
        expect(scrubUrl(clean)).toBe(clean);
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
    ['Idempotency-Key', false], // a dedupe token worth reading when debugging
    ['x-idempotency-key', false],
    ['Sec-WebSocket-Key', false], // a handshake nonce
    ['Surrogate-Key', false], // a CDN purge tag
    ['X-Cache-Key', false],
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

    test('a payload: a secret name taints every string beneath it, however deep and whatever its key', () => {
        expect(
            redactKeys(
                {
                    api_keys: ['A1'],
                    tokens: ['T1'],
                    refresh_tokens: ['R1'],
                    credentials: { pass: 'P1', key: 'K1' },
                    apiKeys: [{ key: 'sk-live-abc' }],
                    secrets: {
                        a: { b: ['x', { c: 'y', n: 3, ok: true, no: null }] },
                    },
                    // not under a secret name: untouched
                    items: [{ id: 'i1' }, 'plain'],
                    profile: { name: 'Ada' },
                },
                undefined,
                true,
            ),
        ).toEqual({
            api_keys: ['[REDACTED]'],
            tokens: ['[REDACTED]'],
            refresh_tokens: ['[REDACTED]'],
            credentials: { pass: '[REDACTED]', key: '[REDACTED]' },
            apiKeys: [{ key: '[REDACTED]' }],
            secrets: {
                a: {
                    b: [
                        '[REDACTED]',
                        { c: '[REDACTED]', n: 3, ok: true, no: null },
                    ],
                },
            },
            items: [{ id: 'i1' }, 'plain'],
            profile: { name: 'Ada' },
        });
    });

    test('a map is not tainted: a secret name redacts its own value only', () => {
        expect(
            redactKeys({
                authorization: 'a',
                'x-trace': 'b',
                nested: { api_key: 'c' },
            }),
        ).toEqual({
            authorization: '[REDACTED]',
            'x-trace': 'b',
            nested: { api_key: '[REDACTED]' },
        });
    });

    test('a payload: only strings are redacted; code / key / auth are data', () => {
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
