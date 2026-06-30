// StitchError → Express error-handling middleware. A failed stitch throws a plain `Error` branded
// `name === 'StitchError'` carrying the upstream `status` (packages/core/src/stitch.ts). This adapts
// the Fastify error handler to Express's four-arg error middleware `(err, req, res, next)`, so a
// route handler calling a stitch needs no per-handler try/catch — register it last with
// `app.use(stitchErrorHandler())`.
import type {
    ErrorRequestHandler,
    NextFunction,
    Request,
    Response,
} from 'express';

/** The error a stitch throws on failure: a branded `Error` with the upstream status. */
export type StitchErrorLike = Error & { status?: number };

/** True when `err` is the error a stitch throws on failure (`name === 'StitchError'`). */
export function isStitchError(err: unknown): err is StitchErrorLike {
    return err instanceof Error && err.name === 'StitchError';
}

export interface StitchErrorHandlerOptions {
    /**
     * The HTTP status for a mapped stitch failure. Default `502 Bad Gateway` — **every** upstream
     * failure is reported as a gateway error, regardless of the upstream's own status. This is the
     * safe default: it never leaks an upstream's `401`/`404`/etc. semantics to your client. Override
     * — a fixed number, or a function for full control: propagate the upstream status with
     * `(e) => e.status ?? 502`, or remap specific codes (`(e) => (e.status === 429 ? 429 : 502)`).
     */
    status?: number | ((err: StitchErrorLike) => number);
    /**
     * The JSON body for a mapped stitch failure. Default: `{ error: <message> }`. Override to shape
     * your own error envelope. Receives the mapped status alongside the error.
     */
    body?: (err: StitchErrorLike, status: number) => unknown;
}

const DEFAULT_STATUS = 502;

function resolveStatus(
    err: StitchErrorLike,
    status: StitchErrorHandlerOptions['status'],
): number {
    if (status === undefined) return DEFAULT_STATUS;
    return typeof status === 'function' ? status(err) : status;
}

/**
 * Build an Express error-handling middleware that maps a {@link StitchErrorLike} to a JSON response
 * (status `502` by default; override via {@link StitchErrorHandlerOptions.status}) and **passes every
 * other error to `next(err)`** so Express's default handler — and any error middleware registered
 * after it — stays in charge. Register it after your routes:
 *
 * ```ts
 * app.use(stitchErrorHandler());
 * // configure the status (e.g. propagate the upstream status instead of 502):
 * //   app.use(stitchErrorHandler({ status: (e) => e.status ?? 502 }))
 * ```
 *
 * Note: an Express error middleware is matched by its 4-arg arity — keep all four parameters even
 * though `req` is unused here, or Express treats it as a normal middleware.
 */
export function stitchErrorHandler(
    options: StitchErrorHandlerOptions = {},
): ErrorRequestHandler {
    return (
        err: unknown,
        _req: Request,
        res: Response,
        next: NextFunction,
    ): void => {
        if (!isStitchError(err)) {
            // Not a stitch failure — hand it to Express's next error handler unchanged.
            next(err);
            return;
        }
        const status = resolveStatus(err, options.status);
        const body = options.body
            ? options.body(err, status)
            : { error: err.message || 'Upstream request failed' };
        res.status(status).json(body);
    };
}
