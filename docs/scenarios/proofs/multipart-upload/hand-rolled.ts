// The same uploader with NO StitchAPI in it — the honest comparison for C8's line count.
//
// Feature-matched to `multipart.ts` line for line of BEHAVIOUR, so the difference is attributable:
// four endpoints, a bounded pool, per-part retry on `[429,500,502,503,504]` with exponential
// backoff, ETag lifted from the response header, `Promise.all` input ordering, per-part high-water
// progress aggregation, a `try/finally` abort, and the same loud-cleanup-failure rule.
//
// It drives the SAME transport the StitchAPI side does (an `Adapter`-shaped function), so neither
// implementation gets a shortcut on the wire.
import type { Adapter } from '../../../../packages/core/src/types';
import type { UploadOptions, UploadStats, UploaderOptions } from './multipart';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** A minimal FIFO concurrency pool — what `throttle: { concurrency }` is on the other side. */
function pool(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
    let inFlight = 0;
    const waiters: (() => void)[] = [];
    const release = (): void => {
        inFlight -= 1;
        waiters.shift()?.();
    };
    return async <T>(fn: () => Promise<T>): Promise<T> => {
        if (inFlight >= limit)
            await new Promise<void>((r) => {
                waiters.push(() => {
                    inFlight += 1;
                    r();
                });
            });
        else inFlight += 1;
        try {
            return await fn();
        } finally {
            release();
        }
    };
}

const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

export function handRolledUploader(opts: UploaderOptions): {
    upload: (
        key: string,
        chunks: readonly unknown[],
        options?: UploadOptions,
    ) => Promise<unknown>;
    lastStats: () => UploadStats | undefined;
} {
    const send: Adapter = opts.adapter;
    const url = (key: string, qs: string): string =>
        `${opts.urlTemplate.replace('{key}', key)}?${qs}`;
    const take = pool(opts.concurrency ?? 4);
    const attempts = opts.attempts ?? 3;
    let stats: UploadStats | undefined;

    async function putPart(
        key: string,
        uploadId: string,
        n: number,
        chunk: unknown,
        onTick: (loaded: number, total: number | undefined) => void,
        signal: AbortSignal | undefined,
    ): Promise<string> {
        for (let attempt = 1; ; attempt++) {
            const res = await send({
                url: url(key, `partNumber=${n}&uploadId=${uploadId}`),
                method: 'PUT',
                headers: {},
                body: chunk,
                onProgress: (p) => {
                    if (p.direction === 'upload') onTick(p.loaded, p.total);
                },
                ...(signal ? { signal } : {}),
            });
            if (res.status < 400) {
                const etag = res.headers['etag'];
                if (!etag) throw new Error(`part ${n}: no ETag header`);
                return etag;
            }
            if (!RETRYABLE.has(res.status) || attempt >= attempts)
                throw new Error(`part ${n}: HTTP ${res.status}`);
            await sleep(2 ** (attempt - 1) * 100);
        }
    }

    async function upload(
        key: string,
        chunks: readonly unknown[],
        options: UploadOptions = {},
    ): Promise<unknown> {
        const { onProgress, signal } = options;
        const init = await send({
            url: url(key, 'uploads'),
            method: 'POST',
            headers: {},
            ...(signal ? { signal } : {}),
        });
        if (init.status >= 400)
            throw new Error(`initiate: HTTP ${init.status}`);
        const uploadId = (init.body as { UploadId: string }).UploadId;
        const sent = new Map<number, number>();
        let total = 0;
        let settled = false;
        stats = { uploadId, parts: 0, cleanedUp: false, sent: 0 };
        try {
            const parts = await Promise.all(
                chunks.map(async (chunk, i) => {
                    const PartNumber = i + 1;
                    const ETag = await take(() =>
                        putPart(
                            key,
                            uploadId,
                            PartNumber,
                            chunk,
                            (loaded, t) => {
                                if (t !== undefined)
                                    total = Math.max(total, t * chunks.length);
                                sent.set(
                                    PartNumber,
                                    Math.max(sent.get(PartNumber) ?? 0, loaded),
                                );
                                let done = 0;
                                for (const v of sent.values()) done += v;
                                onProgress?.(
                                    total ? done / total : 0,
                                    done,
                                    total,
                                );
                            },
                            signal,
                        ),
                    );
                    return { PartNumber, ETag };
                }),
            );
            stats.parts = parts.length;
            const res = await send({
                url: url(key, `uploadId=${uploadId}`),
                method: 'POST',
                headers: {},
                body: { Parts: parts },
                ...(signal ? { signal } : {}),
            });
            if (res.status >= 400)
                throw new Error(`complete: HTTP ${res.status}`);
            settled = true;
            return res.body;
        } finally {
            let done = 0;
            for (const v of sent.values()) done += v;
            stats.sent = done;
            if (!settled) {
                let ok = false;
                let reason = 'unknown';
                try {
                    const res = await send({
                        url: url(key, `uploadId=${uploadId}`),
                        method: 'DELETE',
                        headers: {},
                    });
                    ok = res.status < 400;
                    if (!ok) reason = `HTTP ${res.status}`;
                } catch (e) {
                    reason = (e as Error).message;
                }
                stats.cleanedUp = ok;
                if (!ok) {
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
