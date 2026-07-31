// `stitch gen openapi` — eject a SELECTED set of operations from an OpenAPI document (ADR 0013).
// The planning is pure (`planGen`), asserted directly here: selection, fan-in ownership (shared vs
// private), recursive-cluster placement, naming/dedupe, the types-only notice, and auth mapping.
import { type OpenApiDoc, planGen } from '../src/gen-openapi';

const doc: OpenApiDoc = {
    openapi: '3.0.0',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    security: [{ bearerAuth: [] }],
    components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
        schemas: {
            // User ↔ Post is a reference cycle (recursive cluster).
            User: {
                type: 'object',
                required: ['id', 'name'],
                properties: {
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    posts: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Post' },
                    },
                },
            },
            Post: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'integer' },
                    author: { $ref: '#/components/schemas/User' },
                },
            },
            // Private to the single op that references it.
            Health: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
    },
    paths: {
        '/users': {
            get: {
                operationId: 'listUsers',
                tags: ['users'],
                responses: {
                    '200': {
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'array',
                                    items: {
                                        $ref: '#/components/schemas/User',
                                    },
                                },
                            },
                        },
                    },
                },
            },
            post: {
                operationId: 'createUser',
                tags: ['users'],
                requestBody: {
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/User' },
                        },
                    },
                },
                responses: {
                    '201': {
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/User' },
                            },
                        },
                    },
                },
            },
        },
        '/users/{id}': {
            get: {
                operationId: 'getUser',
                tags: ['users'],
                parameters: [
                    {
                        name: 'id',
                        in: 'path',
                        required: true,
                        schema: { type: 'integer' },
                    },
                ],
                responses: {
                    '200': {
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/User' },
                            },
                        },
                    },
                },
            },
        },
        '/health': {
            // No operationId → name is derived from method + path.
            get: {
                tags: ['ops'],
                responses: {
                    '200': {
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/Health' },
                            },
                        },
                    },
                },
            },
        },
    },
};

const file = (
    r: ReturnType<typeof planGen>,
    path: string,
): string | undefined => r.files.find((f) => f.path === path)?.contents;

describe('planGen — selection', () => {
    test('selective by default: no selector → nothing', () => {
        const r = planGen(doc, {});
        expect(r.selected).toHaveLength(0);
        expect(r.warnings.join('\n')).toMatch(/no operations selected/);
    });

    test('--tag filters to that tag', () => {
        const r = planGen(doc, { tags: ['users'] });
        expect(r.selected.map((s) => s.name).sort()).toEqual([
            'createUser',
            'getUser',
            'listUsers',
        ]);
    });

    test('--all selects everything', () => {
        const r = planGen(doc, { all: true });
        expect(r.selected).toHaveLength(4);
    });

    // P7 widening: the list-shaped filters take a bare value too — `tags: 'users'` ≡ `tags: ['users']`.
    test('P7: a bare-string tag ≡ a single-element list', () => {
        const bare = planGen(doc, { tags: 'users' });
        const list = planGen(doc, { tags: ['users'] });
        expect(bare.selected.map((s) => s.name).sort()).toEqual(
            list.selected.map((s) => s.name).sort(),
        );
        expect(bare.selected).toHaveLength(3);
    });

    test('P7: a bare-string only ≡ a single-element list', () => {
        const r = planGen(doc, { only: 'getUser' });
        expect(r.selected.map((s) => s.name)).toEqual(['getUser']);
    });
});

describe('planGen — ownership (fan-in over the transitive closure)', () => {
    test('User/Post (used by ≥2 ops, in a cycle) go to _shared/ together', () => {
        const r = planGen(doc, { all: true });
        expect(file(r, '_shared/user.ts')).toBeDefined();
        expect(file(r, '_shared/post.ts')).toBeDefined();
        // The cycle is kept together: Post imports User, User imports Post.
        expect(file(r, '_shared/user.ts')).toMatch(/import type \{ Post \}/);
        expect(file(r, '_shared/post.ts')).toMatch(/import type \{ User \}/);
    });

    test('Health (one op) is private to that op directory', () => {
        const r = planGen(doc, { all: true });
        // GET /health has no operationId → derived name getHealth → dir get-health.
        expect(file(r, 'get-health/health.ts')).toBeDefined();
        expect(file(r, '_shared/health.ts')).toBeUndefined();
        const m = (
            r.manifest as { schemas: { name: string; shared: boolean }[] }
        ).schemas;
        expect(m.find((s) => s.name === 'Health')?.shared).toBe(false);
    });

    test('flat layout inlines a private schema into the op file', () => {
        const r = planGen(doc, { all: true, layout: 'flat' });
        const f = file(r, 'get-health.ts');
        expect(f).toMatch(/type Health =/);
        expect(file(r, 'get-health/health.ts')).toBeUndefined();
    });
});

describe('planGen — naming, typing, auth, notice', () => {
    test('missing operationId → camelCase(method + path)', () => {
        const r = planGen(doc, { all: true });
        expect(r.selected.map((s) => s.name)).toContain('getHealth');
    });

    test('response type drives the stitch<T> generic', () => {
        const r = planGen(doc, { tags: ['users'] });
        expect(file(r, 'list-users/index.ts')).toMatch(
            /client\.stitch<Array<User>>/,
        );
        expect(file(r, 'get-user/index.ts')).toMatch(/client\.stitch<User>/);
    });

    test('global bearer security → seam auth with an env() placeholder', () => {
        const r = planGen(doc, { all: true });
        const c = file(r, 'client.ts');
        expect(c).toMatch(/auth: bearer\(env\('API_TOKEN'\)\)/);
        expect(c).toMatch(/import \{ seam, bearer, env \}/);
    });

    test('emitted throttle TODO uses the canonical `pool` (ThrottleOptions.scope is gone)', () => {
        const r = planGen(doc, { all: true });
        const c = file(r, 'client.ts') as string;
        expect(c).toMatch(/pool: 'host'/);
        expect(c).not.toMatch(/\bscope\b/);
    });

    // apiKey auth (CONTRACT.md P16/P22). Core's `apiKey()` models all three OpenAPI locations —
    // header (default), query, and cookie — each naming the key with `name`. The generator emits the
    // matching arm; `name`/`in` are single-quoted literals (`q()`), matching the emitted-source style.
    const apiKeyDoc = (loc: string): OpenApiDoc => ({
        openapi: '3.0.0',
        info: { title: 'T', version: '1' },
        servers: [{ url: 'https://api.example.com' }],
        security: [{ apiKeyAuth: [] }],
        components: {
            securitySchemes: {
                apiKeyAuth: { type: 'apiKey', in: loc, name: 'X-API-Key' },
            },
        },
        paths: { '/ping': { get: { operationId: 'ping', responses: {} } } },
    });

    test('apiKey in header → header key (no `in:`), no warning', () => {
        const r = planGen(apiKeyDoc('header'), { all: true });
        const c = file(r, 'client.ts') ?? '';
        expect(c).toMatch(
            /auth: apiKey\(\{ name: 'X-API-Key', value: env\('API_KEY'\) \}\)/,
        );
        expect(c).not.toMatch(/apiKey\(\{ in:/);
        expect(r.warnings.join('\n')).not.toMatch(/not auto-mapped/);
    });

    test("apiKey in query → `in: 'query'` discriminant emitted", () => {
        const r = planGen(apiKeyDoc('query'), { all: true });
        expect(file(r, 'client.ts') ?? '').toMatch(
            /auth: apiKey\(\{ in: 'query', name: 'X-API-Key', value: env\('API_KEY'\) \}\)/,
        );
    });

    // Supersedes #474's "cookie → not auto-mapped" behavior: core's cookie arm makes the cookie
    // location first-class, so the generator MAPS it instead of dropping to a warning.
    test("apiKey in cookie → `in: 'cookie'` discriminant emitted (first-class, not a warning)", () => {
        const r = planGen(apiKeyDoc('cookie'), { all: true });
        const c = file(r, 'client.ts') ?? '';
        expect(c).toMatch(
            /auth: apiKey\(\{ in: 'cookie', name: 'X-API-Key', value: env\('API_KEY'\) \}\)/,
        );
        expect(r.warnings.join('\n')).not.toMatch(/not auto-mapped/);
    });

    test('apiKey with an `in` core has no arm for → not auto-mapped, no silent header key', () => {
        const r = planGen(apiKeyDoc('matrix'), { all: true });
        // Must NOT emit an apiKey() call at all — an unmodelled location has no core arm.
        expect(file(r, 'client.ts') ?? '').not.toMatch(/apiKey\(/);
        const warn = r.warnings.join('\n');
        expect(warn).toMatch(/not auto-mapped/);
        expect(warn).toMatch(/in matrix/); // the warning names the offending location
    });

    test('types-only emits the validation-off notice', () => {
        const r = planGen(doc, { all: true });
        expect(r.notices.join('\n')).toMatch(
            /runtime validation \+ drift are OFF/,
        );
    });
});

// The codegen turns an UNTRUSTED OpenAPI document into TS source the developer compiles. Spec text
// (summary, path, param names, server URL, operationId) is attacker-controlled input. These guard
// against injection / credential-leak / crash-the-build regressions (review-sweep on merged #328).
describe('planGen — untrusted-spec safety', () => {
    // F1 (CRITICAL, build-time RCE): a `\n` in `summary` must NOT let the remainder of the string
    // escape the `//` comment and become top-level TS that RUNS when the generated file is compiled.
    test('F1: newline in summary cannot break out of the // comment (no injected top-level code)', () => {
        const evil: OpenApiDoc = {
            openapi: '3.0.0',
            info: { title: 'T', version: '1' },
            paths: {
                '/pets': {
                    get: {
                        operationId: 'listPets',
                        summary:
                            "List pets\nexport {};\nglobalThis.PWNED=1;\nrequire('child_process').execSync('id');\n// x",
                        responses: { '200': {} },
                    },
                },
            },
        };
        const r = planGen(evil, { all: true });
        const src = file(r, 'list-pets/index.ts');
        expect(src).toBeDefined();
        // The injected payload must never appear as executable top-level code — only inside a comment.
        // The generator only ever emits `import`/`export const <name>` lines itself, so `globalThis`,
        // `require(`, and a bare `export {}` are unambiguous tells of an escaped injection.
        for (const raw of (src as string).split('\n')) {
            const line = raw.trim();
            if (line.startsWith('//')) continue; // comment lines are safe (that's the point)
            expect(line).not.toMatch(/^globalThis\b/);
            expect(line).not.toMatch(/^require\(/);
            expect(line).not.toMatch(/^export\s*\{\s*\}\s*;?$/);
        }
        // The whole summary is collapsed onto the single `// ` comment line.
        expect(src).toMatch(/\/\/ List pets export \{\}; globalThis\.PWNED=1;/);
    });

    // F1 (also): a `\n` in a path is emitted into `// <METHOD> <path>` and must not break out either.
    test('F1: newline in path cannot break out of the // comment', () => {
        const evil: OpenApiDoc = {
            openapi: '3.0.0',
            info: { title: 'T', version: '1' },
            paths: {
                '/evil\nexport const PWNED = 1;\n//': {
                    get: { operationId: 'evilPath', responses: { '200': {} } },
                },
            },
        };
        const r = planGen(evil, { all: true });
        const src = file(r, 'evil-path/index.ts') as string;
        expect(src).toBeDefined();
        for (const line of src.split('\n')) {
            expect(line).not.toMatch(/^\s*export\s+const\s+PWNED/);
        }
    });

    // F1 (also): a `\n` in a query-parameter name is echoed into the `// query params:` comment.
    test('F1: newline in a query-param name cannot break out of the // comment', () => {
        const evil: OpenApiDoc = {
            openapi: '3.0.0',
            info: { title: 'T', version: '1' },
            paths: {
                '/search': {
                    get: {
                        operationId: 'search',
                        parameters: [
                            {
                                name: 'q\nexport const PWNED = 2;\n// ',
                                in: 'query',
                                schema: { type: 'string' },
                            },
                        ],
                        responses: { '200': {} },
                    },
                },
            },
        };
        const r = planGen(evil, { all: true });
        const src = file(r, 'search/index.ts') as string;
        expect(src).toBeDefined();
        for (const line of src.split('\n')) {
            expect(line).not.toMatch(/^\s*export\s+const\s+PWNED/);
        }
    });

    // F2 (HIGH, credential leak): `user:pass@` embedded in a server URL must never be baked into the
    // committed client.ts. README promises "the secret is never emitted".
    test('F2: server-url userinfo is stripped from the emitted baseUrl', () => {
        const withCreds: OpenApiDoc = {
            openapi: '3.0.0',
            info: { title: 'T', version: '1' },
            servers: [{ url: 'https://admin:s3cr3t@internal/api' }],
            paths: {
                '/x': {
                    get: { operationId: 'getX', responses: { '200': {} } },
                },
            },
        };
        const r = planGen(withCreds, { all: true });
        const client = file(r, 'client.ts') as string;
        expect(client).toBeDefined();
        expect(client).toMatch(/baseUrl:/); // baseUrl is still emitted…
        expect(client).not.toContain('s3cr3t'); // …but with no secret
        expect(client).not.toContain('admin:s3cr3t');
        expect(client).not.toMatch(/admin:s3cr3t@/);
        expect(client).toContain('internal/api'); // host/path preserved
        // And the leak isn't laundered through any other emitted file either.
        for (const f of r.files) expect(f.contents).not.toContain('s3cr3t');
    });

    // F3 (MEDIUM, reserved word): operationId "delete" must not emit `export const delete` /
    // `export { delete }` (both SyntaxErrors).
    test('F3: reserved-word operationId is prefixed, not emitted bare', () => {
        const reserved: OpenApiDoc = {
            openapi: '3.0.0',
            info: { title: 'T', version: '1' },
            paths: {
                '/pets/{id}': {
                    delete: {
                        operationId: 'delete',
                        responses: { '200': {} },
                    },
                },
            },
        };
        const r = planGen(reserved, { all: true });
        expect(r.selected.map((s) => s.name)).toContain('opDelete');
        expect(r.selected.map((s) => s.name)).not.toContain('delete');
        const index = file(r, 'index.ts') as string;
        expect(index).toMatch(/export \{ opDelete \}/);
        // No bare reserved word as an export identifier.
        expect(index).not.toMatch(/export \{ delete \}/);
        expect(index).not.toMatch(/\bconst delete\b/);
    });

    // F4 (MEDIUM, flat-layout shared-import gap): a PRIVATE inlined component that references a
    // SHARED component must still get an `import type { Shared }` in the op file, else TS2304.
    test('F4: flat-layout inlined private type imports the shared type it references', () => {
        // Wrapper is private (one op). Shared is used by two ops → placed in _shared/. Wrapper
        // references Shared, so the flat op file that inlines Wrapper must import Shared.
        const d: OpenApiDoc = {
            openapi: '3.0.0',
            info: { title: 'T', version: '1' },
            components: {
                schemas: {
                    Shared: {
                        type: 'object',
                        properties: { id: { type: 'integer' } },
                    },
                    Wrapper: {
                        type: 'object',
                        properties: {
                            item: { $ref: '#/components/schemas/Shared' },
                        },
                    },
                },
            },
            paths: {
                '/wrapped': {
                    get: {
                        operationId: 'getWrapped',
                        responses: {
                            '200': {
                                content: {
                                    'application/json': {
                                        schema: {
                                            $ref: '#/components/schemas/Wrapper',
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
                // Second consumer of Shared → forces Shared to be shared, not inlined.
                '/direct': {
                    get: {
                        operationId: 'getDirect',
                        responses: {
                            '200': {
                                content: {
                                    'application/json': {
                                        schema: {
                                            $ref: '#/components/schemas/Shared',
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        };
        const r = planGen(d, { all: true, layout: 'flat' });
        const src = file(r, 'get-wrapped.ts') as string;
        expect(src).toBeDefined();
        expect(src).toMatch(/type Wrapper =/); // Wrapper is inlined…
        // …and the shared type it references is imported (was silently dropped before the fix).
        expect(src).toMatch(
            /import type \{ Shared \} from '\.\/_shared\/shared';/,
        );
    });

    // F5 (MEDIUM, denial-of-build): a `\n` in a spec string emitted through a `'...'` literal
    // (baseUrl, path) must be escaped, not left raw (which is an unterminated-string SyntaxError).
    test('F5: newline in a path literal is escaped, not a raw newline', () => {
        const d: OpenApiDoc = {
            openapi: '3.0.0',
            info: { title: 'T', version: '1' },
            paths: {
                '/a\nb': {
                    get: { operationId: 'ab', responses: { '200': {} } },
                },
            },
        };
        const r = planGen(d, { all: true });
        const src = file(r, 'ab/index.ts') as string;
        expect(src).toBeDefined();
        // The `path: '...'` literal must contain an escaped `\n`, never a raw one.
        const m = /path: '((?:[^'\\]|\\.)*)'/.exec(src);
        expect(m).not.toBeNull();
        expect((m as RegExpExecArray)[1]).toContain('\\n');
        expect((m as RegExpExecArray)[1]).not.toContain('\n');
        // Round-trip: the emitted literal parses back to the original path.
        // eslint-disable-next-line no-eval
        expect(eval(`'${(m as RegExpExecArray)[1]}'`)).toBe('/a\nb');
    });

    // F5 (also): a `\n` in the server URL literal is escaped too.
    test('F5: newline in a baseUrl literal is escaped, not a raw newline', () => {
        const d: OpenApiDoc = {
            openapi: '3.0.0',
            info: { title: 'T', version: '1' },
            servers: [{ url: 'https://api.example.com\nBROKEN' }],
            paths: {
                '/x': {
                    get: { operationId: 'getX', responses: { '200': {} } },
                },
            },
        };
        const r = planGen(d, { all: true });
        const client = file(r, 'client.ts') as string;
        const m = /baseUrl: '((?:[^'\\]|\\.)*)'/.exec(client);
        expect(m).not.toBeNull();
        expect((m as RegExpExecArray)[1]).not.toContain('\n');
    });
});
