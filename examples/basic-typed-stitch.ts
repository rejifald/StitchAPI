/**
 * A basic, typed `stitch` with an `output` schema — run offline.
 *
 * This example shows three things at once:
 *
 *   1. A `stitch` is a typed `input → validated output` unit: you declare an
 *      `output` schema and the call's return type is inferred from it (no cast).
 *   2. The response is **validated** against that schema at runtime, so a vendor
 *      that drifts is caught instead of leaking an `undefined` downstream.
 *   3. The HTTP transport is pluggable: we inject a tiny **mock adapter**, so the
 *      whole thing runs deterministically with **no network** — which is exactly
 *      how you'd unit-test a stitch.
 *
 * Run it (from the repo root):
 *
 *   pnpm exec tsx examples/basic-typed-stitch.ts
 */
import assert from 'node:assert/strict';
import { stitch } from 'stitchapi';
import type { Adapter } from 'stitchapi';
import { z } from 'zod';

// 1. The output contract. The call's return type is inferred from this — `user`
//    below is `{ id: number; name: string; email: string }`, no generic needed.
const User = z.object({
    id: z.number(),
    name: z.string(),
    email: z.string().email(),
});

// 2. A mock adapter. An `Adapter` is just `(req) => Promise<{ status, headers, body }>`.
//    For a JSON response, `body` is the already-parsed object — so here we answer
//    deterministically and assert the engine built the request we expected. Swap
//    this for the default `fetch` transport and the same stitch hits the network.
const mockAdapter: Adapter = async (req) => {
    assert.equal(req.method, 'GET');
    assert.ok(
        req.url.endsWith('/users/42'),
        `expected the path template to resolve, got ${req.url}`,
    );
    return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: { id: 42, name: 'Ada Lovelace', email: 'ada@example.com' },
    };
};

// 3. The stitch. `{id}` is an RFC 6570 path template; `output` is the contract;
//    `adapter` injects our offline transport.
const getUser = stitch({
    baseUrl: 'https://api.example.test',
    path: '/users/{id}',
    output: User,
    adapter: mockAdapter,
});

async function main(): Promise<void> {
    // Awaiting a stitch runs it and returns the validated, typed value.
    const user = await getUser({ params: { id: 42 } });

    // `user` is fully typed off the schema — these are compile-time safe.
    console.log(`Fetched user #${user.id}: ${user.name} <${user.email}>`);

    assert.equal(user.id, 42);
    assert.equal(user.name, 'Ada Lovelace');

    // Drift demo: if the vendor returns a shape that violates the contract, the
    // stitch rejects instead of handing back garbage. Here `email` is missing.
    const drifted = stitch({
        baseUrl: 'https://api.example.test',
        path: '/users/{id}',
        output: User,
        adapter: async () => ({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: { id: 7, name: 'No Email' }, // <- contract violation
        }),
    });

    await assert.rejects(
        () => drifted({ params: { id: 7 } }),
        'a response that violates the output schema must reject',
    );
    console.log('Drift caught: an off-contract response was rejected. ✅');

    console.log('\nexamples/basic-typed-stitch OK');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
