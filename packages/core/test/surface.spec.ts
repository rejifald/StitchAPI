// The Surface plugin model (ADR 0005 Decisions 1-3, 10, 11): `kind` is a pluggable Surface
// (not a closed string union), normalised to its id string in __config (JSON round-trip), and
// each surface exposes monomorphic `.stitch()` / `.bind()` helpers. The seam stays
// surface-agnostic. graphql's behaviour still rides the engine's id-keyed handling here (it
// moves behind the surface hooks in Stage 4).
import { graphql, httpFailure, httpSurface, seam, stitch } from '../src';
import type { Surface, SurfaceOutcome } from '../src/surface';
// `httpInterpret` / `interpretOf` are deliberately NOT on the barrel — one composition point is
// public (`httpFailure`), and public-api-surface.spec.ts pins their absence. Reach the module
// directly here, the way the engine does.
import { graphqlSurface, httpInterpret, interpretOf } from '../src/surface';
import type {
    AdapterResponse,
    ResolvedStitchConfig,
    StatusMatch,
} from '../src/types';
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
        const g = graphql({ baseUrl: 'https://x.test', document: '{ a }' });
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

    // ADR 0022 Decision 2 flipped this: `compose` now RESOLVES an omitted `kind` to `httpSurface`
    // rather than leaving the slot empty and letting the engine decide what "no surface" means. The
    // default is a real selection, so `__config` reports it like any other surface.
    test('a plain stitch resolves kind to the http surface', () => {
        const h = stitch({ url: 'https://x.test/a' });
        expect(h.__config.kind).toBe('http');
        expect(JSON.parse(JSON.stringify(h.__config))).toMatchObject({
            kind: 'http',
        });
    });
});

// ADR 0022 Decision 2. `httpSurface` was the one surface with no interpretation of its own — the
// status verdict was an unnamed engine branch. These pin the extracted functions directly, so the
// contract holds independently of where the engine calls them from (the verdict moves inside the
// attempt loop in step 3, at which point the non-2xx arms below stop being unreachable).
describe('the status verdict (ADR 0022 Decision 2)', () => {
    const resOf = (
        status: number,
        body: unknown = { v: 1 },
    ): AdapterResponse => ({
        status,
        headers: {},
        body,
    });
    const cfgOf = (accept?: StatusMatch): ResolvedStitchConfig =>
        ({ verdict: { accept } }) as ResolvedStitchConfig;

    describe('httpFailure — the verdict, with NO claim about the success value', () => {
        test('an acceptable status yields no failure at all', () => {
            expect(httpFailure(resOf(200), cfgOf())).toBeUndefined();
        });

        test('the verdict turns at 400, not at 300 — a 3xx is acceptable', () => {
            expect(httpFailure(resOf(304, null), cfgOf())).toBeUndefined();
        });

        test('a non-2xx is a failure carrying the status and the HTTP message', () => {
            expect(httpFailure(resOf(500), cfgOf())).toEqual({
                ok: false,
                message: 'HTTP 500',
                status: 500,
            });
        });

        test('verdict.accept clears the failure for a declared status (#155)', () => {
            expect(httpFailure(resOf(404), cfgOf([404]))).toBeUndefined();
        });

        test('verdict.accept is additive — an undeclared status still fails', () => {
            expect(httpFailure(resOf(403), cfgOf([404]))).toMatchObject({
                ok: false,
                status: 403,
            });
        });

        test('every StatusMatch spelling is honoured (P7: bare number, list, predicate)', () => {
            expect(httpFailure(resOf(404), cfgOf(404))).toBeUndefined();
            expect(httpFailure(resOf(404), cfgOf([400, 404]))).toBeUndefined();
            expect(
                httpFailure(
                    resOf(404),
                    cfgOf((s) => s < 500),
                ),
            ).toBeUndefined();
            expect(
                httpFailure(
                    resOf(500),
                    cfgOf((s) => s < 500),
                ),
            ).toMatchObject({ ok: false, status: 500 });
        });

        // The point of the split: a surface composing the verdict never receives — and so never has
        // to discard — a success value asserting the raw body is the result. `download` means
        // `{ blob, filename }` and `llm` means the provider's parsed completion; neither is `res.body`.
        test('it never manufactures a success value — a surface composes its own', () => {
            const cfg = cfgOf();
            expect(httpFailure(resOf(200, { raw: true }), cfg)).toBeUndefined();

            const ownValue = { blob: 'BLOB', filename: 'a.txt' };
            const interpret = (
                res: AdapterResponse,
            ): SurfaceOutcome<typeof ownValue> =>
                httpFailure(res, cfg) ?? { ok: true, data: ownValue };

            expect(interpret(resOf(200, { raw: true }))).toEqual({
                ok: true,
                data: ownValue,
            });
            expect(interpret(resOf(500))).toMatchObject({
                ok: false,
                status: 500,
            });
        });
    });

    // The point of Decision 2: `{ ok: true, data: res.body }` is the HTTP SURFACE'S interpretation,
    // reached by selecting that surface — not a branch the engine falls back to. Swapping the hook
    // proves nothing else supplies one: if the engine still held its own default, a plain stitch
    // would keep resolving to the raw body here.
    describe('the default is the surface’s, not the engine’s', () => {
        test('interpretOf routes a plain stitch to httpSurface.interpret', () => {
            expect(interpretOf(httpSurface)).toBe(httpInterpret);
        });

        test('a surface with no hook inherits http’s interpretation', () => {
            expect(interpretOf({ id: 'hookless' })).toBe(httpInterpret);
        });

        test('a surface’s own hook wins, and nothing re-adds the body default', () => {
            const own = (): SurfaceOutcome => ({ ok: true, data: 'MINE' });
            expect(interpretOf({ id: 'x', interpret: own })).toBe(own);
        });

        test('end to end: replacing http’s hook changes what a plain stitch resolves to', async () => {
            server.route('GET', '/plain', { body: { raw: 'BODY' } });
            const original = httpSurface.interpret;
            try {
                (
                    httpSurface as { interpret?: Surface['interpret'] }
                ).interpret = (res, cfg) =>
                    httpFailure(res, cfg) ?? { ok: true, data: 'REPLACED' };
                const call = stitch({ baseUrl: server.url, path: '/plain' });
                await expect(call()).resolves.toBe('REPLACED');
            } finally {
                (
                    httpSurface as { interpret?: Surface['interpret'] }
                ).interpret = original;
            }
        });
    });

    describe('httpInterpret — the verdict PLUS the http surface’s own "body is the value"', () => {
        test('a 2xx is a result carrying the body', () => {
            expect(httpInterpret(resOf(200, { ok: 1 }), cfgOf())).toEqual({
                ok: true,
                data: { ok: 1 },
            });
        });

        test('an accepted non-2xx carries its body too (#155)', () => {
            expect(
                httpInterpret(resOf(404, { error: 'gone' }), cfgOf([404])),
            ).toEqual({ ok: true, data: { error: 'gone' } });
        });

        test('a failure is exactly what httpFailure rendered', () => {
            expect(httpInterpret(resOf(500), cfgOf())).toEqual(
                httpFailure(resOf(500), cfgOf()),
            );
        });

        test('httpSurface exposes it as its interpret hook', () => {
            expect(httpSurface.interpret).toBe(httpInterpret);
        });
    });
});

describe('generic stitch({ kind }) accepts a Surface (Decision 3)', () => {
    test('kind: graphqlSurface shapes the request as graphql (POST { query, variables })', async () => {
        server.route('POST', '/gql', { body: { data: { ok: 1 } } });
        const q = stitch({
            kind: graphqlSurface,
            baseUrl: server.url,
            path: '/gql',
            document: '{ ok }',
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
            document: '{ me { id } }',
            pick: 'data.me',
        });
        expect(await q()).toEqual({ id: 7 });
    });

    test('graphql.bind(existingSeam).stitch(...) creates a graphql member of that seam', async () => {
        server.route('POST', '/api', { body: { data: { ping: 'pong' } } });
        const api = seam({ baseUrl: server.url });
        const ping = graphql.bind(api).stitch({
            path: '/api',
            document: '{ ping }',
            pick: 'data.ping',
        });
        expect(await ping()).toBe('pong');
    });

    test('graphql.bind(options) makes a new seam whose members are graphql', async () => {
        server.route('POST', '/s', { body: { data: { v: 42 } } });
        const g = graphql.bind({ baseUrl: server.url });
        expect(g.seam.__seam).toBe(true);
        const v = g.stitch({ path: '/s', document: '{ v }', pick: 'data.v' });
        expect(await v()).toBe(42);
    });
});
