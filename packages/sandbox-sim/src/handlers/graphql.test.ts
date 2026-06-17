/**
 * Wave 4 smoke test — GraphQL handler.
 *
 * Run with:
 *   npx -y tsx packages/sandbox-sim/src/handlers/graphql.test.ts
 *
 * Prints "GraphQL OK" and exits 0 on success; throws / exits non-zero on failure.
 * Uses node:assert only — no test framework required.
 *
 * Asserts the AGREED contract:
 *   - A user(id) selection returns 200 { data: { user: { id, name, email } } }.
 *   - A selection of a non-existent field returns 200 { errors: [{ message }] }
 *     (the errors[]-is-failure path).
 *   - The requested id resolves from an inline arg and from variables.
 *   - Determinism: identical requests return identical bodies.
 */
import type {
    SimKnobs,
    SimRequest,
} from '../../../../docs/sandbox/contracts/sim';
import { graphqlHandlers } from './graphql';

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(
    query: string,
    variables?: Record<string, unknown>,
): SimRequest {
    return {
        method: 'POST',
        url: new URL('https://demo.stitchapi.dev/graphql'),
        headers: new Headers({ 'content-type': 'application/json' }),
        body: { query, variables },
    };
}

const EMPTY_KNOBS: SimKnobs = {};

function findHandler(req: SimRequest) {
    const h = graphqlHandlers.find((handler) => handler.match(req));
    if (!h)
        throw new Error(`No handler matched ${req.method} ${req.url.pathname}`);
    return h;
}

async function dispatch(req: SimRequest) {
    return findHandler(req).handle(req, EMPTY_KNOBS);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
    // ------------------------------------------------------------------
    // 1. user(id) selection → { data: { user: { id, name, email } } }
    // ------------------------------------------------------------------
    {
        const req = makeReq('{ user(id: 1) { id name email } }');
        const res = await dispatch(req);

        assert.equal(
            res.status,
            200,
            'graphql user query status should be 200',
        );
        const body = res.body as {
            data?: { user?: { id: number; name: string; email: string } };
            errors?: unknown;
        };
        assert.ok(body.data, 'response should carry a data envelope');
        assert.equal(
            body.errors,
            undefined,
            'a valid query must not carry errors',
        );
        const user = body.data!.user!;
        assert.equal(user.id, 1, 'resolved user id should be 1');
        assert.equal(user.name, 'Alice Liddell');
        assert.ok(typeof user.email === 'string', 'email should be a string');
        assert.equal(user.email, 'alice@demo.stitchapi.dev');
    }

    // ------------------------------------------------------------------
    // 2. id resolved from an inline argument (id: 2)
    // ------------------------------------------------------------------
    {
        const req = makeReq('{ user(id: 2) { id name email } }');
        const res = await dispatch(req);
        const body = res.body as {
            data: { user: { id: number; name: string } };
        };
        assert.equal(body.data.user.id, 2);
        assert.equal(body.data.user.name, 'Bob Hoskins');
    }

    // ------------------------------------------------------------------
    // 3. id resolved from variables (query GetUser($id: Int) ... user(id: $id))
    // ------------------------------------------------------------------
    {
        const req = makeReq(
            'query GetUser($id: Int!) { user(id: $id) { id name email } }',
            { id: 3 },
        );
        const res = await dispatch(req);
        const body = res.body as {
            data: { user: { id: number; name: string } };
        };
        assert.equal(body.data.user.id, 3, 'id should resolve from variables');
        assert.equal(body.data.user.name, 'Carol Danvers');
    }

    // ------------------------------------------------------------------
    // 4. Unknown field → 200 with errors[] (the errors-is-failure path)
    // ------------------------------------------------------------------
    {
        const req = makeReq('{ user(id: 1) { id phoneNumber } }');
        const res = await dispatch(req);

        assert.equal(
            res.status,
            200,
            'graphql transport stays HTTP 200 even on a field error',
        );
        const body = res.body as {
            data?: unknown;
            errors?: Array<{ message: string }>;
        };
        assert.ok(
            Array.isArray(body.errors),
            'unknown-field query must return an errors[] array',
        );
        assert.ok(body.errors!.length > 0, 'errors[] must be non-empty');
        assert.ok(
            /Cannot query field "phoneNumber"/.test(body.errors![0].message),
            'error message should name the offending field',
        );
        assert.equal(
            body.data,
            undefined,
            'an errored query must not also return data',
        );
    }

    // ------------------------------------------------------------------
    // 5. A query that does not reference `user` at all → unknown root field
    // ------------------------------------------------------------------
    {
        const req = makeReq('{ widgets { id } }');
        const res = await dispatch(req);
        assert.equal(res.status, 200);
        const body = res.body as { errors?: Array<{ message: string }> };
        assert.ok(
            Array.isArray(body.errors),
            'a non-user query must return errors[]',
        );
    }

    // ------------------------------------------------------------------
    // 6. Only POST /graphql is claimed (GET should not match)
    // ------------------------------------------------------------------
    {
        const getReq: SimRequest = {
            method: 'GET',
            url: new URL('https://demo.stitchapi.dev/graphql'),
            headers: new Headers(),
        };
        const claimed = graphqlHandlers.some((h) => h.match(getReq));
        assert.equal(claimed, false, 'GET /graphql should not be matched');
    }

    // ------------------------------------------------------------------
    // 7. Determinism — identical request returns identical body twice
    // ------------------------------------------------------------------
    {
        const req = makeReq('{ user(id: 2) { id name email } }');
        const r1 = await dispatch(req);
        const r2 = await dispatch(req);
        assert.deepEqual(
            r1.body,
            r2.body,
            'identical graphql queries must return identical bodies',
        );
    }

    console.log('GraphQL OK');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
