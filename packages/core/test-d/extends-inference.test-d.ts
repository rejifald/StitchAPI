// `stitch()` / `seam` infer the CALL-ARGUMENT (and result) type from `input`/`output` schemas a
// fragment contributes through `extends` — not just the top-level config (issue #76). The runtime
// `compose()` already deep-merges these slots; these tests pin the STATIC type now mirrors it.
//
// Assertions follow input-inference.test-d.ts: `CallArg<typeof s>` for the call-argument type (a
// `Stitch<…>` bound can't see required-arg stitches and `expectType<Stitch<…>>` is broken by the
// recursive `with()`), `output(s)` for the resolved result, and `expectError` / `@ts-expect-error`
// for the negative cases. The merge engages only for an INLINE `extends` tuple — `stitch`/`seam`
// capture config with a `const` type parameter, so the literal array's per-fragment slot types
// survive (a pre-widened `Fragment[]` array would fall back to the top-level read).
import { seam, stitch } from '..';
import type { StitchConfig } from '..';
import { output } from './_util';
import { type CallArg } from './_util';

import { expectError, expectType } from 'tsd';
import { z } from 'zod';

const userSchema = z.object({ id: z.number(), name: z.string() });
type User = z.infer<typeof userSchema>;

// 1) a `headers` schema contributed PURELY by an `extends` fragment shows up in the call argument —
//    the headline of #76. The child declares no `headers`; it comes entirely from `base`.
const base = { input: { headers: z.object({ 'x-tenant': z.string() }) } };
const fromFragment = stitch({
    extends: [base],
    input: { body: z.object({ name: z.string() }) },
});
expectType<{ 'x-tenant': string }>(
    null as unknown as CallArg<typeof fromFragment>['headers'],
);
// 1b) and the child's own `body` MERGES with the fragment's `headers` (key-union across layers).
expectType<{ name: string }>(
    null as unknown as CallArg<typeof fromFragment>['body'],
);
// both slots are required → a no-arg call (and a call missing `headers`) is an error.
expectError(fromFragment());
expectError(fromFragment({ body: { name: 'Ada' } })); // missing the fragment's `headers`

// 2) LAST-WINS per slot across fragments: two fragments both declare `body`; the later one (closer
//    to the child) wins the whole slot. `base1.body` is `{ a }`, `base2.body` is `{ b: number }` —
//    the merged call arg must require `{ b: number }`, not `{ a: string }`.
const base1 = { input: { body: z.object({ a: z.string() }) } };
const base2 = { input: { body: z.object({ b: z.number() }) } };
const lastWins = stitch({ extends: [base1, base2] });
expectType<{ b: number }>(null as unknown as CallArg<typeof lastWins>['body']);

// 3) NESTED extends: a fragment that itself `extends` another. The depth-first walk surfaces the
//    innermost `params`, the middle `query`, and the child's `body`, all merged. The nesting is
//    written INLINE so every `extends` is captured as a tuple (a fragment pulled from a `const`
//    variable would widen its own `extends` to a `Fragment[]` array, and the deeper layer would
//    fall back to the top-level read — the documented tuple-only engagement).
const nested = stitch({
    extends: [
        {
            extends: [{ input: { params: z.object({ id: z.string() }) } }],
            input: { query: z.object({ page: z.number() }) },
        },
    ],
    input: { body: z.object({ x: z.number() }) },
});
expectType<{ id: string }>(null as unknown as CallArg<typeof nested>['params']);
expectType<{ page: number }>(
    null as unknown as CallArg<typeof nested>['query'],
);
expectType<{ x: number }>(null as unknown as CallArg<typeof nested>['body']);

// 4) OUTPUT via a fragment: an `output` schema declared only on a fragment infers the result type
//    (the parallel #76 fix for Phase-1 output inference). The child declares no `output`.
const outFrag = { output: userSchema };
const outFromFragment = stitch({ extends: [outFrag], path: '/users' });
expectType<User>(output(outFromFragment));
// 4b) the CHILD's `output` wins over a fragment's (last writer of the whole slot).
const childWins = stitch({
    extends: [{ output: z.object({ a: z.string() }) }],
    output: userSchema,
});
expectType<User>(output(childWins));

// 5) STITCH-as-fragment is an accepted limitation (finding #2): a `Stitch` used in `extends`
//    contributes nothing NARROWING. It carries no top-level `input`/`output` key (its config lives,
//    loosely typed, under `__rawConfig`), so the merge reads nothing extra from it — the runtime
//    still composes its config, only the static narrowing is dropped. A LOOSE stitch (no input
//    schemas) is what fits the `Fragment` union here: a typed stitch's narrowed call arg is not
//    assignable to the loose `Stitch` member of `extends` (a pre-existing `Stitch`-variance limit,
//    independent of #76 — `with()` makes `TIn` appear contravariantly), so it can't be a fragment.
const looseStitch = stitch({ path: '/dep' });
const fromStitchFrag = stitch({
    extends: [looseStitch],
    input: { body: z.object({ name: z.string() }) },
});
// the stitch fragment narrows nothing; only the child's own `body` shapes the argument.
expectType<{ name: string }>(
    null as unknown as CallArg<typeof fromStitchFrag>['body'],
);
expectError(fromStitchFrag()); // the child's `body` is still required

// 6) a bare STRING fragment contributes only `path` — nothing that narrows the call argument.
const fromStringFrag = stitch({
    extends: ['/from-string'],
    input: { body: z.object({ name: z.string() }) },
});
expectType<{ name: string }>(
    null as unknown as CallArg<typeof fromStringFrag>['body'],
);

// 7) a SEAM contributes its fragment too, and a member merges the seam's defaults with its own
//    `extends` + top-level `input`. A `params` schema from the member's `extends` fragment surfaces.
const api = seam({ baseUrl: 'https://x' });
const member = api.stitch({
    extends: [{ input: { params: z.object({ region: z.string() }) } }],
    input: { body: z.object({ name: z.string() }) },
});
expectType<{ region: string }>(
    null as unknown as CallArg<typeof member>['params'],
);
expectType<{ name: string }>(null as unknown as CallArg<typeof member>['body']);

// 8) the SEAM shared fragment STRUCTURALLY cannot carry `input`/`output` — `SeamConfig` Omits both
//    (types.ts), so #76's "apply to the seam fragment" is a no-op for these two slots BY
//    CONSTRUCTION (we never widen `SeamConfig`). A seam that tries to declare either is a type
//    error: only the member's `extends:[…]` array can contribute schemas.
// @ts-expect-error — a seam fragment cannot declare `input` (SeamConfig omits it).
seam({ baseUrl: 'https://x', input: { body: z.object({ name: z.string() }) } });
// @ts-expect-error — a seam fragment cannot declare `output` (SeamConfig omits it).
seam({ baseUrl: 'https://x', output: userSchema });

// 8b) …and the seam adds NOTHING of its own either. Its parameter is `SeamConfig`, a projection
//     of `StitchConfig` — CONTRACT.md P16: a config field is declared once, on `StitchConfig`,
//     and projected, never re-declared per surface. `secretStore` was exactly that re-declaration
//     for one release (a `SeamOptions = SeamConfig & { secretStore }` intersection), and the cost
//     was silent: the hardened vault it configured was unreachable from a standalone `stitch()`,
//     from fastify's `seamConfig`, and from a nest feature seam, all three of which type their
//     config slot as `SeamConfig`. No ratchet sees an intersection literal, so the gate is here.
type SeamOnlySlots = Exclude<
    keyof Parameters<typeof seam>[0],
    keyof StitchConfig
>;
expectType<never>(null as unknown as SeamOnlySlots);

// 9) REGRESSION GUARD: a config with NO `extends` is byte-identical to the top-level-only read.
//    A required top-level `body` stays required; no `extends` machinery changes its inference.
const noExtends = stitch({ input: { body: z.object({ name: z.string() }) } });
expectType<{ name: string }>(
    null as unknown as CallArg<typeof noExtends>['body'],
);
expectError(noExtends());
