import { classifyFailure, toStitchError } from './classify';
import { DownloadCancelledError, DownloadIdleTimeoutError } from './errors';
import { ProgressAggregator } from './progress';
import type {
    BatchOptions,
    BatchSnapshot,
    DownloadHandle,
    DownloadId,
    DownloadRequest,
    ItemPhase,
    ItemProgress,
    ItemResult,
} from './types';

import { systemClock } from 'stitchapi';
import type {
    AdapterProgress,
    Clock,
    HookContext,
    StitchConfig,
    StitchInput,
} from 'stitchapi';
import { download } from 'stitchapi/download';
import type { DownloadResult } from 'stitchapi/download';

interface QueueItem {
    id: DownloadId;
    key: string;
    config: Partial<StitchConfig>;
}

interface Active {
    ctrl: AbortController;
    idleTimer: unknown;
    /** The latest RAW transport error captured via `hooks.onError` — for classification. */
    raw: unknown;
}

interface InternalHandle {
    external: DownloadHandle;
    resolve: (result: ItemResult) => void;
}

/**
 * The stateful batch engine: a FIFO concurrency scheduler over core's `download()`. Admits up to
 * `concurrency` items at a time in enqueue order, settles each on its own (one failure never fails the
 * batch), and layers the two findings the rig surfaced — a forward-progress idle timer and transport
 * error classification — plus cancellation and aggregate progress/ETA, none of which core's `throttle`
 * can express (its queue is opaque). {@link downloadAll} is a thin one-shot wrapper over this.
 */
export class DownloadManager {
    readonly #concurrency: number;
    readonly #defaults: Partial<StitchConfig>;
    readonly #idleTimeout: number | undefined;
    readonly #dedupe: boolean;
    readonly #clock: Clock;
    readonly #opts: BatchOptions;
    readonly #progress: ProgressAggregator;

    readonly #queue: QueueItem[] = [];
    readonly #active = new Map<DownloadId, Active>();
    readonly #order: DownloadId[] = [];
    readonly #phase = new Map<DownloadId, ItemPhase>();
    readonly #results = new Map<DownloadId, ItemResult>();
    readonly #handles = new Map<DownloadId, InternalHandle>();
    readonly #lastTotal = new Map<DownloadId, number>();
    readonly #dedupeInflight = new Map<string, Promise<DownloadResult>>();
    readonly #cancelled = new Set<DownloadId>();
    readonly #idledOut = new Set<DownloadId>();
    #idleWaiters: Array<() => void> = [];
    #signalAborted = false;

    constructor(opts: BatchOptions = {}) {
        this.#concurrency = Math.max(1, opts.concurrency ?? 4);
        this.#defaults = opts.defaults ?? {};
        this.#idleTimeout = opts.idleTimeout;
        this.#dedupe = opts.dedupe ?? false;
        this.#clock = opts.clock ?? systemClock;
        this.#opts = opts;
        this.#progress = new ProgressAggregator(this.#clock);

        const signal = opts.signal;
        if (signal !== undefined) {
            if (signal.aborted) this.#signalAborted = true;
            else
                signal.addEventListener(
                    'abort',
                    () => {
                        this.#signalAborted = true;
                        this.#cancelAll();
                    },
                    { once: true },
                );
        }
    }

    /** Enqueue an item. Returns a handle whose `.done` resolves to that item's {@link ItemResult}. */
    add(item: DownloadRequest): DownloadHandle {
        const norm = this.#normalize(item);
        this.#order.push(norm.id);
        this.#phase.set(norm.id, 'queued');
        const handle = this.#makeHandle(norm.id);
        this.#handles.set(norm.id, handle);

        if (this.#signalAborted) {
            // The batch's external signal already fired — never start; settle straight to cancelled.
            this.#settle(norm.id, { id: norm.id, status: 'cancelled' });
        } else {
            this.#queue.push(norm);
            this.#pump();
        }
        return handle.external;
    }

    /**
     * Cancel one item, or — with `id` omitted — every item. In-flight → abort (its slot goes to the
     * next queued item); queued → drop. One member rather than a `cancel`/`cancelAll` pair, matching
     * {@link DownloadBatch.cancel}; see its doc for why the scope is an argument (P24/R8).
     */
    cancel(id?: DownloadId): void {
        if (id === undefined) {
            this.#cancelAll();
            return;
        }
        if (this.#results.has(id)) return;
        const phase = this.#phase.get(id);
        if (phase === undefined) return; // unknown id
        this.#cancelled.add(id);
        if (phase === 'active') {
            // The abort rejects the in-flight download; #onReject settles it 'cancelled', its slot
            // frees, and #pump admits the next queued item.
            this.#active.get(id)?.ctrl.abort(new DownloadCancelledError());
        } else if (phase === 'queued') {
            // Drop from the queue and settle now. It held no slot, so the next queued item's turn is
            // unaffected — no freed slot, no skip.
            const idx = this.#queue.findIndex((q) => q.id === id);
            if (idx >= 0) this.#queue.splice(idx, 1);
            this.#settle(id, { id, status: 'cancelled' });
        }
    }

    // The whole-batch arm of `cancel()`, kept as a private method rather than inlined: the abort
    // listener in the constructor reaches it too, and `cancel()`'s own early-outs (`#results`,
    // unknown id) are per-item guards that would be wrong to run over the batch.
    // Pooled (`pool:'host'`) budget returns clean.
    #cancelAll(): void {
        // Queued items hold no slot — settle them straight away.
        const queued = this.#queue.splice(0, this.#queue.length);
        for (const item of queued) {
            if (this.#results.has(item.id)) continue;
            this.#cancelled.add(item.id);
            this.#settle(item.id, { id: item.id, status: 'cancelled' });
        }
        // Abort each in-flight item. Aborts reject on a microtask, so snapshot the entries first
        // rather than mutate #active mid-iteration. Each aborted download releases its engine throttle
        // slot, so a later batch to the same host isn't starved by leaked in-flight state.
        for (const [id, active] of [...this.#active.entries()]) {
            this.#cancelled.add(id);
            active.ctrl.abort(new DownloadCancelledError());
        }
    }

    /** Resolves when the queue is fully drained (all added items settled). */
    idle(): Promise<void> {
        if (this.#queue.length === 0 && this.#active.size === 0)
            return Promise.resolve();
        return new Promise<void>((resolve) => {
            this.#idleWaiters.push(resolve);
        });
    }

    /** The per-item results so far, in enqueue order. Awaits {@link idle} first. */
    async results(): Promise<ItemResult[]> {
        await this.idle();
        return this.#order.map(
            (id) => this.#results.get(id) ?? { id, status: 'cancelled' },
        );
    }

    /** A live snapshot of per-item phase + aggregate progress. */
    snapshot(): BatchSnapshot {
        const items = this.#order.map((id) => {
            const phase = this.#phase.get(id) ?? 'queued';
            const status = this.#results.get(id)?.status;
            return status !== undefined ? { id, phase, status } : { id, phase };
        });
        return {
            progress: this.#progress.snapshot(this.#order.length),
            items,
        };
    }

    // ---- internals --------------------------------------------------------

    #normalize(item: DownloadRequest): QueueItem {
        const isStr = typeof item === 'string';
        const url = isStr
            ? item
            : typeof item.url === 'string'
              ? item.url
              : undefined;
        const explicitId = isStr ? undefined : item.id;
        let id: DownloadId = explicitId ?? url ?? this.#order.length;
        // A duplicate URL/id would collide in the per-item maps — disambiguate by enqueue index.
        if (this.#phase.has(id)) id = this.#order.length;
        const key = this.#dedupe ? String(explicitId ?? url ?? id) : String(id);
        const config: Partial<StitchConfig> = isStr
            ? { url: item }
            : this.#stripId(item);
        return { id, key, config };
    }

    #stripId(
        item: Partial<StitchConfig> & { id?: DownloadId },
    ): Partial<StitchConfig> {
        const copy: Partial<StitchConfig> & { id?: DownloadId } = { ...item };
        delete copy.id;
        return copy;
    }

    #makeHandle(id: DownloadId): InternalHandle {
        let resolve!: (result: ItemResult) => void;
        const done = new Promise<ItemResult>((res) => {
            resolve = res;
        });
        const external: DownloadHandle = {
            id,
            done,
            cancel: () => {
                this.cancel(id);
            },
        };
        return { external, resolve };
    }

    #pump(): void {
        while (
            !this.#signalAborted &&
            this.#active.size < this.#concurrency &&
            this.#queue.length > 0
        ) {
            const item = this.#queue.shift();
            if (item === undefined) break;
            if (this.#phase.get(item.id) !== 'queued') continue; // cancelled while queued
            this.#start(item);
        }
        this.#maybeIdle();
    }

    #start(item: QueueItem): void {
        this.#phase.set(item.id, 'active');
        this.#opts.onItemStart?.(item.id);

        const ctrl = new AbortController();
        const active: Active = { ctrl, idleTimer: undefined, raw: undefined };
        this.#active.set(item.id, active);

        let result: Promise<DownloadResult>;
        const shared = this.#dedupe
            ? this.#dedupeInflight.get(item.key)
            : undefined;
        if (shared !== undefined) {
            // Follower: reuse the leader's in-flight fetch — no second request on the wire.
            result = shared;
        } else {
            const input: StitchInput = {
                signal: ctrl.signal,
                onProgress: (p: AdapterProgress) => {
                    if (p.direction === 'download')
                        this.#onItemProgress(item.id, p);
                },
            };
            // Promise.resolve() subscribes to the COLD StitchResult (nothing runs until a handler
            // attaches) and yields a real Promise to share for dedupe.
            result = Promise.resolve(
                download(this.#configFor(item, active))(input),
            );
            if (this.#dedupe) {
                this.#dedupeInflight.set(item.key, result);
                void result
                    .catch(() => undefined)
                    .finally(() => this.#dedupeInflight.delete(item.key));
            }
            this.#armIdle(item.id, active);
        }

        void result.then(
            (value) => {
                this.#settle(item.id, {
                    id: item.id,
                    status: 'fulfilled',
                    value,
                });
            },
            (err: unknown) => {
                this.#onReject(item.id, err, active);
            },
        );
    }

    #configFor(item: QueueItem, active: Active): Partial<StitchConfig> {
        const userOnError =
            item.config.hooks?.onError ?? this.#defaults.hooks?.onError;
        // Deliberately UNANNOTATED. The `hooks` config slot is `AtLeastOne<Hooks>` (P20, #507):
        // an all-optional `Hooks` annotation no longer satisfies it, because nothing in that type
        // proves a key is present. The inferred type does — `onError` is assigned right here, so it
        // comes back REQUIRED and the slot is met by construction rather than by assertion. The cost
        // is the inline callback losing its contextual parameter type, hence the explicit `ctx`.
        const hooks = {
            ...this.#defaults.hooks,
            ...item.config.hooks,
            onError: (ctx: HookContext) => {
                active.raw = ctx.error;
                return userOnError?.(ctx);
            },
        };
        return { ...this.#defaults, ...item.config, hooks };
    }

    #onItemProgress(id: DownloadId, p: AdapterProgress): void {
        const item: ItemProgress =
            p.total !== undefined
                ? { loaded: p.loaded, total: p.total }
                : { loaded: p.loaded };
        if (p.total !== undefined) this.#lastTotal.set(id, p.total);
        this.#progress.item(id, item);
        this.#resetIdle(id);
        this.#opts.onItemProgress?.(id, item);
        this.#emitProgress();
    }

    #armIdle(id: DownloadId, active: Active): void {
        if (this.#idleTimeout === undefined) return;
        active.idleTimer = this.#clock.setTimer(
            () => this.#onIdle(id),
            this.#idleTimeout,
        );
    }

    #resetIdle(id: DownloadId): void {
        if (this.#idleTimeout === undefined) return;
        const active = this.#active.get(id);
        if (active === undefined) return;
        this.#clearIdle(active);
        active.idleTimer = this.#clock.setTimer(
            () => this.#onIdle(id),
            this.#idleTimeout,
        );
    }

    #clearIdle(active: Active): void {
        if (active.idleTimer !== undefined) {
            this.#clock.clearTimer(active.idleTimer);
            active.idleTimer = undefined;
        }
    }

    #onIdle(id: DownloadId): void {
        const active = this.#active.get(id);
        if (active === undefined) return;
        this.#idledOut.add(id);
        active.ctrl.abort(new DownloadIdleTimeoutError(this.#idleTimeout ?? 0));
    }

    #onReject(id: DownloadId, err: unknown, active: Active): void {
        if (this.#cancelled.has(id)) {
            this.#settle(id, { id, status: 'cancelled' });
            return;
        }
        const reason = toStitchError(err);
        if (this.#idledOut.has(id)) {
            this.#settle(id, {
                id,
                status: 'rejected',
                reason,
                retryable: true,
                code: 'IDLE_TIMEOUT',
            });
            return;
        }
        const { retryable, code } = classifyFailure(reason, active.raw);
        this.#settle(
            id,
            code !== undefined
                ? { id, status: 'rejected', reason, retryable, code }
                : { id, status: 'rejected', reason, retryable },
        );
    }

    #settle(id: DownloadId, result: ItemResult): void {
        if (this.#results.has(id)) return; // guard double-settle (dedupe / abort races)
        this.#results.set(id, result);
        this.#phase.set(id, 'settled');
        const active = this.#active.get(id);
        if (active !== undefined) {
            this.#clearIdle(active);
            this.#active.delete(id);
        }
        if (result.status === 'fulfilled')
            this.#progress.fulfilled(
                id,
                result.value.blob.size,
                this.#lastTotal.get(id),
            );
        else this.#progress.dropped(id);

        this.#handles.get(id)?.resolve(result);
        this.#opts.onItemSettled?.(result);
        this.#emitProgress();
        this.#pump();
    }

    #emitProgress(): void {
        this.#opts.onProgress?.(this.#progress.snapshot(this.#order.length));
    }

    #maybeIdle(): void {
        if (this.#queue.length > 0 || this.#active.size > 0) return;
        const waiters = this.#idleWaiters;
        this.#idleWaiters = [];
        for (const resolve of waiters) resolve();
    }
}
