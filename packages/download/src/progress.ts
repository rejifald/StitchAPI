import type { BatchProgress, DownloadId, ItemProgress } from './types';

import type { Clock } from 'stitchapi';

/**
 * Rolls per-item byte progress up into a batch-wide {@link BatchProgress} with a throughput rate and
 * ETA. Reads time from an injected {@link Clock} so the rate/ETA math is deterministic under
 * `manualClock()`.
 *
 * `loaded` counts in-flight + fulfilled items; a failed or cancelled item's partial bytes are
 * discarded via {@link dropped} (they never contribute), so one dead/stalled stream can plateau its
 * own term but never corrupts the siblings' aggregate. `total` is the sum of known per-item totals and
 * goes `undefined` the moment any started item is indeterminate (chunked / no `Content-Length`).
 */
export class ProgressAggregator {
    readonly #clock: Clock;
    /** Live per-item progress for the currently-active items. */
    readonly #live = new Map<DownloadId, ItemProgress>();
    /** Sum of fulfilled items' final byte counts. */
    #doneBytes = 0;
    /** Sum of fulfilled items' known totals. */
    #doneTotal = 0;
    /** Settled items (any status). */
    #completed = 0;
    /** A started item reported no total (chunked) — the aggregate total is then indeterminate. */
    #anyIndeterminate = false;
    /** Clock time of the first byte across the batch — the ETA baseline. */
    #firstByteAt: number | undefined;

    constructor(clock: Clock) {
        this.#clock = clock;
    }

    /** An active item reported a chunk. */
    item(id: DownloadId, p: ItemProgress): void {
        if (this.#firstByteAt === undefined && p.loaded > 0)
            this.#firstByteAt = this.#clock.now();
        this.#live.set(id, p);
        if (p.total === undefined) this.#anyIndeterminate = true;
    }

    /** An item fulfilled with `finalBytes` (and, when the server declared one, its `total`). */
    fulfilled(
        id: DownloadId,
        finalBytes: number,
        total: number | undefined,
    ): void {
        this.#live.delete(id);
        this.#doneBytes += finalBytes;
        if (total !== undefined) this.#doneTotal += total;
        else this.#anyIndeterminate = true;
        this.#completed += 1;
    }

    /** An item failed or was cancelled — its partial bytes are discarded from the aggregate. */
    dropped(_id: DownloadId): void {
        this.#live.delete(_id);
        this.#completed += 1;
    }

    /** Build the aggregate for `count` total items. */
    snapshot(count: number): BatchProgress {
        let loaded = this.#doneBytes;
        let total = this.#doneTotal;
        let totalKnown = !this.#anyIndeterminate;
        for (const p of this.#live.values()) {
            loaded += p.loaded;
            if (p.total !== undefined) total += p.total;
            else totalKnown = false;
        }

        const progress: BatchProgress = {
            loaded,
            completed: this.#completed,
            count,
        };
        if (totalKnown) progress.total = total;

        if (this.#firstByteAt !== undefined) {
            const elapsedMs = this.#clock.now() - this.#firstByteAt;
            if (elapsedMs > 0) {
                const throughput = (loaded / elapsedMs) * 1000;
                progress.throughput = throughput;
                if (totalKnown && throughput > 0) {
                    const remaining = Math.max(0, total - loaded);
                    progress.eta = (remaining / throughput) * 1000;
                }
            }
        }
        return progress;
    }
}
