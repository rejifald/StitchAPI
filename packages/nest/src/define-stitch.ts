// Injectable stitch definitions (ADR 0006 Decision 4). A definition builds against
// the common subset of `Seam` and `PrincipalSeam`, so the SAME definition resolves
// against the app-wide singleton seam OR a request-scoped principal handle — only the
// provider's `inject` differs.
import { Inject, type InjectionToken } from '@nestjs/common';
import type { Seam, Stitch, StitchInput } from 'stitchapi';

/** Both `Seam` and `PrincipalSeam` satisfy this — the host a stitch is built from. */
export type StitchHost = Pick<Seam, 'stitch' | 'graphql'>;

export interface StitchDef<TOut = unknown, TIn = StitchInput> {
    token: InjectionToken;
    build: (host: StitchHost) => Stitch<TOut, TIn>;
}

/**
 * Declare an injectable stitch: an injection token plus a builder that receives the
 * seam (root or principal-bound) the registering module hands it. Prefer a `Symbol`
 * token to avoid string collisions across feature modules.
 */
export function defineStitch<TOut = unknown, TIn = StitchInput>(
    token: InjectionToken,
    build: (host: StitchHost) => Stitch<TOut, TIn>,
): StitchDef<TOut, TIn> {
    return { token, build };
}

/**
 * The injected stitch's type, derived from its definition — keeps the injection-site
 * annotation linked to the def (no hand-retyped `Stitch<T>`):
 * `@InjectStitch(GetUser) getUser: Injected<typeof GetUser>`.
 */
export type Injected<D> =
    D extends StitchDef<infer TOut, infer TIn> ? Stitch<TOut, TIn> : never;

/** `@InjectStitch(def)` — sugar for `@Inject(def.token)`. */
export const InjectStitch = (def: StitchDef): ParameterDecorator =>
    Inject(def.token);
