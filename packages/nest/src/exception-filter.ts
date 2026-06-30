// StitchError → Nest HttpException (ADR 0006 Decision 10 follow-up). A failed stitch
// throws a plain `Error` branded `name === 'StitchError'` carrying the upstream `status`
// (packages/core/src/stitch.ts). This bridges it to Nest's HTTP layer so a controller
// calling a stitch needs no per-handler try/catch and no hand-rolled @Catch filter.
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

/** True when `err` is the error a stitch throws on failure (`name === 'StitchError'`). */
export function isStitchError(err: unknown): err is StitchErrorLike {
    return err instanceof Error && err.name === 'StitchError';
}

export interface ToHttpExceptionOptions {
    /**
     * The HTTP status for the mapped exception. Default `502 Bad Gateway` — **every**
     * upstream failure is reported as a gateway error, regardless of the upstream's own
     * status. This is the safe default: it never leaks an upstream's `401`/`404`/etc.
     * semantics to your client. Override per call — a fixed number, or a function for
     * full control: propagate the upstream status with `(e) => e.status ?? 502`, or remap
     * specific codes (`(e) => (e.status === 429 ? 429 : 502)`).
     */
    status?: number | ((err: StitchErrorLike) => number);
}

/**
 * Map a thrown stitch failure to a Nest {@link HttpException}, or `undefined` when `err`
 * is not a {@link StitchErrorLike} (so a caller can rethrow it untouched). The status is
 * `502` by default; override it via {@link ToHttpExceptionOptions.status}.
 */
export function toHttpException(
    err: unknown,
    options: ToHttpExceptionOptions = {},
): HttpException | undefined {
    if (!isStitchError(err)) return undefined;
    const { status = HttpStatus.BAD_GATEWAY } = options;
    const code = typeof status === 'function' ? status(err) : status;
    return new HttpException(err.message || 'Upstream request failed', code);
}

/**
 * A global exception filter that converts a {@link StitchErrorLike} into an
 * {@link HttpException} (via {@link toHttpException} — `502` by default) and lets Nest
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
        private readonly options: ToHttpExceptionOptions = {},
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
