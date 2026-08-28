// StitchError → Hono HTTPException (mirrors @stitchapi/nest's exception-filter). A failed stitch
// rejects with a `StitchError` — a branded `Error` (`name === 'StitchError'`) carrying the upstream
// `status`. This bridges it to Hono's HTTP layer so a handler calling a stitch needs no per-route
// try/catch: register `stitchError.handler` as the app's `onError`, or map by hand with
// `stitchError.map`.
//
// The three functions below are the implementations; the barrel exports only the `stitchError`
// namespace that faces them. They stay plain module functions so this package's own call sites
// (and a bundler) reach one of them without pulling the other two in behind it.
//
// Edge-safe: imports only Hono's `HTTPException` (Fetch-based) — no `node:*`.
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** The error a stitch rejects with on failure: a branded `Error` carrying the upstream status. */
export type StitchErrorLike = Error & { status?: number };

/**
 * Guard half of {@link stitchError}; the namespace carries the contract. Internal — the
 * barrel exports the namespace, not this.
 *
 * True when `err` is the error a stitch rejects with on failure (`name === 'StitchError'`).
 */
export function isStitchError(err: unknown): err is StitchErrorLike {
    return err instanceof Error && err.name === 'StitchError';
}

export interface StitchErrorOptions {
    /**
     * The HTTP status for the mapped exception. Default `502 Bad Gateway` — **every** upstream
     * failure is reported as a gateway error, regardless of the upstream's own status. This is the
     * safe default: it never leaks an upstream's `401`/`404`/etc. semantics to your client. Override
     * per call — a fixed number, or a function for full control: propagate the upstream status with
     * `(e) => e.status ?? 502`, or remap specific codes (`(e) => (e.status === 429 ? 429 : 502)`).
     */
    status?: number | ((err: StitchErrorLike) => number);
    /**
     * The JSON body for a mapped failure. **Default: a generic, status-tied message**
     * (`{ error: 'Bad Gateway' }`) — the raw `err.message` is deliberately *not* echoed, because it
     * can disclose internal network topology (a transport failure reads like
     * `getaddrinfo ENOTFOUND payments.internal.corp`) or the upstream's status (`HTTP 401`) to an
     * untrusted client. Override to shape your own error envelope; pass `(e) => ({ error: e.message })`
     * to opt in to the raw message when the upstream messages are known to be safe to expose.
     * Receives the mapped status alongside the error.
     */
    body?: (err: StitchErrorLike, status: number) => unknown;
}

const BAD_GATEWAY = 502;

// A small map of the statuses this helper emits → their generic reason phrase, used for
// the default body so the raw error message is never echoed to the client.
const STATUS_TEXT: Record<number, string> = {
    500: 'Internal Server Error',
    502: 'Bad Gateway',
};

/**
 * Map half of {@link stitchError}; the namespace carries the contract. Internal — the
 * barrel exports the namespace, not this.
 *
 * Map a thrown stitch failure to a Hono {@link HTTPException}, or `undefined` when `err` is not a
 * Stitch error (so a caller can rethrow it untouched). The status is `502` by default; override it
 * via {@link StitchErrorOptions.status}.
 */
export function toHttpException(
    err: unknown,
    options: StitchErrorOptions = {},
): HTTPException | undefined {
    if (!isStitchError(err)) return undefined;
    const { status = BAD_GATEWAY } = options;
    const code = typeof status === 'function' ? status(err) : status;
    // Default body is a generic, status-tied message — the raw `err.message` is deliberately
    // withheld so an internal hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status
    // (`HTTP 401`) never reaches the client. Opt in via `options.body`. Carry it on the
    // exception's `res` so `getResponse()` renders THIS body (a bare `message` would be echoed
    // verbatim into the response body, which is exactly the leak we're closing).
    const body = options.body
        ? options.body(err, code)
        : { error: STATUS_TEXT[code] ?? 'Error' };
    return new HTTPException(code as ContentfulStatusCode, {
        res: Response.json(body, { status: code }),
    });
}

/**
 * Handler half of {@link stitchError}; the namespace carries the contract. Internal — the
 * barrel exports the namespace, not this.
 *
 * Build a Hono `onError` handler that converts a Stitch failure into an {@link HTTPException} (via
 * {@link toHttpException} — `502` by default) and lets Hono render it; an already-thrown
 * `HTTPException` is honoured as-is, and every other error is re-thrown unchanged for Hono's
 * default handling.
 */
export function stitchOnError(
    options: StitchErrorOptions = {},
): (err: Error, c: Context) => Response | Promise<Response> {
    return (err: Error, _c: Context) => {
        if (err instanceof HTTPException) return err.getResponse();
        const mapped = toHttpException(err, options);
        if (mapped) return mapped.getResponse();
        throw err;
    };
}

/**
 * The one name for "a stitch failed, turn it into HTTP" in this package — the guard, the
 * mapper and the `onError` handler as one namespace, so the same concept reads the same way
 * across every `@stitchapi/*` host adapter (ADR 0012; the export-surface analogue of the
 * `secrets` / `duration` folds in core). The verb lives at the call site rather than in three
 * verb-prefixed top-level names:
 *
 * - `stitchError.is(err)` narrows an unknown error to a {@link StitchErrorLike}.
 * - `stitchError.map(err, options?)` returns a Hono {@link HTTPException}, or `undefined` when
 *   `err` is not a stitch failure — so a caller can rethrow it untouched.
 * - `stitchError.handler(options?)` builds the `onError` handler that does both for you.
 *
 * ```ts
 * app.onError(stitchError.handler());
 * // configure the status (e.g. propagate the upstream status instead of 502):
 * //   app.onError(stitchError.handler({ status: (e) => e.status ?? 502 }))
 *
 * // …or map one error by hand:
 * //   throw stitchError.map(err) ?? err;
 * ```
 *
 * A facade, not a re-implementation: each member points at the module function above, so this
 * package's own `middleware`/plugin code keeps importing those directly and a bundler that
 * reaches one member does not weld the other two onto the consumer's path.
 */
export const stitchError = {
    is: isStitchError,
    map: toHttpException,
    handler: stitchOnError,
} as const;
