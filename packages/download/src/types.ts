import type { Clock, StitchConfig, StitchError } from 'stitchapi';
import type { DownloadResult } from 'stitchapi/download';

export type { DownloadResult };

/** Stable identity for an item — correlates progress, cancellation, results, and dedupe. */
export type DownloadId = string | number;

/**
 * One item in a batch. Either a URL string (shorthand for `{ url }`), or a partial `download()`
 * config with an optional stable `id`. When `id` is omitted it defaults to the item's URL, falling
 * back to the enqueue index if that URL is already used — so give colliding URLs explicit ids if you
 * need to tell them apart.
 */
export type DownloadRequest =
    | string
    | (Partial<StitchConfig> & { id?: DownloadId });

/** Per-item byte progress. `total` is present only when the server declared a `Content-Length`. */
export interface ItemProgress {
    loaded: number;
    total?: number;
}

/** Aggregate progress across the whole batch. */
export interface BatchProgress {
    /**
     * Bytes downloaded so far — summed across in-flight + fulfilled items. A failed or cancelled
     * item's partial bytes are discarded (they never contribute), so one dead stream can't inflate
     * the aggregate.
     */
    loaded: number;
    /**
     * Sum of known per-item totals; `undefined` while any *started* item is indeterminate (chunked /
     * no `Content-Length`). Firms up as items are admitted — a queued item's size is unknown until
     * it starts.
     */
    total?: number;
    /** Items that have settled — fulfilled + rejected + cancelled. */
    completed: number;
    /** Total items in the batch. */
    count: number;
    /** Smoothed throughput in bytes/sec since the first byte; `undefined` before any bytes arrive. */
    ratePerSec?: number;
    /** Estimated time to completion, in ms; `undefined` when `total` is unknown or the rate is zero. */
    eta?: number;
}

/** The phase an item is in, for {@link BatchSnapshot}. */
export type ItemPhase = 'queued' | 'active' | 'settled';

/** How an item finished. */
export type ItemStatus = 'fulfilled' | 'rejected' | 'cancelled';

/**
 * A settled item. Shaped like `Promise.allSettled`, plus a `cancelled` arm, and — on a rejection —
 * a classification (`retryable` + a best-effort machine `code`) recovered from the transport error.
 */
export type ItemResult<T = DownloadResult> =
    | { id: DownloadId; status: 'fulfilled'; value: T }
    | {
          id: DownloadId;
          status: 'rejected';
          reason: StitchError;
          /** Whether a retry might plausibly succeed: transport faults, 5xx/429/408, idle-timeout — vs terminal 4xx. */
          retryable: boolean;
          /** Best-effort code: an undici transport code (`UND_ERR_SOCKET`…), `HTTP_<status>`, `IDLE_TIMEOUT`, or `TIMEOUT`. */
          code?: string;
      }
    | { id: DownloadId; status: 'cancelled' };

/** Options shared by {@link downloadAll} and {@link DownloadManager}. */
export interface BatchOptions {
    /** Max downloads running concurrently. Default 4. Enforced by the batch's own FIFO scheduler. */
    concurrency?: number;
    /** Config merged UNDER every item (the item's own fields win). e.g. `{ baseUrl, retry, throttle }`. */
    defaults?: Partial<StitchConfig>;
    /**
     * Forward-progress timeout in ms: abort an item if no `onProgress` byte-chunk arrives within this
     * window. Resets on every chunk, so a slow-but-alive stream survives while a dead stall is cut.
     * Distinct from `download()`'s wall-clock `timeout` (which fires on total elapsed regardless of
     * progress). Off when unset.
     */
    idleTimeout?: number;
    /**
     * Reuse a single in-flight download for items that share a key (their `id`, else URL) instead of
     * fetching independently. Default `false` — every item is its own request (predictable, no
     * cross-item coupling). With dedupe on, followers share the leader's result and progress; a
     * follower cannot be cancelled independently of the shared fetch.
     */
    dedupe?: boolean;
    /** Aggregate progress across all items (summed bytes + ETA). Fires on every per-item chunk. */
    onProgress?: (progress: BatchProgress) => void;
    /** Per-item progress. */
    onItemProgress?: (id: DownloadId, progress: ItemProgress) => void;
    /** Fires when an item is admitted (leaves the queue for a slot) — in FIFO order. */
    onItemStart?: (id: DownloadId) => void;
    /** Fires as each item settles. */
    onItemSettled?: (result: ItemResult) => void;
    /** External cancel-all: aborting this signal cancels the whole batch. */
    signal?: AbortSignal;
    /** Time seam (ADR 0010) for the idle-timer + ETA math. Defaults to `systemClock`; tests pass `manualClock()`. */
    clock?: Clock;
}

/** A live snapshot of a batch's per-item phases + aggregate progress. */
export interface BatchSnapshot {
    progress: BatchProgress;
    items: { id: DownloadId; phase: ItemPhase; status?: ItemStatus }[];
}

/** A handle to one enqueued item (returned by {@link DownloadManager.add}). */
export interface DownloadHandle {
    readonly id: DownloadId;
    /** Resolves when this item settles. Never rejects — read `.status`. */
    readonly done: Promise<ItemResult>;
    /** Cancel just this item. */
    cancel(): void;
}

/**
 * The handle returned by {@link downloadAll}. Awaitable — resolves to the per-item results in enqueue
 * order and NEVER rejects (per-item settling) — plus batch-wide control.
 */
export interface DownloadBatch extends PromiseLike<ItemResult[]> {
    /** The per-item results, in enqueue order. Same as awaiting the batch. */
    readonly done: Promise<ItemResult[]>;
    /** Cancel one item — in-flight aborts (its slot goes to the next queued item); a queued item just drops. */
    cancel(id: DownloadId): void;
    /** Cancel every item — in-flight abort, queue drains. */
    cancelAll(): void;
    /** A live snapshot of per-item phase + aggregate progress. */
    snapshot(): BatchSnapshot;
}
