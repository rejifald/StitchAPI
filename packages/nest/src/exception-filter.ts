// StitchError → Nest HttpException (ADR 0006 Decision 10 follow-up). A failed stitch
// throws a plain `Error` branded `name === 'StitchError'` carrying the upstream `status`
// (packages/core/src/stitch.ts). This bridges it to Nest's HTTP layer so a controller
// calling a stitch needs no per-handler try/catch and no hand-rolled @Catch filter.
//
// The two functions below are the implementations; the barrel exports only the `stitchError`
// namespace that faces them (the filter class stays a top-level class — it is DI-registered,
// which is the Nest idiom ADR 0012 rule 1 blesses). They stay plain module functions so the
// filter reaches the mapper without welding the guard onto a consumer that never calls it.
import {
    type ArgumentsHost,
    Catch,
    HttpException,
    type HttpServer,
    HttpStatus,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';

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

/** The safe, fixed message the mapped exception carries by default. */
const SAFE_MESSAGE = 'Upstream request failed';

export interface StitchErrorOptions {
    /**
     * The HTTP status for the mapped exception. Default `502 Bad Gateway` — **every**
     * upstream failure is reported as a gateway error, regardless of the upstream's own
     * status. This is the safe default: it never leaks an upstream's `401`/`404`/etc.
     * semantics to your client. Override per call — a fixed number, or a function for
     * full control: propagate the upstream status with `(e) => e.status ?? 502`, or remap
     * specific codes (`(e) => (e.status === 429 ? 429 : 502)`).
     */
    status?: number | ((err: StitchErrorLike) => number);
    /**
     * The response body for a mapped failure. **Default: Nest's rendering of a fixed, generic
     * message** (`{ statusCode, message: 'Upstream request failed' }`) — the raw `err.message`
     * is deliberately *not* echoed, because it can disclose internal network topology (a
     * transport failure reads like `getaddrinfo ENOTFOUND payments.internal.corp`) or the
     * upstream's status (`HTTP 401`) to an untrusted client. Override to shape your own error
     * envelope; pass `(e) => ({ error: e.message })` to opt in to the raw message when the
     * upstream messages are known to be safe to expose. Receives the mapped status alongside
     * the error. The original error is always attached as the exception's `cause` for
     * server-side logging.
     */
    body?: (err: StitchErrorLike, status: number) => unknown;
}

/**
 * Map half of {@link stitchError}; the namespace carries the contract. Internal — the
 * barrel exports the namespace, not this.
 *
 * Map a thrown stitch failure to a Nest {@link HttpException}, or `undefined` when `err`
 * is not a {@link StitchErrorLike} (so a caller can rethrow it untouched). The status is
 * `502` by default; override it via {@link StitchErrorOptions.status}.
 *
 * The client-facing body defaults to Nest's rendering of a fixed
 * `'Upstream request failed'` — the raw `err.message` is **not** forwarded, since it can
 * leak internal hostnames or the upstream's status to an untrusted client. The original
 * error is attached as the exception's `cause` for server-side logging. Shape your own
 * envelope (or opt in to the raw message) with {@link StitchErrorOptions.body}.
 */
export function toHttpException(
    err: unknown,
    options: StitchErrorOptions = {},
): HttpException | undefined {
    if (!isStitchError(err)) return undefined;
    const { status = HttpStatus.BAD_GATEWAY } = options;
    const code = typeof status === 'function' ? status(err) : status;
    // The default body is Nest's own rendering of the safe, fixed message — the raw
    // `err.message` is deliberately withheld so an internal hostname (`getaddrinfo
    // ENOTFOUND …`) or the upstream's status (`HTTP 401`) never reaches the client.
    // Opt in / shape the envelope via `options.body`.
    const response = options.body
        ? (options.body(err, code) as string | Record<string, unknown>)
        : SAFE_MESSAGE;
    return new HttpException(response, code, { cause: err });
}

/**
 * The one name for "a stitch failed, turn it into HTTP" in this package — the guard and the
 * mapper as one namespace, so the same concept reads the same way across every `@stitchapi/*`
 * host adapter (ADR 0012; the export-surface analogue of the `secrets` / `duration` folds in
 * core). The verb lives at the call site rather than in two verb-prefixed top-level names:
 *
 * - `stitchError.is(err)` narrows an unknown error to a {@link StitchErrorLike}.
 * - `stitchError.map(err, options?)` returns a Nest {@link HttpException}, or `undefined` when
 *   `err` is not a stitch failure — so a caller can rethrow it untouched.
 *
 * ```ts
 * // inside a hand-rolled filter or an interceptor:
 * throw stitchError.map(err, { status: (e) => e.status ?? 502 }) ?? err;
 * ```
 *
 * **No `.handler` here, deliberately.** The other hosts expose one because their error hook
 * takes a plain function; Nest's takes a filter **instance**, resolved by the DI container and
 * registered with `useGlobalFilters` or an `APP_FILTER` provider. So the handler stays the
 * top-level {@link StitchExceptionFilter} class — the Nest idiom, and what ADR 0012 rule 1
 * blesses for a host adapter's primary surface. Folding a `useClass`-able class behind a
 * namespace member would break `{ provide: APP_FILTER, useClass: … }` for no naming gain.
 *
 * A facade, not a re-implementation: each member points at the module function above, so the
 * filter keeps calling those directly and a bundler that reaches one member does not weld the
 * other onto the consumer's path.
 */
export const stitchError = {
    is: isStitchError,
    map: toHttpException,
} as const;

/**
 * A global exception filter that converts a {@link StitchErrorLike} into an
 * {@link HttpException} (via {@link stitchError}`.map` — `502` by default) and lets Nest
 * render it; every other exception is delegated to Nest's default handling, unchanged.
 * Register it globally so controllers calling stitches need no try/catch:
 *
 * ```ts
 * // main.ts — like any BaseExceptionFilter subclass, it needs the HTTP adapter:
 * app.useGlobalFilters(new StitchExceptionFilter(app.getHttpAdapter()));
 * // configure the status (e.g. propagate the upstream status instead of 502):
 * //   new StitchExceptionFilter(app.getHttpAdapter(), { status: (e) => e.status ?? 502 })
 * // …or as a provider (the adapter is resolved for you):
 * //   { provide: APP_FILTER, useClass: StitchExceptionFilter }
 * ```
 */
@Catch()
export class StitchExceptionFilter extends BaseExceptionFilter {
    constructor(
        applicationRef?: HttpServer,
        private readonly options: StitchErrorOptions = {},
    ) {
        super(applicationRef);
    }

    override catch(exception: unknown, host: ArgumentsHost): void {
        super.catch(
            toHttpException(exception, this.options) ?? exception,
            host,
        );
    }
}
