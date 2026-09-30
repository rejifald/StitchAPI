// StitchError → Elysia HTTP response (mirrors @stitchapi/hono's error.ts and the Fastify
// error-handler). A failed stitch rejects with a `StitchError` — a branded `Error`
// (`name === 'StitchError'`) carrying the upstream `status`. This bridges it to Elysia's HTTP
// layer so a route calling a stitch needs no per-route try/catch: the plugin registers
// `stitchError.handler` as the app's `.onError`, or map by hand with `stitchError.map`.
//
// The three functions below are the implementations; the barrel exports only the `stitchError`
// namespace that faces them. They stay plain module functions so `plugin.ts` (and a bundler)
// reaches one of them without pulling the other two in behind it.
//
// Web-standard: builds a plain `Response` (Fetch) — no `node:*`, so it runs under Bun, Node,
// Deno and the edge alike.
import type { ErrorContextLike } from './context';

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
     * The HTTP status for the mapped response. Default `502 Bad Gateway` — **every** upstream
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

function resolveStatus(
    err: StitchErrorLike,
    status: StitchErrorOptions['status'],
): number {
    if (status === undefined) return BAD_GATEWAY;
    return typeof status === 'function' ? status(err) : status;
}

/**
 * Map half of {@link stitchError}; the namespace carries the contract. Internal — the
 * barrel exports the namespace, not this.
 *
 * Map a thrown stitch failure to a JSON {@link Response}, or `undefined` when `err` is not a Stitch
 * error (so a caller can rethrow / fall through). The status is `502` by default; override it via
 * {@link StitchErrorOptions.status}.
 */
export function stitchErrorResponse(
    err: unknown,
    options: StitchErrorOptions = {},
): Response | undefined {
    if (!isStitchError(err)) return undefined;
    const status = resolveStatus(err, options.status);
    // Default body is a generic, status-tied message — the raw `err.message` is deliberately
    // withheld so an internal hostname (`getaddrinfo ENOTFOUND …`) or the upstream's status
    // (`HTTP 401`) never reaches the client. Opt in via `options.body`.
    const body = options.body
        ? options.body(err, status)
        : { error: STATUS_TEXT[status] ?? 'Error' };
    return Response.json(body, { status });
}

/**
 * Handler half of {@link stitchError}; the namespace carries the contract. Internal — the
 * barrel exports the namespace, not this.
 *
 * Build an Elysia `.onError` handler that converts a Stitch failure into a JSON {@link Response}
 * (via {@link stitchErrorResponse} — `502` by default). Any non-Stitch error is left for Elysia's
 * default handling by returning `undefined`.
 */
export function stitchOnError(
    options: StitchErrorOptions = {},
): (ctx: ErrorContextLike) => Response | undefined {
    // Elysia calls `.onError` with a rich context; we only read `.error`. Returning a value short-
    // circuits the response; returning `undefined` lets Elysia's default error handling proceed.
    return (ctx: ErrorContextLike): Response | undefined =>
        stitchErrorResponse(ctx.error, options);
}

/**
 * The one name for "a stitch failed, turn it into HTTP" in this package — the guard, the
 * mapper and the `.onError` handler as one namespace, so the same concept reads the same way
 * across every `@stitchapi/*` host adapter (ADR 0012; the export-surface analogue of the
 * `secrets` / `duration` folds in core). The verb lives at the call site rather than in three
 * verb-prefixed top-level names:
 *
 * - `stitchError.is(err)` narrows an unknown error to a {@link StitchErrorLike}.
 * - `stitchError.map(err, options?)` returns a JSON {@link Response}, or `undefined` when `err`
 *   is not a stitch failure — so a caller can rethrow / fall through.
 * - `stitchError.handler(options?)` builds the `.onError` handler that does both for you. The
 *   plugin registers it for you unless you pass `onError: false`; call this directly only to
 *   wire your own options.
 *
 * ```ts
 * app.onError(stitchError.handler());
 * // configure the status (e.g. propagate the upstream status instead of 502):
 * //   app.onError(stitchError.handler({ status: (e) => e.status ?? 502 }))
 *
 * // …or map one error by hand:
 * //   const res = stitchError.map(err) ?? new Response('teapot', { status: 418 });
 * ```
 *
 * A facade, not a re-implementation: each member points at the module function above, so
 * `plugin.ts` keeps importing those directly and a bundler that reaches one member does not
 * weld the other two onto the consumer's path.
 */
export const stitchError = {
    is: isStitchError,
    map: stitchErrorResponse,
    handler: stitchOnError,
} as const;
