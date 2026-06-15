// `stitch export --openapi` — emit an OpenAPI 3.1 document from a registry of stitches (the emit
// half of "reversible"). The exporter is structural: paths, methods, operationIds, the path/query
// parameters parsed from the RFC 6570 URL template, and the PRESENCE of a request body / response
// as empty `{}` schemas. Field-level JSON Schema and security are deferred. The pure `toOpenApi`
// is asserted directly; the `export` command is driven through `main` with an injected loader.
import { stitch } from '../src';
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
