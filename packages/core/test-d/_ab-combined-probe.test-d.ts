// THROWAWAY A+B integration probe (not part of either PR). Proves the two coupled features interact:
//   A (#114) — RFC 6570 path-template vars folded into `params`.
//   B (#76)  — input/output inferred across `extends` fragments.
// A stitch with BOTH a templated `path` AND an `extends` fragment that contributes an `input` schema
// must require `params` (from the path) AND the fragment's slot (from `extends`), simultaneously.
import { seam, stitch } from '..';
import { type CallArg } from './_util';

import { expectError, expectType } from 'tsd';
import { z } from 'zod';

// ---- Core combined case (the procedure's example) --------------------------------------------------
// `base` contributes a required `headers` schema purely through `extends`; the leaf adds a templated
// `path` whose `{id}` var must fold into `params`. Both must surface, both required.
const base = { input: { headers: z.object({ 'x-tenant': z.string() }) } };
const s = stitch({ extends: [base], path: '/users/{id}' });

// params.id is present, required, and `string | number` (the path-var fold over the extends-merged base).
expectType<{ id: string | number }>(
    null as unknown as NonNullable<CallArg<typeof s>>['params'],
);
// headers is present and required (contributed by the `extends` fragment, #76).
expectType<{ 'x-tenant': string }>(
    null as unknown as NonNullable<CallArg<typeof s>>['headers'],
);
// Both slots required → these calls must be errors.
expectError(s()); // missing both
expectError(s({ params: { id: 1 } })); // missing the fragment's `headers`
expectError(s({ headers: { 'x-tenant': 't' } })); // missing the path var `params`
// Supplying both compiles (no expectError) — the positive case.
s({ params: { id: 1 }, headers: { 'x-tenant': 't' } });

// ---- A path-var key that ALSO has a fragment `params` schema (schema wins, path adds the rest) ------
// `pbase` contributes `params.id: string` via a fragment; the leaf path adds `{postId}`. The merged
// `params` must take `id` from the schema (string, not string|number) and `postId` from the path.
const pbase = { input: { params: z.object({ id: z.string() }) } };
const shared = stitch({ extends: [pbase], path: '/u/{id}/p/{postId}' });
expectType<string>(
    null as unknown as NonNullable<CallArg<typeof shared>>['params']['id'], // fragment schema wins
);
expectType<string | number>(
    null as unknown as NonNullable<CallArg<typeof shared>>['params']['postId'], // path-only
);
expectError(shared({ params: { id: 'a' } })); // missing the path-only `postId`

// ---- A fragment `body` + a leaf `body` (last-wins, #76) alongside a folded `params` (#114) ----------
const bbase = { input: { body: z.object({ a: z.string() }) } };
const both = stitch({
    extends: [bbase],
    path: '/things/{thingId}',
    input: { body: z.object({ b: z.number() }) }, // leaf body wins the slot
});
expectType<{ b: number }>(
    null as unknown as NonNullable<CallArg<typeof both>>['body'], // last-wins
);
expectType<{ thingId: string | number }>(
    null as unknown as NonNullable<CallArg<typeof both>>['params'], // path-var fold
);
expectError(both({ body: { b: 1 } })); // missing path var
expectError(both({ params: { thingId: 1 } })); // missing body

// ---- Same combined case through a seam member (surface-agnostic path the casts must cover) ----------
const api = seam({ baseUrl: 'https://x' });
const member = api.stitch({ extends: [base], path: '/orgs/{org}' });
expectType<{ org: string | number }>(
    null as unknown as NonNullable<CallArg<typeof member>>['params'],
);
expectType<{ 'x-tenant': string }>(
    null as unknown as NonNullable<CallArg<typeof member>>['headers'],
);
expectError(member());
