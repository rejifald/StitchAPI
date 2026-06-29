// Minimal context shapes the plugin reads off Elysia's request/error contexts. Elysia's real
// `Context` / `ErrorContext` carry a forest of route-derived generics; the plugin only ever touches
// a handful of fields, so we declare those structurally. This keeps the public surface stable and
// the wiring readable without depending on Elysia's deep type machinery (the values still flow from
// the real Elysia context at runtime).
import type { ElysiaRequestSeam } from './plugin';

/**
 * The slice of Elysia's request context the `principal` resolver reads: just the incoming
 * Web-standard {@link Request}. Resolve the principal id from a header/cookie/token on it.
 */
export interface PrincipalContext {
    request: Request;
}

/**
 * The slice of Elysia's error context the error bridge reads: the thrown `error`. Elysia's real
 * context also carries `code` / `set` / `request`, but the StitchError bridge only needs `error`.
 */
export interface StitchEnvLike {
    error: unknown;
}

/**
 * The shape `.derive` adds to the context: a request-scoped `stitch` seam. Type a handler's context
 * with it (or read it loosely) — `({ stitch }) => stitch.stitch('/me')()`. It is a `type` (not an
 * `interface`) so it is assignable to Elysia's `Record<string, unknown>` derive constraint.
 */
export type StitchContext = {
    stitch: ElysiaRequestSeam;
};
