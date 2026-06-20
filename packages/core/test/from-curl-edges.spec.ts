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
            "import { stitch, basic, env } from 'stitchapi'",
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
            "apiKey({ in: 'query', name: 'api_key', value: env('API_KEY') })",
        );
        expect(source).toContain(
            "import { stitch, apiKey, env } from 'stitchapi'",
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
            "apiKey({ in: 'query', name: 'access_token', value: env('API_KEY') })",
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
        expect(req.bodyKind).toBe('form');
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
        expect(req.warnings.some((w) => w.includes('out of range'))).toBe(
            true,
        );
    });
});
