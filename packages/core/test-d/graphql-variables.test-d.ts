// Phase 2b (issue #75): a graphql stitch infers its `variables` CALL ARGUMENT from an
// `input.variables` schema — the slot that Phase 2 left as an untyped passthrough. Same tsd idioms
// as input-inference.test-d.ts: assert on `CallArg` (not `expectType<Stitch<…>>`), and use
// `expectError` for the missing/ill-typed cases. Positive "this call compiles" cases live in the
// runtime spec (test/graphql-and-headers.spec.ts) with `await`.
import { graphql, seam } from '..';
import { type CallArg } from './_util';

import { expectAssignable, expectError, expectType } from 'tsd';
import { z } from 'zod';

// 1) a declared `input.variables` schema types the call arg's `variables` and makes it required.
const getThing = graphql({
    document: 'query($id: ID!) { thing(id: $id) { name } }',
    input: { variables: z.object({ id: z.string() }) },
});
expectType<{ id: string }>(
    null as unknown as CallArg<typeof getThing>['variables'],
);
expectError(getThing()); // variables required → no-arg call is an error
expectError(getThing({ variables: {} })); // missing `id`
expectError(getThing({ variables: { id: 1 } })); // `id` is a string, not a number

// 2) an `.optional()` variables schema yields an OPTIONAL slot — the whole call arg becomes optional
//    (so a no-arg call stays legal, asserted via `{}` below), yet a present `variables` is still
//    type-checked: a bad shape is rejected.
const maybeVars = graphql({
    document: 'query { ok }',
    input: { variables: z.object({ region: z.string() }).optional() },
});
expectAssignable<CallArg<typeof maybeVars>>({}); // optional slot → empty arg is valid
expectAssignable<CallArg<typeof maybeVars>>({ variables: { region: 'eu' } });
expectError(maybeVars({ variables: { region: 1 } })); // region must be a string

// 3) a graphql stitch with NO variables schema keeps `variables` optional + a loose passthrough —
//    the pre-#75 behaviour, preserved now that `variables` is an InputSchemas slot. Any shape goes.
const loose = graphql({ document: 'query { ok }' });
expectAssignable<CallArg<typeof loose>>({ variables: { anything: 1 } });
expectAssignable<CallArg<typeof loose>>({}); // and the arg stays fully optional

// 4) `seam.graphql(...)` infers `variables` identically (it routes through the same `InputOf<C>`).
const api = seam({ baseUrl: 'https://api.example.com' });
const memberTyped = api.graphql({
    document: 'query($id: ID!) { thing(id: $id) { name } }',
    input: { variables: z.object({ id: z.string() }) },
});
expectType<{ id: string }>(
    null as unknown as CallArg<typeof memberTyped>['variables'],
);
expectError(memberTyped()); // required on a seam member too
expectError(memberTyped({ variables: { id: 1 } })); // wrong type on a seam member too

// a schema-less seam graphql member also keeps the loose passthrough.
const memberLoose = api.graphql({ document: 'query { ok }' });
expectAssignable<CallArg<typeof memberLoose>>({ variables: { anything: 1 } });
