// `stitch()` reads RFC 6570 path-template vars off a string-literal `path` / `url` and folds them into
// the `params` slot of the inferred call argument (Phase 2c) — so a templated endpoint, whose engine
// expands `path` against `input.params`, has a correctly *required* call argument. We assert on the
// call-argument type via `CallArg` (a `Stitch<…>` bound can't see required-arg stitches, and
// `expectType<Stitch<…>>` is broken by the recursive `with()`); positive "this call compiles" cases live
// in the runtime spec (test/path-vars.spec.ts) with `await`, so they aren't floating promises here.
//
// `const C` on the inferring overloads is what preserves the string LITERAL of `path` / `url` for the
// extractor — without it the literal widens to `string` and no vars are read — so these plain
// `stitch({ path: '…' })` forms (no `as const`) exercise that capture too.
import { seam, stitch } from '..';
import type { StitchInput } from '..';
import { type CallArg } from './_util';

import { expectAssignable, expectError, expectType } from 'tsd';
import { z } from 'zod';

// 1) bare `{id}`: params is present, required, and typed `string | number`; the arg is required.
const u = stitch({ path: '/users/{id}' });
expectType<{ id: string | number }>(
    null as unknown as NonNullable<CallArg<typeof u>>['params'],
);
expectError(u()); // params required → no-arg call is an error
expectError(u({})); // params still required
expectError(u({ query: { page: 1 } })); // params still required

// 2) path var + `input.params` schema for a SHARED key: the schema type wins for `id`, the path adds
//    the rest (`postId`) as required `string | number`.
const post = stitch({
    path: '/u/{id}/p/{postId}',
    input: { params: z.object({ id: z.string() }) },
});
expectType<string>(
    null as unknown as NonNullable<CallArg<typeof post>>['params']['id'], // schema wins (not string|number)
);
expectType<string | number>(
    null as unknown as NonNullable<CallArg<typeof post>>['params']['postId'], // path-only → string|number
);
expectError(post()); // params required
expectError(post({ params: { id: 'a' } })); // missing the path-only `postId`

// 3) operators and modifiers are stripped to bare names (mirrors `expandPath`'s varspec parse):
//    `{?q,sort}` → `q | sort`; `{id*}` (explode) → `id`; `{id:2}` (prefix) → `id`.
const query = stitch({ path: '/search{?q,sort}' });
expectType<{ q: string | number; sort: string | number }>(
    null as unknown as NonNullable<CallArg<typeof query>>['params'],
);
const explode = stitch({ url: 'https://api.example.com/files/{id*}' });
expectType<{ id: string | number }>(
    null as unknown as NonNullable<CallArg<typeof explode>>['params'],
);
const prefix = stitch({ url: 'https://api.example.com/u/{id:2}' });
expectType<{ id: string | number }>(
    null as unknown as NonNullable<CallArg<typeof prefix>>['params'],
);

// 4) a literal `?page=1` after the path is a query default, NOT a template var (it lives outside any
//    `{…}` brace) — so no params are required and the argument stays optional.
const literalQuery = stitch({ path: '/items?page=1' });
expectType<StitchInput | undefined>(
    null as unknown as CallArg<typeof literalQuery>,
);
expectAssignable<CallArg<typeof literalQuery>>(undefined);

// 5) a thunk `url` has no string literal to walk → no path params (fail open); the argument is optional.
const thunk = stitch({ url: () => 'https://api.example.com/ping' });
expectType<StitchInput | undefined>(null as unknown as CallArg<typeof thunk>);
expectAssignable<CallArg<typeof thunk>>(undefined);

// 6) `.with({ params })` relaxes the whole `params` slot (per-key partial binding is out of scope), so a
//    previously-required templated arg becomes optional once params are bound.
const bound = u.with({ params: { id: 1 } });
expectAssignable<CallArg<typeof bound>>(undefined);

// 7) `url` (host included) is templated too: a `{tenant}` in the host is a required param.
const host = stitch({ url: 'https://{tenant}.example.com/v1/ping' });
expectType<{ tenant: string | number }>(
    null as unknown as NonNullable<CallArg<typeof host>>['params'],
);
expectError(host());

// 8) `path` wins the var source when both `path` and `url` are literals (the engine never expands both;
//    reading `path` first is the stable choice).
const both = stitch({ path: '/p/{p}', url: 'https://x/u/{u}' });
expectType<{ p: string | number }>(
    null as unknown as NonNullable<CallArg<typeof both>>['params'],
);

// 9) a non-templated stitch is byte-for-byte Phase 2: no `{…}` → loose, OPTIONAL argument (backward compat).
const plain = stitch({ path: '/ping' });
expectType<StitchInput | undefined>(null as unknown as CallArg<typeof plain>);
expectAssignable<CallArg<typeof plain>>(undefined);

// 10) other input slots keep their own shape/required-ness alongside a folded `params`. A required `body`
//     schema stays required; `params` is added required from the path var. Since a declared sibling slot
//     (`body`) now leaves `params` with its loose `Record<string, unknown>` passthrough (issue #134), the
//     folded slot is that passthrough INTERSECTED with the path-only `{ id }` — the required modifier from
//     the fold wins (still required), and the path-only key keeps `string | number`; extra loose keys are
//     tolerated. A no-input templated stitch (case 1) stays byte-clean `{ id }` — only a declared sibling
//     brings the index-signature tail.
const withBody = stitch({
    path: '/u/{id}',
    input: { body: z.object({ name: z.string() }) },
});
expectType<{ name: string }>(
    null as unknown as NonNullable<CallArg<typeof withBody>>['body'],
);
expectType<Record<string, unknown> & { id: string | number }>(
    null as unknown as NonNullable<CallArg<typeof withBody>>['params'],
);
expectError(withBody({ body: { name: 'Ada' } })); // params still required
expectError(withBody({ params: { id: 1 } })); // body still required
expectAssignable<CallArg<typeof withBody>>({
    body: { name: 'Ada' },
    params: { id: 1, extra: 'tolerated' }, // path-only params carry the loose index-signature tail
});

// 11) seam members (root, principal-bound, and graphql) fold path vars identically.
const api = seam({ baseUrl: 'https://x' });
const member = api.stitch({ path: '/users/{id}' });
expectType<{ id: string | number }>(
    null as unknown as NonNullable<CallArg<typeof member>>['params'],
);
expectError(member());
const asMember = api.as('u1').stitch({ path: '/orgs/{org}' });
expectType<{ org: string | number }>(
    null as unknown as NonNullable<CallArg<typeof asMember>>['params'],
);
expectError(asMember());
const gqlMember = api.graphql({
    query: 'query { ok }',
    path: '/gql/{region}',
});
expectType<{ region: string | number }>(
    null as unknown as NonNullable<CallArg<typeof gqlMember>>['params'],
);
expectError(gqlMember());
