// The auth-descriptor resolver seam (ADR 0020, P21 extension seam).
//
// Core must resolve a declarative `auth` DESCRIPTOR (`{ strategy: 'oauth2', … }`) to a live
// {@link AuthStrategy} at construction — but it MUST NOT statically import the strategy factories
// (`bearer`/`apiKey`/`basic`/`oauth2`/`cookieSession`). Those live in `./auth`, and a static import
// would drag the whole auth module — the heavy `oauth2`/`cookieSession` machinery included — into the
// lean `import { stitch }` bundle for EVERY consumer, even ones that never touch auth.
//
// Instead this holds a resolver slot the auth module installs (`installAuthDescriptorResolver`) —
// NOT as a module-load side effect (esbuild would keep that, dragging the factories back into the
// lean bundle), but the first time a SECRET RESOLVER (`env`/`secretsFile`/`secretFrom`) runs. A real
// descriptor resolves its credential through one of those EAGERLY (`token: env('T')` runs while the
// descriptor literal is built, before `stitch()`), so the resolver is armed precisely when a
// descriptor is in play. A bare `import { stitch }` that never touches auth arms nothing, so the auth
// module — factories included — tree-shakes away; only this tiny slot + detection remain.
//
// Type-only imports (erased) — no runtime dependency on the factory-bearing module, so this stays a
// runtime leaf and the `stitch` → `auth-registry` edge never reaches `./auth`.
import type { AuthConfig, AuthDescriptor } from './auth';
import type { AuthStrategy } from './types';

let resolveDescriptor: ((d: AuthDescriptor) => AuthStrategy) | undefined;

/**
 * Install the descriptor→strategy resolver. `./auth` calls this the first time a secret resolver
 * runs; idempotent (last writer wins). Kept out of the public surface — an internal seam, not an API.
 */
export function installAuthDescriptorResolver(
    fn: (d: AuthDescriptor) => AuthStrategy,
): void {
    resolveDescriptor = fn;
}

/**
 * Resolve {@link StitchConfig.auth} intake to a live {@link AuthStrategy} (ADR 0020). Detection is
 * unambiguous for every real input (Q6): a value carrying an `apply` function IS a strategy — a
 * factory result or a BYO strategy, and `apply` **wins** even for the hand-spliced `{ strategy, apply
 * }` corner; otherwise a value carrying a `strategy` key is a descriptor, routed to the installed
 * resolver; a value with neither throws. Idempotent: a normalized strategy flowing back in as a
 * fragment (`__rawConfig.auth`) has `apply`, so it passes straight through — no resolver needed.
 */
export function normalizeAuth(auth: AuthConfig): AuthStrategy {
    if (typeof (auth as AuthStrategy).apply === 'function')
        return auth as AuthStrategy;
    if ('strategy' in auth) {
        if (!resolveDescriptor)
            // The resolver arms when a secret resolver (`env`/`secretsFile`/`secretFrom`) runs, which
            // a descriptor's credential normally does. Only a descriptor with a LITERAL secret and no
            // other auth import lands here — steer the author to the one-line fix.
            throw new Error(
                "declarative `auth` needs the resolver loaded: give the credential an env('X') " +
                    "value (or import any strategy from 'stitchapi'), or pass a factory result.",
            );
        return resolveDescriptor(auth);
    }
    throw new Error(
        '`auth` needs `apply` (a strategy) or `strategy` (a descriptor). Pass a factory result, ' +
            "or e.g. { strategy: 'bearer', token: env('TOKEN') }.",
    );
}
