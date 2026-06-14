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
