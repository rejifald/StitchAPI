// graphql as a Surface (ADR 0005 Stage 4): graphql's request shaping + "200-with-errors is a
// failure" now live in the graphql surface's hooks, and the engine dispatches to those hooks
// GENERICALLY — it no longer special-cases `kind === 'graphql'`. Proven below by the graphql
// behaviour (unchanged) plus custom surfaces routed through the same engine. Plus a static
// `headers` config field.
import { env, graphql, stitch } from '../src';
import type { Surface } from '../src';
import { apiKey } from '../src/auth';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-gql-${process.pid}.jsonl`,
);

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});

describe('GraphQL kind', () => {
    test('POSTs { query, variables }, sends auth, and unwraps data', async () => {
        process.env['GQL_KEY'] = 'gql_tok';
        server.route('POST', '/graphql', {
            body: { data: { thing: { name: 'Ada' } } },
        });

        const query = graphql({
            baseUrl: server.url,
            query: 'query($id: ID) { thing(id: $id) { name } }',
            auth: apiKey({ header: 'apikey', value: env('GQL_KEY') }),
        });

        const out = await query({ variables: { id: 1 } });
        expect(out).toEqual({ thing: { name: 'Ada' } }); // unwrapped `data`

        const call = server.calls('/graphql')[0];
        expect(call?.headers['apikey']).toBe('gql_tok');
        expect((call?.body as { variables: unknown }).variables).toEqual({
            id: 1,
        });
        expect((call?.body as { query: string }).query).toMatch(/thing/);
    });

    test('.with({ variables }) carries GraphQL variables into the request', async () => {
        server.route('POST', '/graphql', { body: { data: { ok: true } } });
        const query = graphql({
            baseUrl: server.url,
            query: 'query($id: ID) { thing(id: $id) { name } }',
        });

        // Partial application must preserve EVERY StitchInput field. `variables` is the primary
        // input for a GraphQL stitch; mergeInput() now folds it alongside params/query/headers/body.
        const bound = query.with({ variables: { id: 7 } });
        await bound();

        const call = server.calls('/graphql')[0]!;
        expect((call.body as { variables: unknown }).variables).toEqual({
            id: 7,
        });
    });

    test('surfaces GraphQL errors (a 200 carrying `errors`) as a failure', async () => {
        server.route('POST', '/graphql', {
            body: { errors: [{ message: 'field "thing" not found' }] },
        });
        const query = graphql({ baseUrl: server.url, query: '{ thing }' });
        await expect(query()).rejects.toThrow(/thing.*not found/);
    });
});

// Issue #75: `input.variables` is now a validated slot (it used to be an untyped passthrough).
// The compile-time half is graphql-variables.test-d.ts; this is the runtime half.
describe('GraphQL input.variables validation', () => {
    test('rejects bad variables BEFORE hitting the wire', async () => {
        server.route('POST', '/graphql', { body: { data: { ok: true } } });
        const query = graphql({
            baseUrl: server.url,
            query: 'query($id: ID!) { thing(id: $id) { name } }',
            input: { variables: z.object({ id: z.string() }) },
        });

        // `id` must be a string — a number fails the variables schema.
        await expect(
            query({ variables: { id: 1 as unknown as string } }),
        ).rejects.toThrow(/invalid variables/);
        // validation runs before the request, so the server never saw the call.
        expect(server.calls('/graphql')).toHaveLength(0);
    });

    test('accepts good variables and packs them into { query, variables }', async () => {
        server.route('POST', '/graphql', {
            body: { data: { thing: { name: 'Ada' } } },
        });
        const query = graphql({
            baseUrl: server.url,
            query: 'query($id: ID!) { thing(id: $id) { name } }',
            input: { variables: z.object({ id: z.string() }) },
        });

        const out = await query({ variables: { id: 'abc' } });
        expect(out).toEqual({ thing: { name: 'Ada' } });
        const call = server.calls('/graphql')[0]!;
        expect((call.body as { variables: unknown }).variables).toEqual({
            id: 'abc',
        });
    });

    test('a graphql call with NO variables schema still works (untyped passthrough)', async () => {
        server.route('POST', '/graphql', { body: { data: { ok: true } } });
        const query = graphql({
            baseUrl: server.url,
            query: 'query($id: ID) { thing(id: $id) { name } }',
        });

        // No `input.variables` → no validation; any variables flow straight through.
        const out = await query({ variables: { id: 42, extra: 'anything' } });
        expect(out).toEqual({ ok: true });
        const call = server.calls('/graphql')[0]!;
        expect((call.body as { variables: unknown }).variables).toEqual({
            id: 42,
            extra: 'anything',
        });
    });
});

describe('Surface dispatch — graphql is no longer special-cased', () => {
    test('a surface buildRequest hook shapes the outgoing request', async () => {
        server.route('PUT', '/x', { body: { ok: true } });
        const put: Surface = {
            id: 'put',
            buildRequest: (_cfg, _input, base) => ({ ...base, method: 'PUT' }),
        };
        const s = stitch({ kind: put, url: server.url + '/x' });

        // pre-refactor sends GET → 404; only the recorded wire method matters here
        await s().then(
            () => undefined,
            () => undefined,
        );
        expect(server.calls('/x')[0]?.method).toBe('PUT');
    });

    test('a surface interpret hook produces the result value', async () => {
        server.route('GET', '/u', { body: { msg: 'hi' } });
        const upper: Surface = {
            id: 'upper',
            interpret: (res) => ({
                ok: true,
                value: (res.body as { msg: string }).msg.toUpperCase(),
            }),
        };
        const s = stitch({ kind: upper, url: server.url + '/u' });

        expect(await s()).toBe('HI');
    });

    test('a surface interpret hook can fail the call (like graphql errors)', async () => {
        server.route('GET', '/r', { body: {} });
        const reject: Surface = {
            id: 'reject',
            interpret: () => ({ ok: false, message: 'nope', status: 422 }),
        };
        const s = stitch({ kind: reject, url: server.url + '/r' });

        await expect(s()).rejects.toThrow(/nope/);
    });
});

describe('Static default headers', () => {
    test('cfg.headers + fragment headers merge; input.headers overrides per key', async () => {
        server.route('GET', '/x', { body: { ok: true } });
        const base = { headers: { 'x-trace': 't1' } };
        const s = stitch({
            extends: [base],
            baseUrl: server.url,
            path: '/x',
            headers: { 'x-app': 'demo' },
        });

        await s({ headers: { 'x-app': 'override' } });

        const call = server.calls('/x')[0];
        expect(call?.headers['x-trace']).toBe('t1'); // from the fragment
        expect(call?.headers['x-app']).toBe('override'); // input wins over the static default
    });
});
