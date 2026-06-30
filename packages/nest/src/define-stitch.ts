// Injectable stitch definitions (ADR 0006 Decision 4). A definition builds against
// the common subset of `Seam` and `PrincipalSeam`, so the SAME definition resolves
// against the app-wide singleton seam OR a request-scoped principal handle — only the
// provider's `inject` differs.
import { Inject, type InjectionToken } from '@nestjs/common';
import type { Seam, Stitch, StitchInput } from 'stitchapi';

/** Both `Seam` and `PrincipalSeam` satisfy this — the host a stitch is built from. */
export type NestRequestSeam = Pick<Seam, 'stitch' | 'graphql'>;

/**
 * @deprecated Renamed to {@link NestRequestSeam} so the public type is ecosystem-qualified (a bare
 * `StitchHost` would collide with any other host adapter's per-request seam type) — see
 * [ADR 0012](../../../docs/adr/0012-integration-symbol-naming.md). Kept through the `1.0.0-rc`
 * line and removed at the 1.0 GA cut.
 */
export type StitchHost = NestRequestSeam;

export interface StitchDef<TOut = unknown, TIn = StitchInput> {
    token: InjectionToken;
    build: (host: NestRequestSeam) => Stitch<TOut, TIn>;
}

/**
 * A def of **any** call-argument shape — `never` in the contravariant `TIn` slot makes every
 * concrete `StitchDef` assignable, including a templated-path def whose call argument now *requires*
 * `params` (path-template inference) or one with a required `body`. A plain `StitchDef` (=
 * `StitchDef<unknown, StitchInput>`) would reject those, since a required-input call signature is
 * narrower than the loose one. Used wherever defs are held heterogeneously or input-erased — a
 * feature registry (`forFeature`'s `stitches`) or the `@InjectStitch` token-lookup — where the
 * static input shape is intentionally widened away; per-def inference (`Injected<typeof Def>`) is
 * unaffected and still recovers the exact `TIn`. Mirrors core's `StitchRegistry` element
 * (`Stitch<unknown, never>` in `packages/core/src/registry.ts`).
 */
export type AnyStitchDef = StitchDef<unknown, never>;

/**
 * Declare an injectable stitch: a builder that receives the seam (root or
 * principal-bound) the registering module hands it. The injection **token is
 * optional** — omit it and a unique `Symbol` is generated, since you reference the
 * stitch by its definition object everywhere anyway (`forFeature({ stitches: [GetUser] })`,
 * `@InjectStitch(GetUser)`, `overrideProvider(GetUser.token)`). Pass an explicit
 * `InjectionToken` first only when you need a stable, well-known token (e.g. to
 * override it from a module that does not import the def).
 *
 * ```ts
 * export const GetUser = defineStitch((s) => s.stitch({ path: '/users/{id}' }));
 * export const GetUser = defineStitch('GET_USER', (s) => s.stitch({ path: '/users/{id}' }));
 * ```
 */
export function defineStitch<TOut = unknown, TIn = StitchInput>(
    build: (host: NestRequestSeam) => Stitch<TOut, TIn>,
): StitchDef<TOut, TIn>;
export function defineStitch<TOut = unknown, TIn = StitchInput>(
    token: InjectionToken,
    build: (host: NestRequestSeam) => Stitch<TOut, TIn>,
): StitchDef<TOut, TIn>;
export function defineStitch<TOut = unknown, TIn = StitchInput>(
    a: InjectionToken | ((host: NestRequestSeam) => Stitch<TOut, TIn>),
    b?: (host: NestRequestSeam) => Stitch<TOut, TIn>,
): StitchDef<TOut, TIn> {
    // Disambiguate on whether a second arg was passed — NOT `typeof a`, because an
    // InjectionToken can itself be a function (a class token), which would misread as
    // the builder. Two args → (token, build); one arg → (build) with a generated token.
    const build = (b ?? a) as (host: NestRequestSeam) => Stitch<TOut, TIn>;
    const token: InjectionToken = b ? (a as InjectionToken) : Symbol('stitch');
    return { token, build };
}

/**
 * The injected stitch's type, derived from its definition — keeps the injection-site
 * annotation linked to the def (no hand-retyped `Stitch<T>`):
 * `@InjectStitch(GetUser) getUser: Injected<typeof GetUser>`.
 */
export type Injected<D> =
    D extends StitchDef<infer TOut, infer TIn> ? Stitch<TOut, TIn> : never;

/** `@InjectStitch(def)` — sugar for `@Inject(def.token)`. Accepts an any-input
 *  {@link AnyStitchDef} so a templated-path def (required `params`) injects too. */
export const InjectStitch = (def: AnyStitchDef): ParameterDecorator =>
    Inject(def.token);
