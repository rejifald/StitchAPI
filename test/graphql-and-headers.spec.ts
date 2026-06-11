// Closes the last two gaps: a real `graphql` kind (proving the kind abstraction) and a
// static `headers` config field.
import { apiKey, env, graphql, preset, stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STITCH_TRACE_FILE = join(
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
        process.env.GQL_KEY = 'gql_tok';
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
        expect(call?.headers.apikey).toBe('gql_tok');
        expect((call?.body as { variables: unknown })?.variables).toEqual({
            id: 1,
        });
        expect((call?.body as { query: string })?.query).toMatch(/thing/);
    });

    test('surfaces GraphQL errors (a 200 carrying `errors`) as a failure', async () => {
        server.route('POST', '/graphql', {
            body: { errors: [{ message: 'field "thing" not found' }] },
        });
        const query = graphql({ baseUrl: server.url, query: '{ thing }' });
        await expect(query()).rejects.toThrow(/thing.*not found/);
    });
});

describe('Static default headers', () => {
    test('cfg.headers + fragment headers merge; input.headers overrides per key', async () => {
        server.route('GET', '/x', { body: { ok: true } });
        const base = preset({ headers: { 'x-trace': 't1' } });
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
