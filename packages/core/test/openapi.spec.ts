// `stitch export --openapi` — emit an OpenAPI 3.1 document from a registry of stitches (the emit
// half of "reversible"). The exporter is structural: paths, methods, operationIds, the path/query
// parameters parsed from the RFC 6570 URL template, and the PRESENCE of a request body / response
// as empty `{}` schemas. Field-level JSON Schema and security are deferred. The pure `toOpenApi`
// is asserted directly; the `export` command is driven through `main` with an injected loader.
import { apiKey, basic, bearer, cookieSession, oauth2, stitch } from '../src';
import { main } from '../src/cli';
import { toOpenApi } from '../src/openapi';
import type { StitchRegistry } from '../src/registry';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-openapi-${process.pid}.jsonl`,
);

// Covers the structural cases: baseUrl+path with a path param and an output schema, a string-form
// full URL with a query template, a POST with a request body, and a thunk endpoint (unexportable).
const sampleRegistry = (): StitchRegistry => ({
    getUser: stitch({
        baseUrl: 'https://api.example.com',
        path: '/users/{id}',
        output: z.object({ id: z.number(), name: z.string() }),
    }),
    listUsers: stitch('https://api.example.com/users{?limit,cursor}'),
    createUser: stitch({
        method: 'POST',
        url: 'https://api.example.com/users',
        input: { body: z.object({ name: z.string() }) },
    }),
    dynamic: stitch({ url: () => 'https://api.example.com/whoami' }),
});

describe('toOpenApi', () => {
    test('emits a 3.1 document with one server and a path per stitch', () => {
        const { document } = toOpenApi(sampleRegistry(), {
            title: 'Example',
            version: '2.0.0',
        });
        expect(document.openapi).toBe('3.1.0');
        expect(document.info).toEqual({ title: 'Example', version: '2.0.0' });
        expect(document.servers).toEqual([{ url: 'https://api.example.com' }]);
        expect(Object.keys(document.paths).sort()).toEqual([
            '/users',
            '/users/{id}',
        ]);
    });

    test('defaults info when no title/version is given', () => {
        const { document } = toOpenApi({});
        expect(document.info).toEqual({
            title: 'StitchAPI export',
            version: '0.0.0',
        });
        expect(document.paths).toEqual({});
        expect(document.servers).toBeUndefined();
    });

    test('a path-template var becomes a required path param; an output schema → a 200 body', () => {
        const { document } = toOpenApi(sampleRegistry());
        const op = document.paths['/users/{id}']?.['get'];
        expect(op?.operationId).toBe('getUser');
        expect(op?.parameters).toEqual([
            { name: 'id', in: 'path', required: true, schema: {} },
        ]);
        expect(op?.responses['200']?.content?.['application/json']).toEqual({
            schema: {},
        });
    });

    test('query-template vars become optional query parameters', () => {
        const { document } = toOpenApi(sampleRegistry());
        const op = document.paths['/users']?.['get'];
        expect(op?.parameters).toEqual([
            { name: 'limit', in: 'query', required: false, schema: {} },
            { name: 'cursor', in: 'query', required: false, schema: {} },
        ]);
    });

    test('a declared request body → a requestBody with the body content type', () => {
        const { document } = toOpenApi(sampleRegistry());
        const op = document.paths['/users']?.['post'];
        expect(op?.requestBody?.content['application/json']).toEqual({
            schema: {},
        });
    });

    test('a thunk endpoint is skipped with a warning, never silently dropped', () => {
        const { document, warnings } = toOpenApi(sampleRegistry());
        expect(
            Object.keys(document.paths).some((p) => p.includes('whoami')),
        ).toBe(false);
        expect(warnings.some((w) => w.includes('thunk'))).toBe(true);
    });
});

describe('stitch export --openapi (CLI)', () => {
    test('writes the OpenAPI document as JSON to stdout', async () => {
        const registry: StitchRegistry = {
            getUser: stitch('https://api.example.com/users/{id}'),
        };
        let out = '';
        const code = await main(['export', '--openapi', '--module', 'x'], {
            cwd: '/',
            load: async () => registry,
            write: (s) => {
                out += s;
            },
            writeErr: () => undefined,
        });
        expect(code).toBe(0);
        const doc = JSON.parse(out) as {
            openapi: string;
            paths: Record<string, Record<string, { operationId: string }>>;
        };
        expect(doc.openapi).toBe('3.1.0');
        expect(doc.paths['/users/{id}']?.['get']?.operationId).toBe('getUser');
    });

    test('without --openapi, prints usage and exits 2', async () => {
        let err = '';
        const code = await main(['export'], {
            writeErr: (s) => {
                err += s;
            },
        });
        expect(code).toBe(2);
        expect(err).toMatch(/--openapi/);
    });

    test('--schema-module wires a converter for body schemas', async () => {
        const registry: StitchRegistry = {
            createUser: stitch({
                method: 'POST',
                url: 'https://api.example.com/users',
                input: { body: z.object({ name: z.string() }) },
            }),
        };
        let out = '';
        const code = await main(
            ['export', '--openapi', '--module', 'x', '--schema-module', 'c'],
            {
                cwd: '/',
                load: async () => registry,
                loadModule: async () => ({
                    default: (_source: unknown, info: { slot: string }) => ({
                        type: 'object',
                        'x-slot': info.slot,
                    }),
                }),
                write: (s) => {
                    out += s;
                },
                writeErr: () => undefined,
            },
        );
        expect(code).toBe(0);
        const doc = JSON.parse(out) as {
            paths: Record<
                string,
                Record<
                    string,
                    {
                        requestBody?: {
                            content: Record<string, { schema: unknown }>;
                        };
                    }
                >
            >;
        };
        expect(
            doc.paths['/users']?.['post']?.requestBody?.content[
                'application/json'
            ]?.schema,
        ).toEqual({ type: 'object', 'x-slot': 'body' });
    });
});

describe('toOpenApi with a toJsonSchema converter', () => {
    test('emits converted request and response body schemas (BYO converter)', () => {
        const seen: { slot: string; hasSource: boolean }[] = [];
        const { document } = toOpenApi(sampleRegistry(), {
            toJsonSchema: (source, info) => {
                seen.push({ slot: info.slot, hasSource: source !== undefined });
                return { type: 'object', 'x-slot': info.slot };
            },
        });

        // getUser has an output schema → its 200 body is converted.
        const getOp = document.paths['/users/{id}']?.['get'];
        expect(
            getOp?.responses['200']?.content?.['application/json']?.schema,
        ).toEqual({ type: 'object', 'x-slot': 'response' });

        // createUser has a request-body schema → its requestBody is converted.
        const postOp = document.paths['/users']?.['post'];
        expect(
            postOp?.requestBody?.content['application/json']?.schema,
        ).toEqual({ type: 'object', 'x-slot': 'body' });

        // The converter received real source schemas, not undefined.
        expect(seen.some((s) => s.slot === 'response' && s.hasSource)).toBe(
            true,
        );
        expect(seen.some((s) => s.slot === 'body' && s.hasSource)).toBe(true);
    });

    test('falls back to {} when the converter returns undefined', () => {
        const { document } = toOpenApi(sampleRegistry(), {
            toJsonSchema: () => undefined,
        });
        const getOp = document.paths['/users/{id}']?.['get'];
        expect(
            getOp?.responses['200']?.content?.['application/json']?.schema,
        ).toEqual({});
    });
});

describe('toOpenApi per-parameter schemas', () => {
    // A stitch whose path/query template vars also carry an `input.params` / `input.query` schema.
    const paramRegistry = (): StitchRegistry => ({
        getUser: stitch({
            baseUrl: 'https://api.example.com',
            path: '/users/{id}',
            input: { params: z.object({ id: z.number() }) },
        }),
        listUsers: stitch({
            url: 'https://api.example.com/users{?limit,cursor}',
            input: {
                query: z.object({
                    limit: z.number(),
                    cursor: z.string().optional(),
                }),
            },
        }),
    });

    // Decompose the converted params/query OBJECT schema into a schema per parameter, and let a
    // query param declared `required` in the schema upgrade its (template-default) optionality.
    const decomposingConverter = (
        _source: unknown,
        info: { slot: string },
    ): Record<string, unknown> | undefined => {
        if (info.slot === 'params')
            return {
                type: 'object',
                properties: { id: { type: 'integer' } },
                required: ['id'],
            };
        if (info.slot === 'query')
            return {
                type: 'object',
                properties: {
                    limit: { type: 'integer' },
                    cursor: { type: 'string' },
                },
                required: ['limit'],
            };
        return { type: 'object' };
    };

    test('a path param takes its schema from the decomposed input.params', () => {
        const { document } = toOpenApi(paramRegistry(), {
            toJsonSchema: decomposingConverter,
        });
        expect(document.paths['/users/{id}']?.['get']?.parameters).toEqual([
            {
                name: 'id',
                in: 'path',
                required: true,
                schema: { type: 'integer' },
            },
        ]);
    });

    test('query params take per-param schemas; a schema-required one upgrades to required', () => {
        const { document } = toOpenApi(paramRegistry(), {
            toJsonSchema: decomposingConverter,
        });
        expect(document.paths['/users']?.['get']?.parameters).toEqual([
            {
                name: 'limit',
                in: 'query',
                required: true,
                schema: { type: 'integer' },
            },
            {
                name: 'cursor',
                in: 'query',
                required: false,
                schema: { type: 'string' },
            },
        ]);
    });

    test('without a converter, parameters keep the {} structural default', () => {
        const { document } = toOpenApi(paramRegistry());
        expect(document.paths['/users/{id}']?.['get']?.parameters).toEqual([
            { name: 'id', in: 'path', required: true, schema: {} },
        ]);
    });

    test('a converter without `properties` leaves a parameter at {}', () => {
        const { document } = toOpenApi(paramRegistry(), {
            toJsonSchema: () => ({ type: 'object' }), // no properties to decompose
        });
        expect(document.paths['/users/{id}']?.['get']?.parameters).toEqual([
            { name: 'id', in: 'path', required: true, schema: {} },
        ]);
    });
});

describe('toOpenApi security schemes', () => {
    test('emits components.securitySchemes + per-operation security from auth', () => {
        const registry: StitchRegistry = {
            getThing: stitch({
                url: 'https://api.example.com/things/{id}',
                auth: bearer('zzz-bearer-cred'),
            }),
            listThings: stitch({
                url: 'https://api.example.com/things',
                auth: bearer('zzz-bearer-cred'), // same scheme → deduped to ONE component
            }),
            createThing: stitch({
                method: 'POST',
                url: 'https://api.example.com/things',
                auth: apiKey({ header: 'X-My-Key', value: 'zzz-apikey-cred' }),
            }),
            grant: stitch({
                url: 'https://api.example.com/grant',
                auth: oauth2({
                    tokenUrl: 'https://auth.example.com/token',
                    clientId: 'zzz-client-id',
                    clientSecret: 'zzz-client-secret',
                    scope: 'read write',
                }),
            }),
            open: stitch('https://api.example.com/open'), // no auth → no security
        };
        const { document } = toOpenApi(registry);

        // Bearer is registered once and referenced by both stitches that use it.
        expect(document.components?.securitySchemes?.['bearerAuth']).toEqual({
            type: 'http',
            scheme: 'bearer',
        });
        expect(document.paths['/things/{id}']?.['get']?.security).toEqual([
            { bearerAuth: [] },
        ]);
        expect(document.paths['/things']?.['get']?.security).toEqual([
            { bearerAuth: [] },
        ]);

        // apiKey carries the declared (non-secret) header name.
        expect(document.components?.securitySchemes?.['apiKeyAuth']).toEqual({
            type: 'apiKey',
            in: 'header',
            name: 'X-My-Key',
        });
        expect(document.paths['/things']?.['post']?.security).toEqual([
            { apiKeyAuth: [] },
        ]);

        // oauth2 carries the public token endpoint + scopes; the requirement lists the scopes.
        expect(document.components?.securitySchemes?.['oauth2']).toEqual({
            type: 'oauth2',
            flows: {
                clientCredentials: {
                    tokenUrl: 'https://auth.example.com/token',
                    scopes: { read: '', write: '' },
                },
            },
        });
        expect(document.paths['/grant']?.['get']?.security).toEqual([
            { oauth2: ['read', 'write'] },
        ]);

        // No auth → no per-operation security, and no credential value ever leaks into the spec.
        expect(document.paths['/open']?.['get']?.security).toBeUndefined();
        const json = JSON.stringify(document);
        for (const secret of [
            'zzz-bearer-cred',
            'zzz-apikey-cred',
            'zzz-client-id',
            'zzz-client-secret',
        ])
            expect(json).not.toContain(secret);
    });

    test('basic → http basic; a non-jar cookieSession → apiKey in cookie', () => {
        const registry: StitchRegistry = {
            withBasic: stitch({
                url: 'https://api.example.com/b',
                auth: basic({ user: 'u', pass: 'p' }),
            }),
            withCookie: stitch({
                url: 'https://api.example.com/c',
                auth: cookieSession({
                    cookie: 'sid',
                    login: stitch('https://api.example.com/login'),
                    scope: 'app',
                }),
            }),
        };
        const { document } = toOpenApi(registry);
        expect(document.components?.securitySchemes?.['basicAuth']).toEqual({
            type: 'http',
            scheme: 'basic',
        });
        expect(document.components?.securitySchemes?.['apiKeyAuth']).toEqual({
            type: 'apiKey',
            in: 'cookie',
            name: 'sid',
        });
    });

    test('distinct schemes that share a base name get a numeric suffix', () => {
        const registry: StitchRegistry = {
            a: stitch({
                url: 'https://api.example.com/a',
                auth: apiKey({ header: 'X-Key-A', value: 'k' }),
            }),
            b: stitch({
                url: 'https://api.example.com/b',
                auth: apiKey({ header: 'X-Key-B', value: 'k' }),
            }),
        };
        const { document } = toOpenApi(registry);
        const names = Object.keys(
            document.components?.securitySchemes ?? {},
        ).sort();
        expect(names).toEqual(['apiKeyAuth', 'apiKeyAuth2']);
    });
});
