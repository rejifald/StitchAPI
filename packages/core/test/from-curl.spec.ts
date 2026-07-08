// `stitch from-curl` — scaffold a stitch from ONE example (a curl command line or a single HAR
// entry). The heavy lifting is pure (`parseCurl`/`parseHar`/`toStitchSource`), asserted directly;
// the command path is driven through `main` with an injected IO, like openapi.spec.ts / cli.spec.ts.
import { main } from '../src/cli';
import type { CliIO } from '../src/cli';
import { parseCurl, parseHar, toStitchSource } from '../src/from-curl';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-from-curl-${process.pid}.jsonl`,
);

describe('parseCurl', () => {
    test('a bare GET URL', () => {
        const req = parseCurl('curl https://api.example.com/users/1');
        expect(req.url).toBe('https://api.example.com/users/1');
        expect(req.method).toBeUndefined();
        expect(req.body).toBeUndefined();
    });

    test('-X, repeatable -H, and a quoted URL', () => {
        const req = parseCurl(
            `curl -X DELETE -H 'Accept: application/json' -H 'X-Trace: 1' 'https://api.example.com/things/9'`,
        );
        expect(req.method).toBe('DELETE');
        expect(req.url).toBe('https://api.example.com/things/9');
        expect(req.headers).toEqual([
            { name: 'Accept', value: 'application/json' },
            { name: 'X-Trace', value: '1' },
        ]);
    });

    test('line-continuations join into one command', () => {
        const req = parseCurl(
            'curl https://api.example.com/users \\\n  -H "Accept: application/json"',
        );
        expect(req.url).toBe('https://api.example.com/users');
        expect(req.headers).toEqual([
            { name: 'Accept', value: 'application/json' },
        ]);
    });

    test('an already-split argv form is accepted', () => {
        const req = parseCurl([
            'curl',
            '-H',
            'X-A: b',
            'https://api.example.com/x',
        ]);
        expect(req.url).toBe('https://api.example.com/x');
        expect(req.headers).toEqual([{ name: 'X-A', value: 'b' }]);
    });

    test('-d JSON → bodyType json; --data-urlencode → form', () => {
        const json = parseCurl(
            `curl -d '{"name":"Ada"}' https://api.example.com/users`,
        );
        expect(json.bodyType).toBe('json');
        const form = parseCurl(
            'curl --data-urlencode q=ada https://api.example.com/s',
        );
        expect(form.bodyType).toBe('form');
    });

    test('an unknown flag warns and does not crash', () => {
        const req = parseCurl('curl --frobnicate https://api.example.com/x');
        expect(req.url).toBe('https://api.example.com/x');
        expect(req.warnings.some((w) => w.includes('--frobnicate'))).toBe(true);
    });
});

describe('toStitchSource', () => {
    test('GET with an id-like path segment lifts a {param}', () => {
        const { source, warnings } = toStitchSource(
            parseCurl('curl https://api.example.com/users/1'),
        );
        expect(source).toContain("baseUrl: 'https://api.example.com'");
        expect(source).toContain("path: '/users/{userId}'");
        // The call shows the lifted param with its example value.
        expect(source).toContain('params: {');
        expect(source).toContain('userId: 1');
        // No --zod → a comment, not an output schema.
        expect(source).toContain('add an output schema');
        expect(source).not.toContain('output:');
        // The lift is announced so a false positive can be reverted.
        expect(warnings.some((w) => w.includes('lifted path segment'))).toBe(
            true,
        );
    });

    test('a Bearer token never appears in the source; bearer(env(...)) does', () => {
        const secret = 'sk-super-secret-token-zzz';
        const { source } = toStitchSource(
            parseCurl(
                `curl -H 'Authorization: Bearer ${secret}' https://api.example.com/me`,
            ),
        );
        expect(source).not.toContain(secret);
        expect(source).toContain("bearer(env('API_TOKEN'))");
        // The import line carries exactly the symbols used.
        expect(source).toContain(
            "import { stitch, bearer, env } from 'stitchapi'",
        );
        // The Authorization header is consumed by auth, not echoed into static headers.
        expect(source).not.toMatch(/headers:\s*{[^}]*authorization/i);
    });

    test('a POST JSON body sets method + bodyType json and shows the example', () => {
        const { source } = toStitchSource(
            parseCurl(
                `curl -d '{"name":"Ada","age":36}' https://api.example.com/users`,
            ),
        );
        expect(source).toContain("method: 'POST'");
        expect(source).toContain("bodyType: 'json'");
        expect(source).toContain('body: {');
        expect(source).toContain("name: 'Ada'");
        expect(source).toContain('age: 36');
    });

    test('a form -d sets bodyType form and a parsed-pairs body', () => {
        const { source } = toStitchSource(
            parseCurl(
                'curl -d name=Ada -d city=Kyiv https://api.example.com/u',
            ),
        );
        expect(source).toContain("method: 'POST'");
        expect(source).toContain("bodyType: 'form'");
        expect(source).toContain("name: 'Ada'");
        expect(source).toContain("city: 'Kyiv'");
    });

    test('-G folds the data into query, not the body', () => {
        const { source } = toStitchSource(
            parseCurl('curl -G -d q=ada -d limit=10 https://api.example.com/s'),
        );
        expect(source).not.toContain('bodyType');
        expect(source).not.toContain('body:');
        expect(source).toContain('query: {');
        expect(source).toContain("q: 'ada'");
        expect(source).toContain('limit: 10');
    });

    test('an x-api-key header → apiKey({ value: env(API_KEY) }), secret stripped', () => {
        const key = 'apikey-zzz-1234567890';
        const { source } = toStitchSource(
            parseCurl(
                `curl -H 'X-API-Key: ${key}' https://api.example.com/data`,
            ),
        );
        expect(source).not.toContain(key);
        expect(source).toContain("apiKey({ value: env('API_KEY') })");
        expect(source).toContain(
            "import { stitch, apiKey, env } from 'stitchapi'",
        );
    });

    test('--zod emits an output schema inferred from a sample response', () => {
        const { source } = toStitchSource(
            parseCurl('curl https://api.example.com/users/1'),
            { zod: true, response: '{"id":1,"name":"Ada"}' },
        );
        expect(source).toContain("import { z } from 'zod'");
        expect(source).toContain('output: z.object({');
        expect(source).toContain('id: z.number()');
        expect(source).toContain('name: z.string()');
    });

    test('--name overrides the derived export name', () => {
        const { source } = toStitchSource(
            parseCurl('curl https://api.example.com/users/1'),
            { name: 'fetchUser' },
        );
        expect(source).toContain('export const fetchUser = stitch({');
    });
});

describe('parseHar', () => {
    const har = {
        log: {
            entries: [
                {
                    request: {
                        method: 'POST',
                        url: 'https://api.example.com/items',
                        headers: [
                            { name: ':authority', value: 'api.example.com' },
                            { name: 'content-type', value: 'application/json' },
                            { name: 'authorization', value: 'Bearer har-tok' },
                        ],
                        postData: {
                            mimeType: 'application/json',
                            text: '{"sku":"abc"}',
                        },
                    },
                },
            ],
        },
    };

    test('reads ONE entry (method, url, headers, postData)', () => {
        const req = parseHar(har);
        expect(req.method).toBe('POST');
        expect(req.url).toBe('https://api.example.com/items');
        // The HTTP/2 pseudo-header is dropped.
        expect(req.headers.some((h) => h.name.startsWith(':'))).toBe(false);
        expect(req.bodyType).toBe('json');
        expect(req.body).toBe('{"sku":"abc"}');
    });

    test('toStitchSource on the HAR request strips the Bearer secret', () => {
        const { source } = toStitchSource(parseHar(har));
        expect(source).not.toContain('har-tok');
        expect(source).toContain("bearer(env('API_TOKEN'))");
        expect(source).toContain("bodyType: 'json'");
    });

    test('an empty HAR warns instead of throwing', () => {
        const req = parseHar({ log: { entries: [] } });
        expect(req.url).toBe('');
        expect(req.warnings.length).toBeGreaterThan(0);
    });
});

// ---- the CLI command, driven through main() with an injected IO ----
function injectedIO(overrides: Partial<CliIO>): Partial<CliIO> {
    return {
        cwd: '/',
        write: () => undefined,
        writeErr: () => undefined,
        ...overrides,
    };
}

describe('stitch from-curl (CLI)', () => {
    test('writes the emitted source to stdout', async () => {
        let out = '';
        const code = await main(
            ['from-curl', 'curl https://api.example.com/users/1'],
            injectedIO({
                write: (s) => {
                    out += s;
                },
            }),
        );
        expect(code).toBe(0);
        expect(out).toContain('export const getUsers = stitch({');
        expect(out).toContain("path: '/users/{userId}'");
    });

    test('warnings go to stderr, prefixed', async () => {
        let err = '';
        const code = await main(
            ['from-curl', 'curl https://api.example.com/users/1'],
            injectedIO({
                writeErr: (s) => {
                    err += s;
                },
            }),
        );
        expect(code).toBe(0);
        expect(err).toMatch(/warning: .*lifted path segment/);
    });

    test('no input prints usage and exits 2', async () => {
        let err = '';
        const code = await main(
            ['from-curl'],
            injectedIO({
                writeErr: (s) => {
                    err += s;
                },
            }),
        );
        expect(code).toBe(2);
        expect(err).toMatch(/usage: stitch from-curl/);
    });

    test('--from-har reads a single entry via io.readFileText', async () => {
        const har = JSON.stringify({
            log: {
                entries: [
                    {
                        request: {
                            method: 'GET',
                            url: 'https://api.example.com/ping',
                            headers: [],
                        },
                    },
                ],
            },
        });
        let out = '';
        const code = await main(
            ['from-curl', '--from-har', 'sample.har'],
            injectedIO({
                readFileText: async () => har,
                write: (s) => {
                    out += s;
                },
            }),
        );
        expect(code).toBe(0);
        expect(out).toContain("path: '/ping'");
    });

    test('--name + --zod with a --response sample emits a named const + schema', async () => {
        let out = '';
        const code = await main(
            [
                'from-curl',
                'curl https://api.example.com/users/1',
                '--name',
                'fetchUser',
                '--zod',
                '--response',
                'resp.json',
            ],
            injectedIO({
                readFileText: async () => '{"id":1,"name":"Ada"}',
                write: (s) => {
                    out += s;
                },
            }),
        );
        expect(code).toBe(0);
        expect(out).toContain('export const fetchUser = stitch({');
        expect(out).toContain('output: z.object({');
        expect(out).toContain("import { z } from 'zod'");
    });
});
