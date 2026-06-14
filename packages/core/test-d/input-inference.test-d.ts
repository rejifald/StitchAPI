// `stitch()` infers its CALL-ARGUMENT type from `config.input` — the Phase 2 headline. We assert on
// the call-argument type via `CallArg` (a `Stitch<…>` bound can't see required-arg stitches, and
// `expectType<Stitch<…>>` is broken by the recursive `with()`), and use `expectError` /
// `expectNotAssignable` for missing / wrong fields. Positive "this call compiles" cases live in the
// runtime spec (test/input-inference.spec.ts) with `await`, so they aren't floating promises here.
import { seam, stitch } from '..';
import type { StitchInput } from '..';
import { type CallArg } from './_util';

import { expectAssignable, expectError, expectType } from 'tsd';
import { z } from 'zod';

const userSchema = z.object({ id: z.number(), name: z.string() });

// 1) a required body: the slot is present and fully shaped; the argument is required.
const createUser = stitch({
    input: { body: z.object({ name: z.string(), age: z.number() }) },
    output: userSchema,
});
expectType<{ name: string; age: number }>(
    null as unknown as CallArg<typeof createUser>['body'],
);
expectError(createUser()); // body is required → no-arg call is an error
expectError(createUser({ body: { name: 'Ada' } })); // missing `age`
expectError(createUser({ body: {} })); // missing both

// 2) params required + query optional in ONE config — proves per-slot required-ness.
//    A required `params` schema → required slot; a `.optional()` `query` schema → optional slot.
const search = stitch({
    input: {
        params: z.object({ id: z.string() }),
        query: z.object({ page: z.number() }).optional(),
    },
});
expectType<{ id: string }>(null as unknown as CallArg<typeof search>['params']);
expectType<{ page: number } | undefined>(
    null as unknown as CallArg<typeof search>['query'],
);
expectError(search()); // params required
expectError(search({ query: { page: 1 } })); // params still required

// 3) no `input` schemas → the loose StitchInput, and the argument stays OPTIONAL (backward compat).
const ping = stitch({ path: '/ping' });
expectType<StitchInput | undefined>(null as unknown as CallArg<typeof ping>);
expectAssignable<CallArg<typeof ping>>(undefined); // arg is optional

// 4) the explicit OUTPUT generic is an escape hatch: it still wins for the result type, but giving
//    a type argument stops TypeScript from inferring the config type `C` (partial type-argument
//    inference is unsupported), so input inference falls back to the loose StitchInput. This is a
//    documented limitation of the explicit-generic form — never worse than pre-Phase-2.
const explicit = stitch<{ ok: boolean }>({
    input: { body: z.object({ x: z.number() }) },
});
expectType<StitchInput | undefined>(
    null as unknown as CallArg<typeof explicit>,
);
// the bare string shorthand keeps the loose, optional argument too.
const str = stitch('/ping');
expectType<StitchInput | undefined>(null as unknown as CallArg<typeof str>);

// 5) `.with()` relaxes ONLY the bound top-level slots (the `const P` capture). Binding `params`
//    must NOT relax a still-required `body`.
const multi = stitch({
    input: {
        params: z.object({ id: z.string() }),
        body: z.object({ x: z.number() }),
    },
});
const partial = multi.with({ params: { id: 'x' } });
expectError(partial()); // body still required — only `params` was bound
const partial2 = partial.with({ body: { x: 1 } });
expectAssignable<CallArg<typeof partial2>>(undefined); // both bound now → arg optional
// binding `body` directly relaxes it to optional.
const bound = createUser.with({ body: { name: 'Ada', age: 30 } });
expectAssignable<CallArg<typeof bound>>(undefined);

// 6) seam members (root, principal-bound, and graphql) infer call args identically.
const api = seam({ baseUrl: 'https://x' });
const member = api.stitch({ input: { body: z.object({ name: z.string() }) } });
expectType<{ name: string }>(null as unknown as CallArg<typeof member>['body']);
expectError(member());
const asMember = api
    .as('u1')
    .stitch({ input: { params: z.object({ id: z.string() }) } });
expectType<{ id: string }>(
    null as unknown as CallArg<typeof asMember>['params'],
);
const gqlTyped = api.graphql({
    query: 'query { ok }',
    input: { params: z.object({ region: z.string() }) },
});
expectType<{ region: string }>(
    null as unknown as CallArg<typeof gqlTyped>['params'],
);
// GraphQL `variables` stay an untyped passthrough (typing them is deferred — see follow-up issue).
const gqlLoose = api.graphql({ query: 'query { ok }', output: userSchema });
expectAssignable<CallArg<typeof gqlLoose>>({ variables: { region: 'eu' } });

// 7) a non-schema `input` slot value is rejected at compile time.
expectError(stitch({ input: { body: 123 } }));
expectError(stitch({ input: { params: 'nope' } }));
