// The Surface plugin model (ADR 0005 Decisions 1-3, 10, 11): `kind` is a pluggable Surface
// (not a closed string union), normalised to its id string in __config (JSON round-trip), and
// each surface exposes monomorphic `.stitch()` / `.seam()` helpers. The seam stays
// surface-agnostic. graphql's behaviour still rides the engine's id-keyed handling here (it
// moves behind the surface hooks in Stage 4).
import { graphql, httpSurface, seam, stitch } from '../src';
import { graphqlSurface } from '../src/surface';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

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

describe('Surface model (ADR 0005 Decisions 1-2, 11)', () => {
    test('built-in surfaces carry stable ids', () => {
        expect(httpSurface.id).toBe('http');
        expect(graphqlSurface.id).toBe('graphql');
    });

    test('kind round-trips through __config as the id STRING, never the live object', () => {
        const g = graphql({ baseUrl: 'https://x.test', query: '{ a }' });
        const json = JSON.parse(JSON.stringify(g.__config)) as {
            kind?: unknown;
        };
        expect(json.kind).toBe('graphql');

        const h = stitch({ kind: httpSurface, url: 'https://x.test/a' });
        const hjson = JSON.parse(JSON.stringify(h.__config)) as {
            kind?: unknown;
        };
        expect(hjson.kind).toBe('http');
    });

    test('a plain stitch has no kind (http is the implicit default)', () => {
        const h = stitch({ url: 'https://x.test/a' });
        expect(h.__config.kind).toBeUndefined();
    });
});

describe('generic stitch({ kind }) accepts a Surface (Decision 3)', () => {
    test('kind: graphqlSurface shapes the request as graphql (POST { query, variables })', async () => {
        server.route('POST', '/gql', { body: { data: { ok: 1 } } });
        const q = stitch({
            kind: graphqlSurface,
            baseUrl: server.url,
            path: '/gql',
            query: '{ ok }',
        });

        await q({ variables: { x: 1 } });

        const call = server.calls('/gql')[0];
        expect(call?.method).toBe('POST');
        expect(call?.body).toEqual({ query: '{ ok }', variables: { x: 1 } });
    });
});

describe('graphql surface helper (Decision 3/10)', () => {
    test('graphql.surface is the graphql Surface', () => {
        expect(graphql.surface).toBe(graphqlSurface);
    });

    test('graphql.stitch(...) behaves like graphql(...) — POST, unwrap data', async () => {
        server.route('POST', '/g', { body: { data: { me: { id: 7 } } } });
        const q = graphql.stitch({
            baseUrl: server.url,
            path: '/g',
            query: '{ me { id } }',
            pick: 'data.me',
        });
        expect(await q()).toEqual({ id: 7 });
    });

    test('graphql.seam(existingSeam).stitch(...) creates a graphql member of that seam', async () => {
        server.route('POST', '/api', { body: { data: { ping: 'pong' } } });
        const api = seam({ baseUrl: server.url });
        const ping = graphql.seam(api).stitch({
            path: '/api',
            query: '{ ping }',
            pick: 'data.ping',
        });
        expect(await ping()).toBe('pong');
    });

    test('graphql.seam(options) makes a new seam whose members are graphql', async () => {
        server.route('POST', '/s', { body: { data: { v: 42 } } });
        const g = graphql.seam({ baseUrl: server.url });
        expect(g.seam.__seam).toBe(true);
        const v = g.stitch({ path: '/s', query: '{ v }', pick: 'data.v' });
        expect(await v()).toBe(42);
    });
});
