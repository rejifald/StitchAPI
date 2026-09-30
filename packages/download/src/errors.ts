import { StitchError } from 'stitchapi';

/**
 * Aborted into an item when a caller cancels it (`cancel`). The batch surfaces the item as
 * `status: 'cancelled'` — cancellation is not a failure, so that arm carries no `error` and no
 * classification. The instance still reaches a caller who asked for it: it is the abort reason on
 * the item's signal, so a `hooks.onError` supplied under `defaults` (or on the item) receives THIS
 * instance as `ctx.error`, which is how you tell a deliberate cancel from a transport fault.
 *
 * A **subclass of {@link StitchError}** (CONTRACT.md P10): `status`/`attempts`/`body`/`url` are
 * inherited rather than re-declared, so a handler can branch on it exactly like any other thrown
 * StitchAPI error. `attempts` is the base default `0` — the batch raises this outside the engine's
 * attempt loop, so there is no attempt count to report.
 *
 * ⚠️ Because it IS a `StitchError`, an `instanceof` chain that tests both **must test this class
 * first** — a leading `instanceof StitchError` arm swallows it.
 */
export class DownloadCancelledError extends StitchError {
    constructor(message = 'download cancelled') {
        super(message);
        this.name = 'DownloadCancelledError';
    }
}

/**
 * Aborted into an item when the forward-progress window fires — no byte-chunk arrived within
 * `BatchOptions.idle`. Distinct from a wall-clock timeout: a slow-but-progressing stream keeps
 * resetting the timer and never trips it; only a genuinely stalled stream does. Surfaces as a
 * retryable rejection with code `IDLE_TIMEOUT`.
 *
 * A **subclass of {@link StitchError}** (CONTRACT.md P10), and the settled item carries THIS
 * instance as `ItemResult.error` — not a flattened base `StitchError` with the real one buried on
 * `.cause`. P10's "no field is reachable only through `.cause`" is what that buys: `err.idle` is
 * readable on the value the consumer actually receives. `attempts` is the base default `0` — the
 * batch raises this outside the engine's attempt loop, so there is no attempt count to report.
 *
 * ⚠️ Because it IS a `StitchError`, an `instanceof` chain that tests both **must test this class
 * first** — a leading `instanceof StitchError` arm swallows it.
 */
export class DownloadIdleTimeoutError extends StitchError {
    /** The window that elapsed with no forward progress, in ms (P17: emitted durations are raw ms). */
    readonly idle: number;
    constructor(idle: number) {
        super(`download stalled: no forward progress for ${idle}ms`);
        this.name = 'DownloadIdleTimeoutError';
        this.idle = idle;
    }
}
