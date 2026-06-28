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

    test('types-only emits the validation-off notice', () => {
        const r = planGen(doc, { all: true });
        expect(r.notices.join('\n')).toMatch(
            /runtime validation \+ drift are OFF/,
        );
    });
});
