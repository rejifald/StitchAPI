// StitchError → Elysia HTTP response (mirrors @stitchapi/hono's error.ts and the Fastify
// error-handler). A failed stitch rejects with a `StitchError` — a branded `Error`
// (`name === 'StitchError'`) carrying the upstream `status`. This bridges it to Elysia's HTTP
// layer so a route calling a stitch needs no per-route try/catch: the plugin registers
// `stitchOnError` as the app's `.onError`, or map by hand with `stitchErrorResponse`.
//
// Web-standard: builds a plain `Response` (Fetch) — no `node:*`, so it runs under Bun, Node,
// Deno and the edge alike.
import type { StitchEnvLike } from './context';

/** The error a stitch rejects with on failure: a branded `Error` carrying the upstream status. */
export type StitchErrorLike = Error & { status?: number };

/** True when `err` is the error a stitch rejects with on failure (`name === 'StitchError'`). */
export function isStitchError(err: unknown): err is StitchErrorLike {
    return err instanceof Error && err.name === 'StitchError';
}

export interface StitchErrorOptions {
    /**
     * The HTTP status for the mapped response. Default `502 Bad Gateway` — **every** upstream
     * failure is reported as a gateway error, regardless of the upstream's own status. This is the
     * safe default: it never leaks an upstream's `401`/`404`/etc. semantics to your client. Override
     * per call — a fixed number, or a function for full control: propagate the upstream status with
     * `(e) => e.status ?? 502`, or remap specific codes (`(e) => (e.status === 429 ? 429 : 502)`).
     */
    status?: number | ((err: StitchErrorLike) => number);
    /**
     * The JSON body for a mapped failure. Default: `{ error: <message> }`. Override to shape your
     * own error envelope. Receives the mapped status alongside the error.
     */
    body?: (err: StitchErrorLike, status: number) => unknown;
}

const BAD_GATEWAY = 502;

function resolveStatus(
    err: StitchErrorLike,
    status: StitchErrorOptions['status'],
): number {
    if (status === undefined) return BAD_GATEWAY;
    return typeof status === 'function' ? status(err) : status;
}

/**
 * Map a thrown stitch failure to a JSON {@link Response}, or `undefined` when `err` is not a Stitch
 * error (so a caller can rethrow / fall through). The status is `502` by default; override it via
 * {@link StitchErrorOptions.status}.
 *
 * ```ts
 * app.get('/users', ({ stitch }) => stitch.stitch('/users')()); // throws map via the plugin
 * // or by hand:
 * const res = stitchErrorResponse(err) ?? new Response('teapot', { status: 418 });
 * ```
 */
export function stitchErrorResponse(
    err: unknown,
    options: StitchErrorOptions = {},
): Response | undefined {
    if (!isStitchError(err)) return undefined;
    const status = resolveStatus(err, options.status);
    const body = options.body
        ? options.body(err, status)
        : { error: err.message || 'Upstream request failed' };
    return Response.json(body, { status });
}

/**
 * Build an Elysia `.onError` handler that converts a Stitch failure into a JSON {@link Response}
 * (via {@link stitchErrorResponse} — `502` by default). Any non-Stitch error is left for Elysia's
 * default handling by returning `undefined`. Register it once so routes calling stitches need no
 * try/catch:
 *
 * ```ts
 * app.onError(stitchOnError());
 * // configure the status (e.g. propagate the upstream status instead of 502):
 * //   app.onError(stitchOnError({ status: (e) => e.status ?? 502 }))
 * ```
 *
 * The plugin registers this for you; call it directly only to register custom options yourself.
 */
export function stitchOnError(
    options: StitchErrorOptions = {},
): (ctx: StitchEnvLike) => Response | undefined {
    // Elysia calls `.onError` with a rich context; we only read `.error`. Returning a value short-
    // circuits the response; returning `undefined` lets Elysia's default error handling proceed.
    return (ctx: StitchEnvLike): Response | undefined =>
        stitchErrorResponse(ctx.error, options);
}
