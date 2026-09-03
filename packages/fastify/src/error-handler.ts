// StitchError → Fastify HTTP response. A failed stitch throws a plain `Error` branded
// `name === 'StitchError'` carrying the upstream `status` (packages/core/src/stitch.ts). This
// adapts the Nest exception filter (`packages/nest/src/exception-filter.ts`) to a Fastify
// `setErrorHandler`-compatible function, so a route handler calling a stitch needs no
// per-handler try/catch.
//
// The two functions below are the implementations; the barrel exports only the `stitchError`
// namespace that faces them. They stay plain module functions so `plugin.ts` (and a bundler)
// reaches one of them without pulling the other in behind it.
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/** The error a stitch throws on failure: a branded `Error` with the upstream status. */
export type StitchErrorLike = Error & { status?: number };

/**
 * Guard half of {@link stitchError}; the namespace carries the contract. Internal — the
 * barrel exports the namespace, not this.
 *
 * True when `err` is the error a stitch throws on failure (`name === 'StitchError'`).
 */
export function isStitchError(err: unknown): err is StitchErrorLike {
    return err instanceof Error && err.name === 'StitchError';
}

export interface StitchErrorOptions {
    /**
     * The HTTP status for a mapped stitch failure. Default `502 Bad Gateway` — **every**
     * upstream failure is reported as a gateway error, regardless of the upstream's own
     * status. This is the safe default: it never leaks an upstream's `401`/`404`/etc.
     * semantics to your client. Override per registration — a fixed number, or a function
     * for full control: propagate the upstream status with `(e) => e.status ?? 502`, or
     * remap specific codes (`(e) => (e.status === 429 ? 429 : 502)`).
     */
    status?: number | ((err: StitchErrorLike) => number);
    /**
     * The JSON body for a mapped stitch failure. **Default: a generic, status-tied message**
     * (`{ error: 'Bad Gateway' }`) — the raw `err.message` is deliberately *not* echoed,
     * because it can disclose internal network topology (a transport failure reads like
     * `getaddrinfo ENOTFOUND payments.internal.corp`) or the upstream's status (`HTTP 401`)
     * to an untrusted client. Override to shape your own error envelope; pass
     * `(e) => ({ error: e.message })` to opt in to the raw message when the upstream
     * messages are known to be safe to expose. Receives the mapped status alongside the error.
     */
    body?: (err: StitchErrorLike, status: number) => unknown;
}

const DEFAULT_STATUS = 502;

// A small map of the statuses this handler emits → their generic reason phrase, used for
// the default body so the raw error message is never echoed to the client.
const STATUS_TEXT: Record<number, string> = {
    500: 'Internal Server Error',
    502: 'Bad Gateway',
};

function resolveStatus(
    err: StitchErrorLike,
    status: StitchErrorOptions['status'],
): number {
    if (status === undefined) return DEFAULT_STATUS;
    return typeof status === 'function' ? status(err) : status;
}

/**
 * Handler half of {@link stitchError}; the namespace carries the contract. Internal — the
 * barrel exports the namespace, not this.
 *
 * Build a `setErrorHandler`-compatible function that maps a {@link StitchErrorLike} to an HTTP
 * response (status `502` by default; override via {@link StitchErrorOptions.status})
 * and **rethrows every other error** so Fastify's default handling — and any error handler
 * registered in an outer scope — stays in charge.
 */
export function stitchErrorHandler(
    options: StitchErrorOptions = {},
): (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => void {
    return (error, _request, reply): void => {
        if (!isStitchError(error)) {
            // Not a stitch failure — rethrow so Fastify's default handler (or an outer
            // setErrorHandler) renders it unchanged.
            throw error;
        }
        const status = resolveStatus(error, options.status);
        // Default body is a generic, status-tied message — the raw `error.message` is
        // deliberately withheld so an internal hostname (`getaddrinfo ENOTFOUND …`) or the
        // upstream's status (`HTTP 401`) never reaches the client. Opt in via `options.body`.
        const body = options.body
            ? options.body(error, status)
            : { error: STATUS_TEXT[status] ?? 'Error' };
        void reply.status(status).send(body);
    };
}

/**
 * The one name for "a stitch failed, turn it into HTTP" in this package — the guard and the
 * `setErrorHandler` function as one namespace, so the same concept reads the same way across
 * every `@stitchapi/*` host adapter (ADR 0012; the export-surface analogue of the `secrets` /
 * `duration` folds in core). The verb lives at the call site rather than in two verb-prefixed
 * top-level names:
 *
 * - `stitchError.is(err)` narrows an unknown error to a {@link StitchErrorLike}.
 * - `stitchError.handler(options?)` builds the `setErrorHandler`-compatible function. The
 *   plugin registers it for you unless `errorHandler` is `false`; call this directly only to
 *   register it yourself with custom options.
 *
 * ```ts
 * app.setErrorHandler(stitchError.handler({ status: (e) => e.status ?? 502 }));
 * ```
 *
 * The plugin **option** is still spelled `errorHandler`, after Fastify's own `setErrorHandler`
 * — CONTRACT.md P18's mirror clause, which binds the framework-hook slot and is untouched by
 * this namespace.
 *
 * **No `.map` here, deliberately.** On the hosts that have one (hono, elysia, next, nest),
 * `stitchError.map(err)` returns the mapped artifact as a *value* — an `HTTPException`, a
 * `Response`. Fastify has no such value: the handler writes a status and a body onto the
 * mutable `reply` and returns nothing, so there is nothing to hand back. A `map` here would be
 * invented surface, not the same member under the same name — and a member that means
 * something different per package is the drift this namespace exists to end.
 *
 * A facade, not a re-implementation: each member points at the module function above, so
 * `plugin.ts` keeps importing those directly and a bundler that reaches one member does not
 * weld the other onto the consumer's path.
 */
export const stitchError = {
    is: isStitchError,
    handler: stitchErrorHandler,
} as const;
