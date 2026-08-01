// Edge-path coverage for `stitch from-curl` (src/from-curl.ts). from-curl.spec.ts covers the
// common cases (bearer + x-api-key auth, pure-digit id lift, JSON/form bodies, -G, --zod, HAR
// json). These exercise the branches it leaves open — all pure, asserted directly:
//   - Basic auth and *query-param* api-key auth (whole recogniseAuth/renderAuth/buildImport paths
//     untested today), including that the captured secret never reaches the source;
//   - the non-numeric looksLikeId variants (UUID, long hex, url-encoded) and multi-segment param
//     naming derived from each preceding literal;
//   - a scheme-less URL that must emit `url:` rather than baseUrl/path;
//   - parseHar's form-body mimeType and out-of-range entry handling.
import { parseCurl, parseHar, toStitchSource } from '../src/from-curl';

describe('toStitchSource — auth recognition (untested strategies)', () => {
    it('maps Basic auth to basic(env(...)) and never emits the credential', () => {
        const cred = 'dXNlcjpzdXBlci1zZWNyZXQ='; // base64 user:super-secret
        const { source } = toStitchSource(
            parseCurl(
                `curl -H 'Authorization: Basic ${cred}' https://api.example.com/me`,
            ),
        );
        expect(source).not.toContain(cred);
        expect(source).toContain(
            "basic({ user: env('API_USER'), pass: env('API_PASSWORD') })",
        );
        expect(source).toContain(
            "import { stitch } from 'stitchapi';\nimport { basic, env } from 'stitchapi/auth'",
        );
    });

    it('maps an ?api_key= query param to apiKey({ in: query }) and strips the secret', () => {
        const { source } = toStitchSource(
            parseCurl(
                'curl "https://api.example.com/data?api_key=secret-123&page=2"',
            ),
        );
        expect(source).not.toContain('secret-123');
        expect(source).toContain(
            "apiKey({ in: 'query', name: 'api_key', secret: env('API_KEY') })",
        );
        expect(source).toContain(
            "import { stitch } from 'stitchapi';\nimport { apiKey, env } from 'stitchapi/auth'",
        );
        // the non-auth query param survives; the auth one is removed from the call query.
        expect(source).toContain('page: 2');
        expect(source).not.toMatch(/query:\s*{[^}]*api_key/);
    });

    it('recognises an ?access_token= query param too', () => {
        const { source } = toStitchSource(
            parseCurl(
                'curl "https://api.example.com/data?access_token=tok-xyz"',
            ),
        );
        expect(source).not.toContain('tok-xyz');
        expect(source).toContain(
            "apiKey({ in: 'query', name: 'access_token', secret: env('API_KEY') })",
        );
    });
});

describe('toStitchSource — id lifting (non-numeric segments)', () => {
    it('lifts a UUID segment, naming it from the preceding literal', () => {
        const uuid = '550e8400-e29b-41d4-a716-446655440000';
        const { source } = toStitchSource(
            parseCurl(`curl https://api.example.com/items/${uuid}`),
        );
        expect(source).toContain("path: '/items/{itemId}'");
        expect(source).toContain(`itemId: '${uuid}'`);
    });

    it('lifts a long-hex segment', () => {
        const { source } = toStitchSource(
            parseCurl('curl https://api.example.com/blobs/deadbeefdeadbeef'),
        );
        expect(source).toContain("path: '/blobs/{blobId}'");
        expect(source).toContain("blobId: 'deadbeefdeadbeef'");
    });

    it('lifts a url-encoded segment and decodes its example value', () => {
        const { source } = toStitchSource(
            parseCurl('curl https://api.example.com/users/john%40example.com'),
        );
        expect(source).toContain("path: '/users/{userId}'");
        expect(source).toContain("userId: 'john@example.com'");
    });

    it('names multiple lifts from each preceding literal', () => {
        const { source } = toStitchSource(
            parseCurl('curl https://api.example.com/users/1/posts/2'),
        );
        expect(source).toContain("path: '/users/{userId}/posts/{postId}'");
        expect(source).toContain('userId: 1');
        expect(source).toContain('postId: 2');
    });
});

describe('toStitchSource — scheme-less URL', () => {
    it('emits url: (not baseUrl/path) when the URL has no origin', () => {
        const { source } = toStitchSource(parseCurl('curl /v2/status'));
        expect(source).toContain("url: '/v2/status'");
        expect(source).not.toContain('baseUrl:');
    });
});

describe('parseCurl — small flag branches', () => {
    it('-I / --head sets method HEAD', () => {
        expect(parseCurl('curl -I https://api.example.com/x').method).toBe(
            'HEAD',
        );
        expect(parseCurl('curl --head https://api.example.com/x').method).toBe(
            'HEAD',
        );
    });

    it('warns (does not throw) when no URL is present', () => {
        const req = parseCurl('curl -X POST -H "Accept: application/json"');
        expect(req.url).toBe('');
        expect(req.warnings.some((w) => w.includes('no URL'))).toBe(true);
    });
});

describe('parseHar — body kind and entry selection', () => {
    const harWith = (entry: unknown) => ({ log: { entries: [entry] } });

    it('classifies a urlencoded postData as a form body', () => {
        const req = parseHar(
            harWith({
                request: {
                    method: 'POST',
                    url: 'https://api.example.com/u',
                    headers: [],
                    postData: {
                        mimeType: 'application/x-www-form-urlencoded',
                        text: 'a=1&b=2',
                    },
                },
            }),
        );
        expect(req.bodyType).toBe('form');
        expect(req.body).toBe('a=1&b=2');
    });

    it('warns and falls back to entry 0 for an out-of-range index', () => {
        const req = parseHar(
            harWith({
                request: {
                    method: 'GET',
                    url: 'https://api.example.com/only',
                    headers: [],
                },
            }),
            5,
        );
        expect(req.url).toBe('https://api.example.com/only');
        expect(req.warnings.some((w) => w.includes('out of range'))).toBe(true);
    });
});

describe('toStitchSource — emitted string literals stay valid TS', () => {
    const harWith = (entry: unknown) => ({ log: { entries: [entry] } });

    // The emitted source is an ESM module (`import`/`export`/top-level `await`), which
    // `new Function` can't host — neutralize just that scaffolding so `new Function` sees the
    // remaining statements and throws on any *syntax* error (an unterminated string literal being
    // the bug under test). Semantics are checked separately by the round-trip assertions below.
    const parses = (source: string): void => {
        const body = source
            .replace(/^import .*$/gm, '')
            .replace(/^export /gm, '')
            .replace(/^await /gm, '');
        // Parsing the neutralized module IS the assertion — a syntax error (an unterminated string
        // literal) throws at construction time.
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        expect(() => new Function(body)).not.toThrow();
    };

    it('escapes a newline in a header value so the emitted source parses', () => {
        const { source } = toStitchSource(
            parseHar(
                harWith({
                    request: {
                        method: 'GET',
                        url: 'https://api.example.com/x',
                        headers: [{ name: 'X-Multi', value: 'line1\nline2' }],
                    },
                }),
            ),
        );
        // Before the fix this emitted a raw newline inside `'…'` — an unterminated literal.
        expect(source).toContain("'line1\\nline2'");
        parses(source);
    });

    it('escapes a newline in a JSON body value so the emitted source parses', () => {
        const { source } = toStitchSource(
            parseHar(
                harWith({
                    request: {
                        method: 'POST',
                        url: 'https://api.example.com/x',
                        headers: [],
                        postData: {
                            mimeType: 'application/json',
                            // Valid JSON (the LF is escaped in the wire text) → parsed to an
                            // object, so the field value rides through `quote()`.
                            text: JSON.stringify({ note: 'a\nb' }),
                        },
                    },
                }),
            ),
        );
        expect(source).toContain("note: 'a\\nb'");
        parses(source);
    });

    it('escapes every ES line terminator (LF, CR, U+2028, U+2029) and round-trips the value', () => {
        // A backslash and a single quote too, to prove the escape order is right.
        const value = "a\rb\r\nc\u2028d\u2029e\\f'g";
        const { source } = toStitchSource(
            parseHar(
                harWith({
                    request: {
                        method: 'GET',
                        url: 'https://api.example.com/y',
                        headers: [{ name: 'X-Nasty', value }],
                    },
                }),
            ),
        );
        parses(source);
        // No raw line terminator survives inside the emitted literal.
        const literal = /'X-Nasty':\s*('(?:[^'\\]|\\.)*')/.exec(source)?.[1];
        expect(literal).toBeDefined();
        expect(literal).not.toMatch(/[\n\r\u2028\u2029]/);
        // …and it evaluates back to exactly the captured value (semantics preserved).
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const evalLiteral = new Function(`return ${literal}`) as () => unknown;
        expect(evalLiteral()).toBe(value);
    });

    it('leaves the common case single-quoted (no needless escaping)', () => {
        const { source } = toStitchSource(
            parseCurl("curl 'https://api.example.com/users/1'"),
        );
        expect(source).toContain("baseUrl: 'https://api.example.com'");
    });
});
