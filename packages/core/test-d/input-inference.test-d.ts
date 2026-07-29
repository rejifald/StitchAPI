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
    document: 'query { ok }',
    input: { params: z.object({ region: z.string() }) },
});
expectType<{ region: string }>(
    null as unknown as CallArg<typeof gqlTyped>['params'],
);
// A graphql stitch with NO `input.variables` schema keeps `variables` as a loose untyped
// passthrough. (Issue #75 makes a DECLARED `input.variables` schema type them — covered in
// graphql-variables.test-d.ts; this case pins the schema-less behaviour stays unchanged.)
const gqlLoose = api.graphql({ document: 'query { ok }', output: userSchema });
expectAssignable<CallArg<typeof gqlLoose>>({ variables: { region: 'eu' } });

// 7) a non-schema `input` slot value is rejected at compile time.
expectError(stitch({ input: { body: 123 } }));
expectError(stitch({ input: { params: 'nope' } }));

// 8) declaring ONE slot must NOT close `params`/`query`: they pass through loosely beside the typed
//    slot, mirroring `variables`/`signal`/`onProgress` (issue #134 — the runtime reads input by field
//    name regardless). A body-only, NON-templated stitch still accepts a call arg with `params`/`query`.
const bodyOnly = stitch({
    input: { body: z.object({ name: z.string() }) },
    output: userSchema,
});
expectType<{ name: string }>(
    null as unknown as CallArg<typeof bodyOnly>['body'], // body still required + schema-typed
);
expectAssignable<CallArg<typeof bodyOnly>>({
    body: { name: 'Ada' },
    params: { id: 1 }, // loose params passthrough — no longer "Object literal may only specify…"
    query: { page: 2 }, // loose query passthrough
});
expectError(bodyOnly({ params: { id: 1 } })); // body still required → arg without body is an error

// 9) a DECLARED `query` schema keeps `query` typed BY THE SCHEMA, not widened to Record<string, unknown>
//    (the loose passthrough only applies when the slot is UNdeclared). Same for a declared `params`.
const queryTyped = stitch({
    input: { query: z.object({ page: z.number() }) },
});
expectType<{ page: number }>(
    null as unknown as CallArg<typeof queryTyped>['query'],
);
expectError(queryTyped({ query: { page: 'one' } })); // page must be a number — schema still bites
const paramsTyped = stitch({
    input: { params: z.object({ id: z.string() }) },
});
expectType<{ id: string }>(
    null as unknown as CallArg<typeof paramsTyped>['params'],
);
expectError(paramsTyped({ params: { id: 1 } })); // id must be a string — schema still bites

// 10) a path-template `params` stays REQUIRED even though the loose `params?` passthrough is now in
//     CallInput: FoldPathParams intersects a REQUIRED `params` over the base, and the required modifier
//     wins. The folded slot is the loose passthrough INTERSECTED with the path-only `{ id }` (so extra
//     keys are tolerated), but `params` is still required — a body-only stitch on `/users/{id}` must pass
//     it. (path-vars.test-d.ts covers the broader path-template matrix; this pins the #134 interaction.)
const templated = stitch({
    path: '/users/{id}',
    input: { body: z.object({ name: z.string() }) },
});
expectType<Record<string, unknown> & { id: string | number }>(
    null as unknown as NonNullable<CallArg<typeof templated>>['params'],
);
expectError(templated({ body: { name: 'Ada' } })); // params still required by the path var
expectAssignable<CallArg<typeof templated>>({
    body: { name: 'Ada' },
    params: { id: 1, extra: 'tolerated' }, // path-only params keep the loose index-signature tail
});

// 11) a no-input, non-templated stitch is unchanged: still the loose, fully-optional StitchInput.
const bare = stitch({ path: '/ping' });
expectType<StitchInput | undefined>(null as unknown as CallArg<typeof bare>);
expectAssignable<CallArg<typeof bare>>(undefined);
