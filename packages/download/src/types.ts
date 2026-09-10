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
    string | (Partial<StitchConfig> & { id?: DownloadId });

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
    /**
     * **Recent** throughput in bytes/sec — an exponentially-decayed average of the batch's last few
     * seconds, not its lifetime average. `undefined` before any bytes arrive. A stall pulls it down
     * within a couple of seconds and a recovery pulls it back up just as fast, which is what makes
     * {@link eta} a forecast rather than a report on how the batch has gone so far.
     */
    throughput?: number;
    /**
     * Estimated time to completion, in ms, at {@link throughput}; `undefined` when `total` is unknown
     * or the rate has decayed to zero. It is a projection of the CURRENT rate, so it moves — a batch
     * that stalls watches its ETA climb.
     */
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
     * Forward-progress window — `10_000`, `'10s'`: abort an item if no `onProgress` byte-chunk
     * arrives within it. Resets on every chunk, so a slow-but-alive stream survives while a dead
     * stall is cut. Off when unset.
     *
     * One word, and deliberately not spelled `timeout` (CONTRACT.md P1/P2): a stitch's `timeout` is
     * WALL-CLOCK — `{ total, perAttempt }` fire on elapsed time regardless of progress — and it is
     * configurable right here, under `defaults`. Two different clocks must not share one word, so
     * this one is named for what it measures (a stream that has gone idle), not for what it does.
     * `number | string`, parsed by core's shared `duration.parse` like every other authored duration
     * (P17).
     */
    idle?: number | string;
    /**
     * Reuse a single in-flight download for items that resolve to the same request instead of
     * fetching independently. Default `false` — every item is its own request (predictable, no
     * cross-item coupling).
     *
     * The key is an item's own `id` when it has one — naming two items alike is a deliberate claim
     * that they are one download — and otherwise the RESOLVED target: `defaults` merged under the
     * item, then `baseUrl` + `path` (or a whole `url`), with the query string sorted. So two
     * `{ path: '/x' }` items under one `baseUrl` are one fetch, and so are `?a=1&b=2` and `?b=2&a=1`.
     * A thunked `baseUrl`/`url` is resolved to build that key, so it is read once more per item.
     *
     * Sharers are REF-COUNTED: each shares the one result and the leader's progress, cancels
     * independently, and the request on the wire is aborted only when the LAST of them cancels —
     * cancelling one sharer never fails the others.
     *
     * In-flight coalescing, not a cache: only items whose lifetimes OVERLAP collapse. An item
     * admitted after the shared request settled starts a fresh one, so a finished blob — or a
     * finished failure — is never replayed onto a later item.
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
    /**
     * Cancel one item, or — with `id` omitted — every item.
     *
     * One member rather than a `cancel`/`cancelAll` pair: two flat members sharing a leading word
     * are one capability spelled twice (CONTRACT.md P24/R8). Cancelling is that capability and the
     * id is its scope, so the scope belongs in the argument. P24's envelope prescription is for
     * option FIELDS; for a verb, the optional parameter is the collapse — an envelope would be
     * `cancel.one(id)`/`cancel.all()`, which is the same pair one level deeper.
     *
     * In-flight items abort (each freed slot goes to the next queued item); queued items just drop.
     * Either way the item settles as `cancelled` — the batch still never rejects.
     */
    cancel(id?: DownloadId): void;
    /** A live snapshot of per-item phase + aggregate progress. */
    snapshot(): BatchSnapshot;
}
