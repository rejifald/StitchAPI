import type { BatchProgress, DownloadId, ItemProgress } from './types';

import type { Clock } from 'stitchapi';

/**
 * Half-life of the throughput estimate, in ms: a reading from 2 s ago carries half the weight of one
 * taken now, from 4 s ago a quarter, and so on. Deliberately NOT a public option — a batch has no
 * business asking its caller to tune a smoothing constant, and any value in this range answers the
 * only question `eta` is asked ("how long from here?") better than an all-time average does. Short
 * enough that a stall shows up in the ETA within a couple of seconds; long enough that the ragged
 * chunk arrivals of a healthy stream do not make the number jitter.
 */
const RATE_HALF_LIFE_MS = 2_000;

/**
 * Rolls per-item byte progress up into a batch-wide {@link BatchProgress} with a throughput rate and
 * ETA. Reads time from an injected {@link Clock} so the rate/ETA math is deterministic under
 * `manualClock()` — nothing here touches the wall clock.
 *
 * `loaded` counts in-flight + fulfilled items; a failed or cancelled item's partial bytes are
 * discarded via {@link dropped} (they never contribute), so one dead/stalled stream can plateau its
 * own term but never corrupts the siblings' aggregate. `total` is the sum of known per-item totals and
 * goes `undefined` the moment any started item is indeterminate (chunked / no `Content-Length`).
 *
 * **The rate tracks RECENT throughput, not the batch's lifetime average** (#456). `throughput` was
 * once `loaded / (now - firstByte)`, which answers "how fast has this batch gone overall?" — a
 * question nobody asked. `eta` is a forecast, so it needs the rate the batch is moving at *now*: a
 * dead first minute kept inflating the ETA long after the transfer recovered, and a fast first
 * second kept it optimistic long after the transfer stalled. Each {@link snapshot} takes a reading
 * (bytes delivered since the previous one, over the time between them) and folds it into an
 * exponentially-weighted average whose decay is a function of the ELAPSED time, not of how many
 * readings were taken — so an extra `snapshot()` call cannot move the number, and irregular chunk
 * arrivals weigh exactly as much as the interval they cover.
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
    /** Clock time of the previous rate reading; seeded at the batch's first byte. */
    #readAt: number | undefined;
    /** Aggregate `loaded` at {@link #readAt} — the other half of the reading. */
    #readLoaded = 0;
    /** The decayed throughput estimate; `undefined` until the first reading with elapsed time. */
    #throughput: number | undefined;

    constructor(clock: Clock) {
        this.#clock = clock;
    }

    /** An active item reported a chunk. */
    item(id: DownloadId, p: ItemProgress): void {
        // The batch's first byte anchors the first reading at (now, 0 bytes), so a single-snapshot
        // batch still reports the plain since-first-byte average — there is nothing else to say yet.
        if (this.#readAt === undefined && p.loaded > 0)
            this.#readAt = this.#clock.now();
        this.#live.set(id, p);
        if (p.total === undefined) this.#anyIndeterminate = true;
    }

    /** An item fulfilled with `bytes` (and, when the server declared one, its `total`). */
    fulfilled(id: DownloadId, bytes: number, total: number | undefined): void {
        this.#live.delete(id);
        this.#doneBytes += bytes;
        if (total !== undefined) this.#doneTotal += total;
        else this.#anyIndeterminate = true;
        this.#completed += 1;
    }

    /** An item failed or was cancelled — its partial bytes are discarded from the aggregate. */
    dropped(id: DownloadId): void {
        // Those bytes leave `loaded`, so the rate baseline has to leave with them. Without this the
        // cliff would be charged against the interval as if the healthy siblings had gone backwards,
        // and their real progress in that interval would be swallowed. Discounting the baseline by
        // exactly what the drop removed makes a dropped item cost the rate precisely what a stalled
        // one does: nothing.
        const partial = this.#live.get(id)?.loaded ?? 0;
        this.#readLoaded = Math.max(0, this.#readLoaded - partial);
        this.#live.delete(id);
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

        this.#read(loaded);
        const throughput = this.#throughput;
        if (throughput !== undefined) {
            progress.throughput = throughput;
            if (totalKnown && throughput > 0) {
                const remaining = Math.max(0, total - loaded);
                progress.eta = (remaining / throughput) * 1000;
            }
        }
        return progress;
    }

    /** Fold one throughput reading — bytes since the last one, over the time since it — into the estimate. */
    #read(loaded: number): void {
        if (this.#readAt === undefined) return; // no bytes yet: no rate to speak of
        // Belt and braces for any other way the aggregate can shrink (a `fulfilled` whose final byte
        // count undercuts the last partial it reported). Never let a shrink read as negative throughput.
        if (loaded < this.#readLoaded) this.#readLoaded = loaded;

        const now = this.#clock.now();
        const elapsedMs = now - this.#readAt;
        // Same instant: keep the bytes for the next interval rather than dividing by zero or, worse,
        // banking them at an infinite rate. This is also what makes repeated `snapshot()` calls at one
        // clock tick idempotent.
        if (elapsedMs <= 0) return;

        const reading = ((loaded - this.#readLoaded) / elapsedMs) * 1000;
        // Decay by elapsed time, so the weight of the previous estimate depends on how long ago it was
        // taken and not on the sampling cadence: half-life `RATE_HALF_LIFE_MS`, i.e. an interval of one
        // half-life gives the new reading half the say.
        const weight = 1 - 2 ** (-elapsedMs / RATE_HALF_LIFE_MS);
        this.#throughput =
            this.#throughput === undefined
                ? reading
                : this.#throughput + weight * (reading - this.#throughput);
        this.#readAt = now;
        this.#readLoaded = loaded;
    }
}
