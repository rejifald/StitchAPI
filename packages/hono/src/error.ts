// StitchError → Hono HTTPException (mirrors @stitchapi/nest's exception-filter). A failed stitch
// rejects with a `StitchError` — a branded `Error` (`name === 'StitchError'`) carrying the upstream
// `status`. This bridges it to Hono's HTTP layer so a handler calling a stitch needs no per-route
// try/catch: register `stitchOnError` as the app's `onError`, or map by hand with `stitchError`.
//
// Edge-safe: imports only Hono's `HTTPException` (Fetch-based) — no `node:*`.
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** The error a stitch rejects with on failure: a branded `Error` carrying the upstream status. */
export type StitchErrorLike = Error & { status?: number };

/** True when `err` is the error a stitch rejects with on failure (`name === 'StitchError'`). */
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
}

const BAD_GATEWAY = 502;

/**
 * Map a thrown stitch failure to a Hono {@link HTTPException}, or `undefined` when `err` is not a
 * Stitch error (so a caller can rethrow it untouched). The status is `502` by default; override it
 * via {@link StitchErrorOptions.status}.
 *
 * ```ts
 * try {
 *   return c.json(await c.get('stitch').stitch('/users')());
 * } catch (err) {
 *   throw stitchError(err) ?? err; // map a Stitch failure, rethrow anything else
 * }
 * ```
 */
export function stitchError(
    err: unknown,
    options: StitchErrorOptions = {},
): HTTPException | undefined {
    if (!isStitchError(err)) return undefined;
    const { status = BAD_GATEWAY } = options;
    const code = typeof status === 'function' ? status(err) : status;
    return new HTTPException(code as ContentfulStatusCode, {
        message: err.message || 'Upstream request failed',
    });
}

/**
 * Build a Hono `onError` handler that converts a Stitch failure into an {@link HTTPException} (via
 * {@link stitchError} — `502` by default) and lets Hono render it; an already-thrown
 * `HTTPException` is honoured as-is, and every other error is re-thrown unchanged for Hono's
 * default handling. Register it once so handlers calling stitches need no try/catch:
 *
 * ```ts
 * app.onError(stitchOnError());
 * // configure the status (e.g. propagate the upstream status instead of 502):
 * //   app.onError(stitchOnError({ status: (e) => e.status ?? 502 }))
 * ```
 */
export function stitchOnError(
    options: StitchErrorOptions = {},
): (err: Error, c: Context) => Response | Promise<Response> {
    return (err: Error, _c: Context) => {
        if (err instanceof HTTPException) return err.getResponse();
        const mapped = stitchError(err, options);
        if (mapped) return mapped.getResponse();
        throw err;
    };
}
