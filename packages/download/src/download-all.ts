import { DownloadManager } from './manager';
import type {
    BatchOptions,
    DownloadBatch,
    DownloadRequest,
    ItemResult,
} from './types';

/**
 * Download a list of items with bounded concurrency, returning an awaitable, controllable batch.
 *
 * Items start in FIFO order as slots free; each settles on its own — the batch NEVER rejects, so await
 * it for the per-item results in enqueue order. Each is `Promise.allSettled`-SHAPED — a `status`
 * discriminator, plus a `cancelled` arm — but spelled in StitchAPI's house words: `data` on the
 * success arm, `error` on the failure arm (CONTRACT.md P5). The handle also cancels — one item, or
 * the whole batch — and reports a live {@link DownloadBatch.snapshot} with aggregate progress + ETA.
 *
 * ```ts
 * const batch = downloadAll(urls, { concurrency: 4, onProgress: p => render(p) });
 * batch.cancel(id);            // cancel one → its slot goes to the next queued item
 * batch.cancel();              // cancel everything — in-flight abort, queue drains
 * const results = await batch; // ItemResult[] — never throws
 * for (const r of results) if (r.status === 'fulfilled') save(r.data.blob);
 * ```
 */
export function downloadAll(
    items: DownloadRequest[],
    opts: BatchOptions = {},
): DownloadBatch {
    const manager = new DownloadManager(opts);
    for (const item of items) manager.add(item);
    const done: Promise<ItemResult[]> = manager.results();
    return {
        done,
        then: done.then.bind(done),
        cancel: (id) => {
            manager.cancel(id);
        },
        snapshot: () => manager.snapshot(),
    };
}
