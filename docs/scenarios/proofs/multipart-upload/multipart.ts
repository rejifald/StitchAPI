// The assembled answer — USER CODE, and the subject of C8's line count.
//
// Four stitches and one `try/finally`. What is CONFIG here (and therefore not written out below):
// the per-part retry policy and its widened `on` set, the concurrency bound, the per-attempt
// timeout, URL templating, the trace spine, and the ETag lift (`Surface.interpret`). What is CODE
// here, because nothing in the library does it:
//
//   - **the `try/finally` that aborts.** C4 established there is no compensation seam of any kind,
//     so this is the whole of the cleanup story. It lives at the ORCHESTRATION level because that is
//     the only scope that holds the `uploadId` (C6(e)).
//   - **the loud failure when the cleanup itself fails.** `abort.safe()` cannot throw, which is
//     exactly what makes it dangerous here: a swallowed cleanup error is an upload that bills
//     forever while the code reads as correct (C4(h2)). `onCleanupFailure` is mandatory-by-default:
//     omitted, it throws.
//   - **the per-part progress bookkeeping.** A tick carries no part identity (C7(b)), so the part
//     number is bound at the call site and the aggregate is a per-part HIGH-WATER mark — a running
//     `+=` double-counts a retried part (C7(d)).
import { stitch, verdictOf } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import type {
    Adapter,
    Clock,
    Stitch,
    TraceSink,
} from '../../../../packages/core/src/types';

/** The part surface: a part's value is its `ETag` RESPONSE HEADER (C2). */
const partSurface: Surface = {
    // `verdictOf` FIRST — `interpret` replaces the default verdict, so without it an HTTP 500 part
    // becomes `ok: true` carrying `undefined` and the upload fails two calls later (C2(e)).
    id: 'multipart-part',
    interpret: (res, cfg) =>
        verdictOf(res, cfg) ?? { ok: true, data: res.headers['etag'] },
};

export interface UploaderOptions {
    /** Transport. `xhrAdapter(...)` if you want upload progress; `fetchAdapter(...)` otherwise (C1). */
    adapter: Adapter;
    /** RFC 6570 template for the object, e.g. `https://s3.example/bucket/{key}`. */
    urlTemplate: string;
    /** Max simultaneous part PUTs. The bound lives on the part stitch (C3(d)). */
    concurrency?: number;
    /** Attempts per PART (never per upload — a whole-upload retry re-initiates, C5(d)). */
    attempts?: number;
    /**
     * Called when the compensating DELETE did not succeed. There is no safe default: a swallowed
     * cleanup failure is an invisible, permanent storage bill. Omitted ⇒ throws.
     */
    onCleanupFailure?: (uploadId: string, reason: string) => void;
    clock?: Clock;
    trace?: TraceSink;
}

/** Reported after every run, successful or not — the numbers an operator needs. */
export interface UploadStats {
    uploadId: string;
    /** Parts whose ETag the client holds. */
    parts: number;
    /** Did the compensating DELETE run AND succeed? */
    cleanedUp: boolean;
    /** Bytes sent, aggregated across parts (per-part high-water — C7(c)). */
    sent: number;
}

export interface UploadOptions {
    /** One aggregated 0-1 fraction for a UI. Fires only on a transport that reports upload bytes. */
    onProgress?: (fraction: number, sent: number, total: number) => void;
    signal?: AbortSignal;
}

/**
 * Build an uploader bound to one bucket + transport. The returned function performs a complete
 * S3-style multipart upload and leaves **zero** orphaned parts on every exit path.
 */
export function multipartUploader(opts: UploaderOptions): {
    upload: (
        key: string,
        chunks: readonly unknown[],
        options?: UploadOptions,
    ) => Promise<unknown>;
    lastStats: () => UploadStats | undefined;
} {
    const shared = {
        adapter: opts.adapter,
        ...(opts.clock ? { clock: opts.clock } : {}),
        ...(opts.trace ? { trace: opts.trace } : {}),
    };
    const initiate = stitch({
        ...shared,
        name: 'multipart.initiate',
        url: `${opts.urlTemplate}?uploads`,
        method: 'POST',
        pick: 'UploadId',
    }) as Stitch<string>;
    const part = stitch({
        ...shared,
        name: 'multipart.part',
        url: opts.urlTemplate,
        method: 'PUT',
        kind: partSurface,
        // 500 is S3's own transient error and is NOT in the default `[429,502,503,504]` (C5(b)).
        retry: { attempts: opts.attempts ?? 3, on: [429, 500, 502, 503, 504] },
        throttle: { concurrency: opts.concurrency ?? 4 },
    }) as Stitch<string>;
    const complete = stitch({
        ...shared,
        name: 'multipart.complete',
        url: opts.urlTemplate,
        method: 'POST',
    });
    const abort = stitch({
        ...shared,
        name: 'multipart.abort',
        url: opts.urlTemplate,
        method: 'DELETE',
    });

    let stats: UploadStats | undefined;

    async function upload(
        key: string,
        chunks: readonly unknown[],
        options: UploadOptions = {},
    ): Promise<unknown> {
        const { onProgress, signal } = options;
        const uploadId = await initiate({
            params: { key },
            ...(signal ? { signal } : {}),
        });
        const sent = new Map<number, number>();
        let total = 0;
        let settled = false;
        stats = { uploadId, parts: 0, cleanedUp: false, sent: 0 };
        try {
            const parts = await Promise.all(
                chunks.map(async (chunk, i) => {
                    const PartNumber = i + 1;
                    const ETag = await part({
                        params: { key },
                        query: { partNumber: PartNumber, uploadId },
                        body: chunk,
                        ...(signal ? { signal } : {}),
                        onProgress: (p) => {
                            if (p.direction !== 'upload') return;
                            if (p.total !== undefined)
                                total = Math.max(
                                    total,
                                    p.total * chunks.length,
                                );
                            // HIGH-WATER, not `+=`: a retried part replays its ticks (C7(d)).
                            sent.set(
                                PartNumber,
                                Math.max(sent.get(PartNumber) ?? 0, p.loaded),
                            );
                            let done = 0;
                            for (const v of sent.values()) done += v;
                            onProgress?.(total ? done / total : 0, done, total);
                        },
                    });
                    return { PartNumber, ETag };
                }),
            );
            // `Promise.all` resolves in INPUT order regardless of completion order, which is exactly
            // the order `complete` demands — no sort needed (C2(c)).
            stats.parts = parts.length;
            const object = await complete({
                params: { key },
                query: { uploadId },
                body: { Parts: parts },
                ...(signal ? { signal } : {}),
            });
            settled = true;
            return object;
        } finally {
            let done = 0;
            for (const v of sent.values()) done += v;
            stats.sent = done;
            if (!settled) {
                const cleanup = await abort.safe({
                    params: { key },
                    query: { uploadId },
                });
                stats.cleanedUp = cleanup.ok;
                if (!cleanup.ok) {
                    const reason = cleanup.error?.message ?? 'unknown';
                    if (opts.onCleanupFailure)
                        opts.onCleanupFailure(uploadId, reason);
                    else
                        throw new Error(
                            `multipart cleanup FAILED for ${uploadId} (${reason}) — parts are still billing`,
                        );
                }
            }
        }
    }

    return { upload, lastStats: () => stats };
}
