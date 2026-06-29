// Type-level regression for `pipe` (stitchapi/pipe, ADR 0008): a pipe must accept ANY stitch as a
// member regardless of its inferred input/output. `Stitch<TOut, TIn>` is contravariant in `TIn`
// (call signature + `with()`), so a stitch built from a templated URL — whose `TIn` carries a
// required `params: { id }` — is NOT assignable to the bare `Stitch<unknown, StitchInput>` default.
// Before the fix, the idiom in pipe's own JSDoc and in the compose-a-pipeline blog post failed with
// TS2345; the parameter/`PipeStep.stitch` types are now variance-erased (`Stitch<unknown, never>`).
//
// The assertion here is simply that these constructions COMPILE — a type error in any of them fails
// the `check:types-d` gate. (Runtime behaviour is covered in test/pipe.spec.ts.)
import { stitch } from '../src';
import type { StitchInput } from '../src';
import { pipe } from '../src/pipe';

import { expectError, expectType } from 'tsd';
import { z } from 'zod';

const User = z.object({ id: z.number(), name: z.string() });
type User = z.infer<typeof User>;
const Post = z.object({ id: z.number(), title: z.string() });
type Post = z.infer<typeof Post>;

// A stitch from a TEMPLATED url + output schema: its inferred `TIn` requires `params: { id }`, and
// its `TOut` is `User` — the exact narrowing that broke assignability to the bare `Stitch` default.
const fetchUser = stitch({
    url: 'https://api.example.com/users/{id}',
    output: User,
});
const fetchPosts = stitch({
    url: 'https://api.example.com/posts',
    output: z.array(Post),
});

// 1) The headline repro: a typed stitch as the FIRST step, plus a `PipeStep` whose `.stitch` is also
//    a typed stitch. Pre-fix this was `TS2345: ... not assignable to 'Stitch<unknown, StitchInput>'`.
const userPosts = pipe(fetchUser, {
    stitch: fetchPosts,
    input: (u) => ({ query: { userId: (u as User).id } }),
});
// The returned callable takes the FIRST step's input and resolves to `Out` (defaults to `unknown`).
expectType<(input?: StitchInput) => Promise<unknown>>(userPosts);

// 2) The `Out` generic flows through to the returned promise.
const typedFlow = pipe<Post[]>(fetchUser, {
    stitch: fetchPosts,
    input: (u) => ({ query: { userId: (u as User).id } }),
});
expectType<(input?: StitchInput) => Promise<Post[]>>(typedFlow);

// 3) A bare typed stitch (no wrapping `PipeStep`) is accepted on its own.
expectType<(input?: StitchInput) => Promise<unknown>>(pipe(fetchUser));

// 4) A plain, non-templated stitch (loose `StitchInput`) still composes — the widening accepts every
//    stitch, not only the narrow ones.
const ping = stitch({ url: 'https://api.example.com/ping' });
expectType<(input?: StitchInput) => Promise<unknown>>(pipe(ping, fetchUser));

// 5) A stitch with a REQUIRED `body` schema (another narrowing of `TIn`) is accepted too.
const createUser = stitch({
    url: 'https://api.example.com/users',
    input: { body: z.object({ name: z.string() }) },
    output: User,
});
expectType<(input?: StitchInput) => Promise<unknown>>(
    pipe(createUser, fetchUser),
);

// 6) A non-stitch, non-`PipeStep` value is still rejected — the widening erases variance, not the
//    member shape.
expectError(pipe(fetchUser, 42));
expectError(pipe({ notAStitch: true }));
