// Issue #648: an `input` schema FILTERS, it does not merely gate. `validateInput` used to await the
// validator, check `r.ok`, throw on failure — and drop `r.value` on the floor, so the original
// unparsed input reached the transport. `validateOutput` had done the opposite since ADR 0015 ("on
// success returns the PARSED value — coerced, defaulted, stripped — so the result matches the
// declared contract"), which left the two halves of one feature behaving in opposite directions.
//
// That mattered because stripping unknown keys is the DEFAULT in Zod, Valibot and ArkType alike: a
// reader who declares an input schema reasonably believes the request is now shaped by it. It was
// not — and since a pinned `?tenant=acme` in the configured path is a default that caller input
// overwrites (`{ ...predefined, ...input.query }`), the one mechanism that would close that hole
// silently did nothing.
//
// These tests pin the wire, not the internals: what the transport actually received.
import { graphql, stitch } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-input-filter-${process.pid}.jsonl`,
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

describe('a declared input schema shapes the request (issue #648)', () => {
    test('query: the parsed value goes on the wire — an unknown key cannot overwrite a pinned default', async () => {
        server.route('GET', '/v1/orders', { body: { ok: true } });
        const getOrders = stitch({
            // `?tenant=acme` is pinned in the configured endpoint; the engine treats a predefined
            // query pair as a DEFAULT that `input.query` overrides, so this is the exact pairing
            // the issue measured.
            url: `${server.url}/v1/orders?tenant=acme`,
            input: { query: z.object({ limit: z.number() }) }, // strips by default
        });

        await getOrders({
            query: {
                limit: 10,
                tenant: 'globex',
                include: 'internal_notes',
            } as unknown as { limit: number },
        });

        const call = server.calls('/v1/orders')[0]!;
        // The validator returned `{ limit: 10 }`; that — and only that — is what merges over the
        // pinned default. Before the fix the wire read `?tenant=globex&limit=10&include=internal_notes`
        // and the vendor duly answered for the other tenant.
        expect(call.query).toEqual({ tenant: 'acme', limit: '10' });
    });

    test('query: a schema default is applied, the way an output schema default already was', async () => {
        server.route('GET', '/v1/orders', { body: { ok: true } });
        const getOrders = stitch({
            url: `${server.url}/v1/orders`,
            input: { query: z.object({ limit: z.number().default(20) }) },
        });

        await getOrders({ query: {} });

        expect(server.calls('/v1/orders')[0]!.query).toEqual({ limit: '20' });
    });

    test('params: the parsed value expands the path template', async () => {
        server.route('GET', '/orders/42', { body: { ok: true } });
        const getOrder = stitch({
            baseUrl: server.url,
            path: '/orders/{id}',
            input: { params: z.object({ id: z.string().trim() }) },
        });

        await getOrder({ params: { id: '  42  ' } });

        // Coercion reaches the URL: the untrimmed id would have expanded to `/orders/%20%2042%20%20`.
        expect(server.calls()[0]!.path).toBe('/orders/42');
    });

    test('body: the parsed value is what is sent', async () => {
        server.route('POST', '/payments', { body: { ok: true } });
        const pay = stitch({
            url: `${server.url}/payments`,
            method: 'POST',
            input: { body: z.object({ amount: z.number() }) },
        });

        await pay({
            body: { amount: 5, approved: true } as unknown as {
                amount: number;
            },
        });

        expect(server.calls('/payments')[0]!.body).toEqual({ amount: 5 });
    });

    test('headers: the parsed value is what is sent — an undeclared header is stripped', async () => {
        server.route('GET', '/h', { body: { ok: true } });
        const call = stitch({
            url: `${server.url}/h`,
            input: { headers: z.object({ 'x-tenant': z.string() }) },
        });

        await call({
            headers: {
                'x-tenant': 'acme',
                'x-forwarded-for': '10.0.0.1',
            } as unknown as { 'x-tenant': string },
        });

        const seen = server.calls('/h')[0]!.headers;
        expect(seen['x-tenant']).toBe('acme');
        expect(seen['x-forwarded-for']).toBeUndefined();
    });

    test('an UNDECLARED slot stays a full passthrough — this fix filters, it does not lock down', async () => {
        server.route('GET', '/orders/7', { body: { ok: true } });
        const getOrder = stitch({
            baseUrl: server.url,
            path: '/orders/{id}',
            // Only `params` is declared. A schema constrains ONE slot; `query` keeps the loose
            // passthrough it has always had (defensible on its own — see the issue).
            input: { params: z.object({ id: z.string() }) },
        });

        await getOrder({ params: { id: '7' }, query: { anything: 'kept' } });

        expect(server.calls('/orders/7')[0]!.query).toEqual({
            anything: 'kept',
        });
    });

    test("the caller's own input object is not mutated", async () => {
        server.route('GET', '/v1/orders', { body: { ok: true } });
        const getOrders = stitch({
            url: `${server.url}/v1/orders`,
            input: { query: z.object({ limit: z.number() }) },
        });

        // A variable, not a fresh literal — so the extra `tenant` reaches the engine (excess
        // property checking only bites on literals) exactly as an untrusted caller's would.
        const arg = { limit: 10, tenant: 'globex' };
        await getOrders({ query: arg });

        // The engine validates into a COPY: filtering the request must never rewrite an object the
        // caller still holds (a bound `.with(...)` partial, a loop reusing one literal, …).
        expect(arg).toEqual({ limit: 10, tenant: 'globex' });
    });

    // Not a repro — a consequence guard. The cache key mirrors the RESOLVED request, so the moment
    // a run resolves it from the parsed input, `invalidate(input)` has to as well or it computes
    // the key of a request that was never made and evicts nothing.
    test('cache: `invalidate(input)` still evicts the entry that same input stored', async () => {
        let calls = 0;
        const s = stitch({
            url: 'https://api.test/resource',
            trace: false,
            cache: { ttl: '60s', tenancy: 'app' },
            input: { query: z.object({ id: z.number() }) },
            adapter: () => {
                calls += 1;
                return Promise.resolve({
                    status: 200,
                    headers: {},
                    body: { n: calls },
                });
            },
        });

        const arg = { id: 1, noise: 'stripped' };
        await s({ query: arg });
        await s({ query: arg }); // served from cache
        expect(calls).toBe(1);

        await s.invalidate({ query: arg });
        await s({ query: arg }); // evicted → refetch
        expect(calls).toBe(2);
    });
});

// The one path the issue flagged to check first: `variables` is a validated slot, but the value is
// consumed by the graphql surface's `buildRequest` (`{ query, variables }`), not by the generic
// request builder. The engine hands the surface the same input object it validated, so the parsed
// variables reach the packed body — and the `input.variables ?? input.body` fallback still stands.
describe('graphql: the parsed `variables` reach the packed { query, variables } body', () => {
    test('a declared variables schema strips unknown keys from the wire body', async () => {
        server.route('POST', '/graphql', { body: { data: { ok: true } } });
        const query = graphql({
            baseUrl: server.url,
            document: 'query($id: ID!) { thing(id: $id) { name } }',
            input: { variables: z.object({ id: z.string() }) },
        });

        await query({
            variables: { id: 'abc', admin: true } as unknown as {
                id: string;
            },
        });

        const call = server.calls('/graphql')[0]!;
        expect((call.body as { variables: unknown }).variables).toEqual({
            id: 'abc',
        });
    });

    test('a `body` schema on a graphql stitch feeds the same slot, parsed', async () => {
        server.route('POST', '/graphql', { body: { data: { ok: true } } });
        const query = graphql({
            baseUrl: server.url,
            document: 'query($id: ID!) { thing(id: $id) { name } }',
            input: { body: z.object({ id: z.string() }) },
        });

        // `variables` absent ⇒ the surface falls back to `body` (`input.variables ?? input.body`).
        await query({
            body: { id: 'abc', admin: true } as unknown as { id: string },
        });

        const call = server.calls('/graphql')[0]!;
        expect((call.body as { variables: unknown }).variables).toEqual({
            id: 'abc',
        });
    });

    test('an optional variables schema with no variables passed still falls back to `body`', async () => {
        server.route('POST', '/graphql', { body: { data: { ok: true } } });
        const query = graphql({
            baseUrl: server.url,
            document: 'query($id: ID!) { thing(id: $id) { name } }',
            input: { variables: z.object({ id: z.string() }).optional() },
        });

        // The parsed value of an absent optional slot is `undefined`, so the surface's nullish
        // fallback is untouched and `body` still supplies the variables. (`body` keeps no loose
        // passthrough in the call-arg type once another slot is declared — only `variables`,
        // `params` and `query` do — so the runtime slot is reached with a cast.)
        await query({ body: { id: 'abc' } } as unknown as Parameters<
            typeof query
        >[0]);

        const call = server.calls('/graphql')[0]!;
        expect((call.body as { variables: unknown }).variables).toEqual({
            id: 'abc',
        });
    });
});
