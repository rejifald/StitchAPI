// Helpers for the type tests. NOT a `*.test-d.ts` file, so tsd treats it as a plain module.
//
// Why not `expectType<Stitch<User>>(...)`? tsd's identity check short-circuits on `Stitch<T>`'s
// recursive `with(): Stitch<T>` self-reference and reports any two `Stitch<X>` as identical. So we
// assert on the UNWRAPPED result type instead — `output(call)` is typed as exactly what
// `await call()` resolves to, a plain type tsd compares precisely.
import type { Stitch } from '..';

/** Returns a value typed as the stitch's resolved (awaited, unwrapped) output. */
export declare function output<S extends Stitch<unknown>>(
    stitch: S,
): Awaited<ReturnType<S>>;

// The Phase 2 analogue for INPUTS. `expectType<Stitch<…>>` is still useless (same recursive-`with`
// reason), so assert on the call-ARGUMENT type instead. The constraint is a universal function, not
// `Stitch<unknown>`: a stitch with a REQUIRED first argument (e.g. a non-optional `body` schema) is
// not assignable to any `Stitch` whose call signature has an OPTIONAL first arg, so a `Stitch<…>`
// bound would reject exactly the typed-input stitches we want to test.
/** The stitch's (single) call-argument type — `TIn` for a required arg, `TIn | undefined` for an optional one. */
export type CallArg<S extends (...args: never[]) => unknown> = Parameters<S>[0];
