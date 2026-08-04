/**
 * Aborted into an item when a caller cancels it (`cancel`). The batch surfaces the item
 * as `status: 'cancelled'` — cancellation is not a failure, so it carries no classification.
 */
export class DownloadCancelledError extends Error {
    constructor(message = 'download cancelled') {
        super(message);
        this.name = 'DownloadCancelledError';
    }
}

/**
 * Aborted into an item when the idle / forward-progress timeout fires — no byte-chunk arrived within
 * `idleTimeout`. Distinct from a wall-clock timeout: a slow-but-progressing stream keeps resetting the
 * timer and never trips it; only a genuinely stalled stream does. Surfaces as a retryable rejection
 * with code `IDLE_TIMEOUT`.
 */
export class DownloadIdleTimeoutError extends Error {
    readonly idle: number;
    constructor(idle: number) {
        super(`download stalled: no forward progress for ${idle}ms`);
        this.name = 'DownloadIdleTimeoutError';
        this.idle = idle;
    }
}
