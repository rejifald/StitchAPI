// Direct tests for graphqlSurface's pure hooks (src/surface.ts). surface.spec.ts and
// graphql-and-headers.spec.ts exercise the graphql surface through the ENGINE (observable POST,
// unwrap data, 200-with-errors fails). The hooks' own branch contracts go unpinned:
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
    StitchConfig,
    StitchInput,
} from '../src/types';

const cfg = (o: { query?: string; method?: string } = {}): StitchConfig => o;

const base: AdapterRequest = {
    url: 'https://api.test/graphql',
    method: 'GET',
    headers: { 'x-base': '1' },
};

// Call the hooks (wrappers invoke them, so they are never referenced unbound).
function build(c: StitchConfig, input: StitchInput): AdapterRequest {
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
        const req = build(cfg({ query: '{ thing }' }), {
            variables: { id: 1 },
        });
        expect(req.method).toBe('POST');
        expect(req.bodyType).toBe('json');
        expect(req.body).toEqual({ query: '{ thing }', variables: { id: 1 } });
        expect(req.url).toBe('https://api.test/graphql'); // base spread through
        expect(req.headers).toEqual({ 'x-base': '1' });
    });

    test('variables fall back to input.body, then to {}', () => {
        const fromBody = build(cfg({ query: 'q' }), { body: { a: 1 } });
        expect((fromBody.body as { variables: unknown }).variables).toEqual({
            a: 1,
        });
        const none = build(cfg({ query: 'q' }), {});
        expect((none.body as { variables: unknown }).variables).toEqual({});
    });

    test('input.variables wins over input.body', () => {
        const req = build(cfg({ query: 'q' }), {
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
        const req = build(cfg({ query: 'q', method: 'put' }), {});
        expect(req.method).toBe('PUT');
    });
});

describe('graphqlSurface.interpret', () => {
    test('a body without errors passes through as the value', () => {
        expect(interpret(res({ data: { x: 1 } }))).toEqual({
            ok: true,
            value: { data: { x: 1 } },
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
            value: { errors: [] },
        });
    });

    test('a null body is not a failure', () => {
        expect(interpret(res(null))).toEqual({ ok: true, value: null });
    });
});
