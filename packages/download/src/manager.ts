import { classifyFailure, toStitchError } from './classify';
import { DownloadCancelledError, DownloadIdleTimeoutError } from './errors';
import { ProgressAggregator } from './progress';
import { resolveTarget } from './target';
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

import { duration, systemClock } from 'stitchapi';
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
    /**
     * The `id` the CALLER wrote, when they wrote one — `undefined` when {@link DownloadManager.add}
     * derived one from the URL or the enqueue index. Dedupe keys off it in preference to the URL:
     * an explicit id is a deliberate identity claim, and it outranks what the endpoint spells.
     */
    explicitId: DownloadId | undefined;
    config: Partial<StitchConfig>;
}

interface Active {
    /**
     * The controller behind this item's request. Under dedupe every sharer of one in-flight fetch
     * holds the SAME controller — there is one request on the wire, so there is one thing to abort,
     * and it is aborted only by {@link Shared} losing its last sharer.
     */
    ctrl: AbortController;
    /** The live forward-progress timer handle, re-armed on every chunk; `undefined` when unarmed. */
    timer: unknown;
    /** The latest RAW transport error captured via `hooks.onError` — for classification. */
    raw: unknown;
    /**
     * The dedupe group this item is one sharer of, while it still is one — `undefined` outside
     * dedupe, and cleared the moment it leaves the ref count. It lives here rather than in a second
     * id-keyed map because that is all this record is: the state an item holds while it is active.
     */
    group: Shared | undefined;
}

/**
 * One in-flight fetch shared by every item that resolved to the same dedupe key, plus the live set
 * of those items — the REF COUNT. A sharer that cancels leaves the set and settles on its own; the
 * request on the wire is aborted only when the set empties, so no one item's cancel can pull the
 * bytes out from under the others.
 */
interface Shared {
    /** The dedupe key this group is registered under, for unregistering it again. */
    key: string;
    /** The single request every sharer awaits. */
    promise: Promise<DownloadResult>;
    /** The one controller behind that request — aborted only when the LAST sharer leaves. */
    ctrl: AbortController;
    /** Live sharers, in admission order; `size` is the ref count. */
    sharers: Set<DownloadId>;
    /**
     * The sharer that currently owns the group's byte progress and its idle timer. It starts as the
     * item that opened the request and is handed to a survivor if that item cancels out — the fetch
     * outlives it, so its watchdog and its progress must too.
     */
    leader: DownloadId;
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
    readonly #idle: number | undefined;
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
    /** Dedupe key → the group sharing one in-flight fetch. Only ever populated when `dedupe` is on. */
    readonly #shared = new Map<string, Shared>();
    readonly #cancelled = new Set<DownloadId>();
    readonly #stalled = new Set<DownloadId>();
    #drainWaiters: (() => void)[] = [];
    #signalAborted = false;

    constructor(opts: BatchOptions = {}) {
        this.#concurrency = Math.max(1, opts.concurrency ?? 4);
        this.#defaults = opts.defaults ?? {};
        this.#idle = duration.parse(opts.idle);
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
            this.#cancelActive(id);
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
        // Cancel each in-flight item. Aborts reject on a microtask and a deduped item settles inline,
        // so snapshot the ids first rather than mutate #active mid-iteration. Each aborted download
        // releases its engine throttle slot, so a later batch to the same host isn't starved by
        // leaked in-flight state. Under dedupe the ref count still governs: the group's request is
        // aborted once, by whichever of its sharers this loop reaches last.
        for (const id of [...this.#active.keys()]) {
            this.#cancelled.add(id);
            this.#cancelActive(id);
        }
    }

    /**
     * Cancel one item that is already in flight.
     *
     * Outside dedupe the item owns its request outright: abort it and let the rejection settle it
     * (#onReject), freeing its slot for the next queued item. Under dedupe the item is one SHARER of
     * a group's request, so it leaves the ref count and settles right here — the shared promise no
     * longer speaks for it — and the request is aborted only if it was the last sharer.
     */
    #cancelActive(id: DownloadId): void {
        const group = this.#detach(id);
        if (group === undefined) {
            this.#active.get(id)?.ctrl.abort(new DownloadCancelledError());
            return;
        }
        if (group.sharers.size === 0) {
            // The last sharer left. Unregister the key BEFORE aborting, so a duplicate admitted
            // later opens a fresh request rather than joining a dying one — and only then kill the
            // request on the wire, which no one is waiting on any more.
            this.#unregister(group);
            group.ctrl.abort(new DownloadCancelledError());
        } else if (group.leader === id) this.#promoteLeader(group);
        this.#settle(id, { id, status: 'cancelled' });
    }

    /** Remove `id` from its shared group, if it is in one, and hand that group back to the caller. */
    #detach(id: DownloadId): Shared | undefined {
        const active = this.#active.get(id);
        const group = active?.group;
        if (active === undefined || group === undefined) return undefined;
        active.group = undefined;
        group.sharers.delete(id);
        return group;
    }

    // Drop a group from the key index — but only while it still holds the key. A group abandoned by
    // its last sharer may already have been replaced there by a fresh duplicate, and that newcomer's
    // request must survive the old group's promise finally settling.
    #unregister(group: Shared): void {
        if (this.#shared.get(group.key) === group)
            this.#shared.delete(group.key);
    }

    // Hand the group's progress + idle timer to a surviving sharer after its leader cancelled out.
    // The request on the wire is unchanged, so its forward-progress watchdog must not lapse with the
    // item that happened to open it; the window restarts here, since the outgoing timer dies in
    // #settle along with its owner.
    #promoteLeader(group: Shared): void {
        const next: DownloadId | undefined = group.sharers
            .values()
            .next().value;
        if (next === undefined) return;
        group.leader = next;
        this.#resetIdle(next);
    }

    /**
     * Resolves when the queue is fully drained (all added items settled).
     *
     * Named for the QUEUE, not for idleness: {@link BatchOptions.idle} is a per-item
     * forward-progress window, a different clock over a different subject, and one word may not
     * carry both concepts (CONTRACT.md P2).
     */
    drained(): Promise<void> {
        if (this.#queue.length === 0 && this.#active.size === 0)
            return Promise.resolve();
        return new Promise<void>((resolve) => {
            this.#drainWaiters.push(resolve);
        });
    }

    /** The per-item results so far, in enqueue order. Awaits {@link drained} first. */
    async results(): Promise<ItemResult[]> {
        await this.drained();
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
        const config: Partial<StitchConfig> = isStr
            ? { url: item }
            : this.#stripId(item);
        return { id, explicitId, config };
    }

    /**
     * The dedupe key for an item: the caller's own `id` when they gave one, else the RESOLVED
     * request target — `defaults` merged under the item, then `baseUrl` + `path` (or a whole `url`)
     * with the query sorted. Keying off the resolution rather than the spelling is what makes
     * `{ path: '/x' }` twice under one `baseUrl` a single fetch; keying off an explicit `id` first
     * keeps the older, deliberate arm, where the caller declares two items to BE the same download.
     *
     * One flat namespace, as before — an explicit id and a resolved URL are compared as equals.
     *
     * Computed at admission, not at `add()`: a thunked `baseUrl`/`url` is read here, so it is read as
     * close to the request as the batch can manage (and never at all when `dedupe` is off).
     */
    #dedupeKey(item: QueueItem): string {
        return item.explicitId !== undefined
            ? String(item.explicitId)
            : resolveTarget({ ...this.#defaults, ...item.config });
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
        this.#maybeDrained();
    }

    #start(item: QueueItem): void {
        this.#phase.set(item.id, 'active');
        this.#opts.onItemStart?.(item.id);

        const key = this.#dedupe ? this.#dedupeKey(item) : undefined;
        const joined = key === undefined ? undefined : this.#shared.get(key);
        // A follower shares the LEADER's controller rather than owning a dead one of its own: the
        // group has a single request on the wire, so it has a single thing to abort — and if this
        // follower is later promoted, its idle timer has to be able to reach it.
        const ctrl = joined?.ctrl ?? new AbortController();
        const active: Active = {
            ctrl,
            timer: undefined,
            raw: undefined,
            group: joined,
        };
        this.#active.set(item.id, active);

        let result: Promise<DownloadResult>;
        if (joined !== undefined) {
            // Follower: reuse the leader's in-flight fetch — no second request on the wire. It joins
            // the ref count, so that fetch now outlives any ONE of its sharers cancelling.
            joined.sharers.add(item.id);
            result = joined.promise;
        } else {
            // The group this item OPENS, if it opens one. Held here rather than read back off
            // `active.group`: that slot is cleared the moment THIS item leaves the ref count, and
            // the group outlives it — a cancelled leader's request keeps streaming for whoever is
            // left, so its bytes have to keep reaching them.
            let opened: Shared | undefined;
            const input: StitchInput = {
                signal: ctrl.signal,
                onProgress: (p: AdapterProgress) => {
                    // Attributed to the group's CURRENT leader, read per chunk rather than
                    // captured: a leader that cancels hands the group's progress — and the `idle`
                    // window those chunks reset — to a survivor.
                    if (p.direction === 'download')
                        this.#onItemProgress(opened?.leader ?? item.id, p);
                },
            };
            // Promise.resolve() subscribes to the COLD StitchResult (nothing runs until a handler
            // attaches) and yields a real Promise to share for dedupe.
            const promise = Promise.resolve(
                download(this.#configFor(item, active))(input),
            );
            result = promise;
            if (key !== undefined) {
                const group: Shared = {
                    key,
                    promise,
                    ctrl,
                    sharers: new Set<DownloadId>([item.id]),
                    leader: item.id,
                };
                opened = group;
                active.group = group;
                this.#shared.set(key, group);
                // Unregister the KEY the instant the request settles, and ahead of any per-item
                // handler — reactions run in registration order and this one is registered first,
                // before the `result.then` below. A settled group must not still be joinable:
                // #settle pumps the queue, so an item admitted by the very settlement that ended
                // this fetch would otherwise inherit its finished blob — or its finished FAILURE —
                // without ever reaching the wire. Dedupe coalesces requests IN FLIGHT; it is not a
                // cache, and the boundary has to be crisp rather than a microtask wide.
                const forget = (): void => {
                    this.#unregister(group);
                };
                void promise.then(forget, forget);
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
        if (this.#idle === undefined) return;
        active.timer = this.#clock.setTimer(() => {
            this.#onIdle(id);
        }, this.#idle);
    }

    #resetIdle(id: DownloadId): void {
        if (this.#idle === undefined) return;
        const active = this.#active.get(id);
        if (active === undefined) return;
        this.#clearIdle(active);
        active.timer = this.#clock.setTimer(() => {
            this.#onIdle(id);
        }, this.#idle);
    }

    #clearIdle(active: Active): void {
        if (active.timer !== undefined) {
            this.#clock.clearTimer(active.timer);
            active.timer = undefined;
        }
    }

    #onIdle(id: DownloadId): void {
        const active = this.#active.get(id);
        if (active === undefined) return;
        this.#stalled.add(id);
        active.ctrl.abort(new DownloadIdleTimeoutError(this.#idle ?? 0));
    }

    #onReject(id: DownloadId, err: unknown, active: Active): void {
        if (this.#cancelled.has(id)) {
            this.#settle(id, { id, status: 'cancelled' });
            return;
        }
        const reason = toStitchError(err);
        if (this.#stalled.has(id)) {
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
        // Leave the ref count without aborting anything. Reaching here still holding a group means
        // the shared request itself finished (resolved, or rejected for everyone) — the cancel path
        // detaches first, precisely so that it can decide whether the wire should die with the item.
        this.#detach(id);
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

    #maybeDrained(): void {
        if (this.#queue.length > 0 || this.#active.size > 0) return;
        const waiters = this.#drainWaiters;
        this.#drainWaiters = [];
        for (const resolve of waiters) resolve();
    }
}
