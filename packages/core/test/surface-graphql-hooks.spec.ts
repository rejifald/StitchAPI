// Direct tests for graphqlSurface's pure hooks (src/surface.ts). surface.spec.ts and
// graphql-and-headers.spec.ts exercise the graphql surface through the ENGINE (observable POST,
// pick data, 200-with-errors fails). The hooks' own branch contracts go unpinned:
//   buildRequest — packs { query, variables } as a JSON POST over the base request; variables
//                  precedence is input.variables → input.body → {}; query defaults to ''; a
//                  configured method overrides POST and is upper-cased.
//   interpret    — a body without errors passes through; a non-empty `errors` array fails with the
//                  joined messages (missing message → "error") + status; an EMPTY errors array and
//                  a null body are NOT failures.
import { graphqlSurface } from '../src/surface';
import type {
    AdapterRequest,
    AdapterResponse,
    ResolvedStitchConfig,
    StitchInput,
} from '../src/types';

// `kind` is required on a resolved config (ADR 0022 Decision 2 — an omitted surface resolves to
// `httpSurface`); these hooks are graphql's, so that is the honest surface to carry.
const cfg = (
    o: { document?: string; method?: string; operationName?: string } = {},
): ResolvedStitchConfig => ({ ...o, kind: graphqlSurface });

const base: AdapterRequest = {
    url: 'https://api.test/graphql',
    method: 'GET',
    headers: { 'x-base': '1' },
};

// Call the hooks (wrappers invoke them, so they are never referenced unbound).
function build(c: ResolvedStitchConfig, input: StitchInput): AdapterRequest {
    return graphqlSurface.buildRequest!(c, input, base);
}
function interpret(res: AdapterResponse) {
    return graphqlSurface.interpret!(res, cfg());
}
const res = (body: unknown, status = 200): AdapterResponse => ({
    status,
    headers: {},
    body,
});

describe('graphqlSurface.buildRequest', () => {
    test('packs { query, variables } as a JSON POST, preserving the base request', () => {
        const req = build(cfg({ document: '{ thing }' }), {
            variables: { id: 1 },
        });
        expect(req.method).toBe('POST');
        expect(req.bodyType).toBe('json');
        expect(req.body).toEqual({ query: '{ thing }', variables: { id: 1 } });
        expect(req.url).toBe('https://api.test/graphql'); // base spread through
        expect(req.headers).toEqual({ 'x-base': '1' });
    });

    // The surface OWNS the body encoding — `NoWireBodyOnGraphql` makes authoring a `wire.body`
    // alongside `kind: graphql` a compile error, but that guard is compile-time only: a config
    // reconstructed at runtime (a deserialised `__config`, `fromCurl`, plain JS) can still carry
    // one. The override must therefore stay deterministic rather than drifting into "sometimes the
    // caller's". `multipart` is the arm worth naming: a GraphQL upload needs the GraphQL multipart
    // request spec's operations/map/file-part envelope, which this surface does not implement, so
    // honouring the flag here would emit a body no GraphQL server accepts.
    //
    // These are `AdapterRequest` fields, so they stay flat (`bodyType`/`multipart`) — the `wire`
    // envelope is the config spelling, and the engine converts at the edge.
    test('forces bodyType json, overriding whatever the base request carried', () => {
        for (const bodyType of ['multipart', 'form', 'json'] as const) {
            const req = graphqlSurface.buildRequest!(
                cfg({ document: 'q' }),
                {},
                { ...base, bodyType, multipart: { nesting: 'dot' } },
            );
            expect(req.bodyType).toBe('json');
        }
        // ...and with no encoding on the base at all.
        expect(build(cfg({ document: 'q' }), {}).bodyType).toBe('json');
    });

    test('variables fall back to input.body, then to {}', () => {
        const fromBody = build(cfg({ document: 'q' }), { body: { a: 1 } });
        expect((fromBody.body as { variables: unknown }).variables).toEqual({
            a: 1,
        });
        const none = build(cfg({ document: 'q' }), {});
        expect((none.body as { variables: unknown }).variables).toEqual({});
    });

    test('input.variables wins over input.body', () => {
        const req = build(cfg({ document: 'q' }), {
            variables: { v: 1 },
            body: { b: 2 },
        });
        expect((req.body as { variables: unknown }).variables).toEqual({
            v: 1,
        });
    });

    test('defaults the query to an empty string when none is configured', () => {
        const req = build(cfg(), {});
        expect((req.body as { query: string }).query).toBe('');
    });

    test('honours and upper-cases a configured method', () => {
        const req = build(cfg({ document: 'q', method: 'put' }), {});
        expect(req.method).toBe('PUT');
    });

    test('derives operationName from the first named operation in the query', () => {
        const req = build(
            cfg({
                document: 'query findScene($id: ID!) { scene(id: $id) { id } }',
            }),
            { variables: { id: 's1' } },
        );
        expect(req.body).toEqual({
            query: 'query findScene($id: ID!) { scene(id: $id) { id } }',
            variables: { id: 's1' },
            operationName: 'findScene',
        });
    });

    test('derives the name across mutation/subscription too', () => {
        expect(
            (
                build(
                    cfg({
                        document: 'mutation Login($p: P!) { login(p: $p) }',
                    }),
                    {},
                ).body as {
                    operationName?: string;
                }
            ).operationName,
        ).toBe('Login');
        expect(
            (
                build(cfg({ document: 'subscription OnTick { tick }' }), {})
                    .body as {
                    operationName?: string;
                }
            ).operationName,
        ).toBe('OnTick');
    });

    test('omits operationName for an anonymous document (shorthand or unnamed query)', () => {
        for (const document of [
            '{ thing }',
            'query($id: ID) { thing(id: $id) }',
        ]) {
            const body = build(cfg({ document }), {}).body as Record<
                string,
                unknown
            >;
            expect('operationName' in body).toBe(false);
        }
    });

    test('an explicit cfg.operationName overrides the derived name', () => {
        const body = build(
            cfg({
                document: 'query A { a } query B { b }',
                operationName: 'B',
            }),
            {},
        ).body as { operationName?: string };
        expect(body.operationName).toBe('B');
    });

    test('cfg.operationName of "" suppresses the field even for a named query', () => {
        const body = build(
            cfg({ document: 'query Named { x }', operationName: '' }),
            {},
        ).body as Record<string, unknown>;
        expect('operationName' in body).toBe(false);
    });

    test('does not mistake a field or type named like a keyword for the operation', () => {
        // `queryStatus` field + `query` keyword: only the real operation `Dash` is picked up.
        const body = build(
            cfg({ document: 'query Dash { queryStatus mutationCount }' }),
            {},
        ).body as { operationName?: string };
        expect(body.operationName).toBe('Dash');
    });
});

describe('graphqlSurface.interpret', () => {
    test('a body without errors passes through as the value', () => {
        expect(interpret(res({ data: { x: 1 } }))).toEqual({
            ok: true,
            data: { data: { x: 1 } },
        });
    });

    test('a 200 carrying errors fails with the joined messages + status', () => {
        expect(
            interpret(res({ errors: [{ message: 'A' }, { message: 'B' }] })),
        ).toEqual({ ok: false, message: 'GraphQL: A; B', status: 200 });
    });

    test('an error with no message defaults to "error"', () => {
        expect(interpret(res({ errors: [{}] }))).toEqual({
            ok: false,
            message: 'GraphQL: error',
            status: 200,
        });
    });

    test('an empty errors array is NOT a failure', () => {
        expect(interpret(res({ errors: [] }))).toEqual({
            ok: true,
            data: { errors: [] },
        });
    });

    test('a null body is not a failure', () => {
        expect(interpret(res(null))).toEqual({ ok: true, data: null });
    });
});
