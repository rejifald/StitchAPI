// seam.graphql() — the seam's GraphQL member builder (src/seam.ts, the makeBuild `isGql` branch).
// seam.spec.ts covers regular `.stitch()` members (fragment inheritance, throttle pooling, principal
// sessions, redaction, lifecycle) but NEVER exercises `.graphql()`. This pins the graphql member's
// defaults — the graphql surface, a default POST /graphql endpoint, `pick: 'data'` — plus that it
// inherits the seam fragment, honours an explicit path, and is also buildable off a principal handle.
import { seam } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-seam-gql-${process.pid}.jsonl`,
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

describe('seam.graphql() member', () => {
    test('defaults to a POST /graphql graphql member that unwraps data and inherits the fragment', async () => {
        server.route('POST', '/graphql', { body: { data: { thing: 42 } } });
        const api = seam({ baseUrl: server.url, headers: { 'x-seam': 'yes' } });

        const q = api.graphql({ query: '{ thing }' });

        // kind round-trips as the graphql surface id.
        const json = JSON.parse(JSON.stringify(q.__config)) as {
            kind?: unknown;
        };
        expect(json.kind).toBe('graphql');

        // resolves to the unwrapped `data`.
        await expect(q()).resolves.toEqual({ thing: 42 });

        const call = server.calls('/graphql')[0];
        expect(call?.method).toBe('POST'); // graphql surface forces POST
        expect(call?.headers['x-seam']).toBe('yes'); // seam fragment inherited
        expect((call?.body as { query: string }).query).toMatch(/thing/);
    });

    test('honours an explicit path instead of defaulting to /graphql', async () => {
        server.route('POST', '/gql', { body: { data: { ok: true } } });
        const api = seam({ baseUrl: server.url });

        const q = api.graphql({ query: '{ ok }', path: '/gql' });
        await expect(q()).resolves.toEqual({ ok: true });
        expect(server.callCount('/gql')).toBe(1);
        expect(server.callCount('/graphql')).toBe(0);
    });

    test('a principal handle builds a working graphql member', async () => {
        server.route('POST', '/graphql', { body: { data: { who: 'me' } } });
        const api = seam({ baseUrl: server.url });

        const scoped = api.as('user-1').graphql({ query: '{ who }' });
        await expect(scoped()).resolves.toEqual({ who: 'me' });
        expect(server.callCount('/graphql')).toBe(1);
    });
});
