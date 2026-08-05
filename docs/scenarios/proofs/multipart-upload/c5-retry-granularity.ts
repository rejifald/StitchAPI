// C5 — retry granularity. Can ONE part retry without re-sending the others, and is a WHOLE-UPLOAD
// retry prevented?
//
// The measurement is `partPutOrder` (every part number the server saw, in arrival order) and
// `initiated` (how many `POST ?uploads` arrived). A per-part retry shows one number twice; a
// whole-upload retry shows `initiated: 2` and leaves the first UploadId's parts orphaned.
//
// The finding the capture does not anticipate is (b): the default `retry.on` is
// `[429, 502, 503, 504]` (engine.ts:612). S3's own transient failure is `500 InternalError`, and
// **it is not in that set** — so the retry most people believe they configured does not fire for the
// status the vendor actually sends.
//
//   pnpm exec tsx docs/scenarios/proofs/multipart-upload/c5-retry-granularity.ts
import { stitch, verdictOf } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import type { Adapter } from '../../../../packages/core/src/types';
import { FakeS3 } from './fake-s3';
import { check, checkSeq, finish, heading, note } from './harness';

const partSurface: Surface = {
    id: 'multipart-part',
    interpret: (res, cfg) =>
        verdictOf(res, cfg) ?? { ok: true, data: res.headers['etag'] },
};

const NO_WAIT = { attempts: 3, backoff: { curve: 'fixed' as const, base: 0 } };
const MiB = 1024 * 1024;

async function openUpload(api: FakeS3, key: string): Promise<string> {
    const res = await api.adapter()({
        url: `${FakeS3.url(key)}?uploads`,
        method: 'POST',
        headers: {},
    });
    return (res.body as { UploadId: string }).UploadId;
}

/**
 * The whole upload as ONE stitch, via `Surface.execute` (ADR 0008) — the only construction that
 * puts an orchestration inside the engine's retry/timeout/trace chain. `cleanup` decides whether
 * the abort is written into it.
 */
function uploadSurface(
    api: FakeS3,
    parts: number[],
    opts: { cleanup: boolean },
): Surface {
    const transport = api.adapter();
    const execute: Adapter = async (req) => {
        const url = new URL(req.url);
        const key = url.pathname.replace('/bucket/', '');
        const init = await transport({
            url: `${FakeS3.url(key)}?uploads`,
            method: 'POST',
            headers: {},
        });
        const uploadId = (init.body as { UploadId: string }).UploadId;
        try {
            const etags = await Promise.all(
                parts.map(async (n) => {
                    const res = await transport({
                        url: `${FakeS3.url(key)}?partNumber=${n}&uploadId=${uploadId}`,
                        method: 'PUT',
                        headers: {},
                        body: { chunk: `c${n}` },
                    });
                    if (res.status >= 400)
                        throw new Error(`part ${n}: HTTP ${res.status}`);
                    return { PartNumber: n, ETag: res.headers['etag'] };
                }),
            );
            const done = await transport({
                url: `${FakeS3.url(key)}?uploadId=${uploadId}`,
                method: 'POST',
                headers: {},
                body: { Parts: etags },
            });
            if (done.status >= 400)
                throw new Error(`complete: HTTP ${done.status}`);
            return done;
        } catch (e) {
            if (opts.cleanup)
                await transport({
                    url: `${FakeS3.url(key)}?uploadId=${uploadId}`,
                    method: 'DELETE',
                    headers: {},
                });
            throw e;
        }
    };
    return { id: 'multipart-upload', execute };
}

async function main(): Promise<void> {
    heading('C5 — per-part retry vs whole-upload retry');

    // ── (a) one part fails once (503) — is only that part re-sent? ────────────────────────────
    {
        const api = new FakeS3();
        api.failPart(3, 1, 503);
        const uploadId = await openUpload(api, 'v.mp4');
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
            retry: NO_WAIT,
        });
        const etags = await Promise.all(
            [1, 2, 3, 4].map(async (n) => ({
                PartNumber: n,
                ETag: (await part({
                    params: { key: 'v.mp4' },
                    query: { partNumber: n, uploadId },
                    body: { chunk: `c${n}` },
                })) as string,
            })),
        );
        const complete = stitch({
            url: FakeS3.template,
            method: 'POST',
            adapter: api.adapter(),
        });
        const done = await complete.safe({
            params: { key: 'v.mp4' },
            query: { uploadId },
            body: { Parts: etags },
        });
        check('(a) part PUTs the server saw', api.partPuts, 5);
        checkSeq(
            '(a) …which parts, in arrival order',
            api.partPutOrder,
            [1, 2, 3, 4, 3],
        );
        check('(a) `POST ?uploads` calls', api.initiated, 1);
        check('(a) complete → ok', done.ok, true);
        check('(a) orphans', api.orphanParts, 0);
        note(
            '(a) → per-part retry is exact',
            'part 3 alone was re-sent; parts 1/2/4 were not touched. On a 5 GB upload that is 5 MB re-sent instead of 5 GB',
        );
    }

    // ── (b) …but only for the statuses the DEFAULT set covers ─────────────────────────────────
    // `retry.on` defaults to `[429, 502, 503, 504]` (engine.ts:612). S3's transient error is
    // `500 InternalError`. The same config that saved (a) does nothing here.
    {
        const api = new FakeS3();
        api.failPart(3, 1, 500);
        const uploadId = await openUpload(api, 'v.mp4');
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
            retry: NO_WAIT,
        });
        const results = await Promise.all(
            [1, 2, 3, 4].map((n) =>
                part.safe({
                    params: { key: 'v.mp4' },
                    query: { partNumber: n, uploadId },
                    body: { chunk: `c${n}` },
                }),
            ),
        );
        check(
            '(b) 500 with retry: { attempts: 3 } → part PUTs',
            api.partPuts,
            4,
        );
        check('(b) …parts that failed', results.filter((r) => !r.ok).length, 1);
        check('(b) orphans left by the un-retried 500', api.orphanParts, 3);

        // The fix, measured.
        const api2 = new FakeS3();
        api2.failPart(3, 1, 500);
        const uploadId2 = await openUpload(api2, 'v.mp4');
        const part2 = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api2.adapter(),
            retry: { ...NO_WAIT, on: [429, 500, 502, 503, 504] },
        });
        const results2 = await Promise.all(
            [1, 2, 3, 4].map((n) =>
                part2.safe({
                    params: { key: 'v.mp4' },
                    query: { partNumber: n, uploadId: uploadId2 },
                    body: { chunk: `c${n}` },
                }),
            ),
        );
        checkSeq(
            '(b) with `on: [...500...]` → arrival order',
            api2.partPutOrder,
            [1, 2, 3, 4, 3],
        );
        check(
            '(b) …parts that failed',
            results2.filter((r) => !r.ok).length,
            0,
        );
        note(
            '(b) → `retry.on` must be widened for S3',
            "`500 InternalError` is S3's documented transient error and is NOT in the default set",
        );
    }

    // ── (c) a THROWN transport error is retried regardless of `retry.on` ──────────────────────
    // Different code path (engine.ts:681 — `if (attempt < max)` with no status match), which is why
    // the `execute` construction in (d) retries at all.
    {
        const api = new FakeS3();
        let thrown = 0;
        const flaky: Adapter = async (req) => {
            if (req.method === 'PUT' && (thrown += 1) === 1)
                throw new Error('ECONNRESET');
            return api.adapter()(req);
        };
        const uploadId = await openUpload(api, 'v.mp4');
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: flaky,
            retry: { ...NO_WAIT, on: [418] }, // deliberately matches nothing
        });
        const r = await part.safe({
            params: { key: 'v.mp4' },
            query: { partNumber: 1, uploadId },
            body: { chunk: 'c1' },
        });
        check('(c) thrown error + `on: [418]` → ok', r.ok, true);
        check('(c) attempts made', api.partPuts, 1);
        note(
            '(c) → `retry.on` gates STATUS retries only',
            'a throw retries while attempts remain, which is what makes the `execute` construction below retryable',
        );
    }

    // ── (d) WHOLE-UPLOAD retry: nothing prevents it, and it orphans the first UploadId ────────
    {
        const api = new FakeS3();
        api.failPart(3, Number.POSITIVE_INFINITY, 500);
        const upload = stitch({
            url: FakeS3.template,
            method: 'POST',
            kind: uploadSurface(api, [1, 2, 3, 4], { cleanup: false }),
            retry: NO_WAIT,
        });
        const r = await upload.safe({ params: { key: 'v.mp4' } });
        check('(d) upload → ok', r.ok, false);
        check('(d) `POST ?uploads` calls (attempts × 1)', api.initiated, 3);
        check('(d) part PUTs across all attempts', api.partPuts, 12);
        check('(d) DANGLING UploadIds', api.danglingUploads, 3);
        check('(d) ORPHANED PARTS', api.orphanParts, 9);
        check('(d) ORPHANED BYTES', api.orphanBytes, 45 * MiB);
        note(
            '(d) → whole-upload retry is not prevented; it MULTIPLIES the orphan',
            '3 attempts re-sent 12 parts and left 3 dangling UploadIds holding 45 MiB',
        );
    }

    // ── (e) the same construction with cleanup inside `execute` ───────────────────────────────
    // This is the shape C8 builds on: the retry is still whole-upload (still wasteful), but every
    // attempt cleans up after itself, so the orphan is zero at every exit.
    {
        const api = new FakeS3();
        api.failPart(3, Number.POSITIVE_INFINITY, 500);
        const upload = stitch({
            url: FakeS3.template,
            method: 'POST',
            kind: uploadSurface(api, [1, 2, 3, 4], { cleanup: true }),
            retry: NO_WAIT,
        });
        const r = await upload.safe({ params: { key: 'v.mp4' } });
        check('(e) upload → ok', r.ok, false);
        check('(e) `POST ?uploads` calls', api.initiated, 3);
        check('(e) DELETEs issued', api.aborted, 3);
        check('(e) ORPHANED PARTS', api.orphanParts, 0);
        check('(e) dangling UploadIds', api.danglingUploads, 0);
        note(
            '(e) → the retry is still the wrong granularity, but it is no longer a billing incident',
            'cleanup belongs INSIDE the unit the retry re-runs',
        );
    }

    // ── (f) the granularity that is actually wanted: retry per part, once, inside `execute` ───
    {
        const api = new FakeS3();
        api.failPart(3, 1, 500); // one transient blip
        const transport = api.adapter();
        const partStitch = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: transport,
            retry: { ...NO_WAIT, on: [429, 500, 502, 503, 504] },
        });
        const uploadId = await openUpload(api, 'v.mp4');
        const etags = await Promise.all(
            [1, 2, 3, 4].map(async (n) => ({
                PartNumber: n,
                ETag: (await partStitch({
                    params: { key: 'v.mp4' },
                    query: { partNumber: n, uploadId },
                    body: { chunk: `c${n}` },
                })) as string,
            })),
        );
        const complete = stitch({
            url: FakeS3.template,
            method: 'POST',
            adapter: transport,
        });
        const done = await complete.safe({
            params: { key: 'v.mp4' },
            query: { uploadId },
            body: { Parts: etags },
        });
        check('(f) `POST ?uploads` calls', api.initiated, 1);
        check('(f) part PUTs', api.partPuts, 5);
        check('(f) complete → ok', done.ok, true);
        check('(f) orphans', api.orphanParts, 0);
    }

    finish(
        'C5',
        "Per-part retry: PASS. Whole-upload retry: NOT PREVENTED, and it multiplies the orphan. Measured: one part failing 503 once, with `retry: { attempts: 3 }` on the part stitch, produced arrival order **[1,2,3,4,3]** — 5 PUTs, one `POST ?uploads`, complete ok, 0 orphans. Only part 3 was re-sent. THE TRAP: the default `retry.on` is `[429,502,503,504]` (engine.ts:612) and S3's own transient failure is `500 InternalError` — the identical config against a 500 measured **4 PUTs, 1 failed part, 3 orphans**; widening to `on: [429,500,502,503,504]` restored [1,2,3,4,3] and 0 failures. A THROWN transport error is retried regardless of `retry.on` (measured ok with `on: [418]`), which is what makes the outer construction retryable at all. Putting `retry: { attempts: 3 }` on a whole-upload stitch (`Surface.execute` running initiate→parts→complete) measured **3 `POST ?uploads`, 12 part PUTs, 3 dangling UploadIds, 9 orphaned parts, 45 MiB** — nothing in the library flags or prevents it. The same construction with the abort written INSIDE `execute` measured **3 initiates, 3 DELETEs, 0 orphans**: still the wrong retry granularity, but no longer a billing incident",
    );
}

void main();
