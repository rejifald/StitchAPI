// graphql as a Surface (ADR 0005 Stage 4): graphql's request shaping + "200-with-errors is a
// failure" now live in the graphql surface's hooks, and the engine dispatches to those hooks
// GENERICALLY — it no longer special-cases `kind === 'graphql'`. Proven below by the graphql
// behaviour (unchanged) plus custom surfaces routed through the same engine. Plus a static
// `headers` config field.
import { apiKey, env, graphql, stitch } from '../src';
import type { Surface } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
        expect((call?.body as { variables: unknown })?.variables).toEqual({
            id: 1,
        });
        expect((call?.body as { query: string })?.query).toMatch(/thing/);
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
