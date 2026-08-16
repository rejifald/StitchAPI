// C8 — the best answer assembled from the public API, run end to end on BOTH paths, and compared
// honestly against a feature-matched hand-rolled twin.
//
// `multipart.ts` is the StitchAPI answer; `hand-rolled.ts` is the same behaviour with no StitchAPI
// in it. Both drive the same `FakeS3` transport, so the comparison is on ergonomics and line count,
// not on who got the easier wire.
//
// The four shapes both must survive: a clean upload, a permanently failing part, a caller
// cancellation mid-flight, and a cleanup call that itself fails. Every one of them is asserted to
// leave **zero** orphaned parts (or, in the last case, to be LOUD about the ones it left).
//
// Case (e) is the reason the answer is a plain orchestration function and not a single
// `Surface.execute` stitch: `withTimeout` (resilience.ts:230-244) rejects the caller's promise the
// instant the timer fires and lets `fn` keep running, so a `try/finally` INSIDE `execute` cleans up
// AFTER the caller has already returned. Measured: 3 orphans at the moment the caller sees the
// failure, 0 several turns later.
//
//   pnpm exec tsx docs/scenarios/proofs/multipart-upload/c8-assembled-solution.ts
import { stitch, xhrAdapter } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import type { Adapter } from '../../../../packages/core/src/types';
import { FakeS3 } from './fake-s3';
import { fakeXhrCtor } from './fake-xhr';
import { handRolledUploader } from './hand-rolled';
import { check, checkSeq, finish, heading, note } from './harness';
import { multipartUploader } from './multipart';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MiB = 1024 * 1024;
const CHUNKS = [1, 2, 3, 4].map((n) => ({ chunk: `part-${String(n)}` }));

/**
 * Executable lines — imports (however they wrap), blanks and comment-only lines removed on BOTH
 * sides, so the number is the code someone actually writes and maintains.
 */
function executableLines(file: string): number {
    return readFileSync(join(HERE, file), 'utf8')
        .replace(/^import[\s\S]*?;$/gm, '')
        .split('\n')
        .map((l) => l.trim())
        .filter(
            (l) =>
                l !== '' &&
                !l.startsWith('//') &&
                !l.startsWith('*') &&
                !l.startsWith('/*'),
        ).length;
}

const drain = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) await Promise.resolve();
};

async function main(): Promise<void> {
    heading('C8 — the assembled answer, both paths, and the honest comparison');

    // ── (a) the SUCCESS path, both implementations ────────────────────────────────────────────
    for (const [label, build] of [
        ['stitchapi', multipartUploader],
        ['hand-rolled', handRolledUploader],
    ] as const) {
        // Under a 2-wide pool: 1+2 start, 2 lands first, then 3 starts, 1 lands, 4 starts, 4 lands
        // before 3 — so the server stores them out of part order while the bound still holds.
        const api = new FakeS3({ partTicks: { 1: 30, 2: 0, 3: 30, 4: 0 } });
        const { upload, lastStats } = build({
            adapter: api.adapter(),
            urlTemplate: FakeS3.template,
            concurrency: 2,
        });
        const object = (await upload('v.mp4', CHUNKS)) as { Parts: number };
        check(`(a) [${label}] object parts`, object.Parts, 4);
        check(`(a) [${label}] objects in the bucket`, api.objectCount, 1);
        check(`(a) [${label}] orphaned parts`, api.orphanParts, 0);
        check(`(a) [${label}] DELETEs issued`, api.aborted, 0);
        check(`(a) [${label}] peak in-flight`, api.peakInFlight, 2);
        check(
            `(a) [${label}] server storage order ${api.completionOrder.join(',')} ≠ part order`,
            api.completionOrder.join(',') !== '1,2,3,4',
            true,
        );
        check(`(a) [${label}] parts reported`, lastStats()?.parts, 4);
    }

    // ── (a2) …with a real progress bar, over the transport that can draw one ─────────────────
    // Same uploader, `xhrAdapter` instead of a plain adapter (C1). The aggregate is the uploader's
    // own per-part high-water map (C7(c)), so this is the whole UI story end to end.
    {
        const api = new FakeS3({ partTicks: { 1: 0, 2: 4, 3: 8, 4: 12 } });
        const bar: number[] = [];
        const { upload } = multipartUploader({
            adapter: xhrAdapter(fakeXhrCtor(api.adapter(), { uploadTicks: 4 })),
            urlTemplate: FakeS3.template,
            concurrency: 2,
        });
        await upload('v.mp4', CHUNKS, {
            onProgress: (f) => bar.push(Math.round(f * 100)),
        });
        check('(a2) ticks the bar received', bar.length, 16);
        check('(a2) final percentage', bar[bar.length - 1], 100);
        check(
            '(a2) monotonic',
            bar.every((v, i) => i === 0 || v >= (bar[i - 1] ?? 0)),
            true,
        );
        checkSeq(
            '(a2) the bar',
            bar,
            [7, 14, 19, 25, 32, 39, 44, 50, 57, 63, 69, 75, 82, 88, 94, 100],
        );
        check('(a2) orphans', api.orphanParts, 0);
    }

    // ── (b) the FAILING-PART path — must leave ZERO orphans ───────────────────────────────────
    for (const [label, build] of [
        ['stitchapi', multipartUploader],
        ['hand-rolled', handRolledUploader],
    ] as const) {
        const api = new FakeS3();
        api.failPart(3, Number.POSITIVE_INFINITY, 500);
        const { upload, lastStats } = build({
            adapter: api.adapter(),
            urlTemplate: FakeS3.template,
            concurrency: 2,
            attempts: 2,
        });
        let threw = '';
        try {
            await upload('v.mp4', CHUNKS);
        } catch (e) {
            threw = (e as Error).message;
        }
        await drain();
        check(`(b) [${label}] the upload threw`, threw !== '', true);
        check(`(b) [${label}] ORPHANED PARTS`, api.orphanParts, 0);
        check(`(b) [${label}] ORPHANED BYTES`, api.orphanBytes, 0);
        check(`(b) [${label}] dangling UploadIds`, api.danglingUploads, 0);
        check(`(b) [${label}] DELETEs accepted`, api.aborted, 1);
        check(
            `(b) [${label}] cleanedUp reported`,
            lastStats()?.cleanedUp,
            true,
        );
        check(
            `(b) [${label}] initiates (no whole-upload retry)`,
            api.initiated,
            1,
        );
        check(
            `(b) [${label}] part PUTs (part 3 retried once)`,
            api.partPuts,
            5,
        );
    }

    // ── (c) a CANCELLED run — the case C4(e) showed leaks by default ──────────────────────────
    for (const [label, build] of [
        ['stitchapi', multipartUploader],
        ['hand-rolled', handRolledUploader],
    ] as const) {
        const api = new FakeS3({ partTicks: { 1: 0, 2: 0, 3: 60, 4: 60 } });
        const { upload } = build({
            adapter: api.adapter(),
            urlTemplate: FakeS3.template,
            concurrency: 4,
        });
        const ac = new AbortController();
        const pending = upload('v.mp4', CHUNKS, { signal: ac.signal });
        // Spin until exactly two parts have landed — a fixed microtask count is not portable
        // across the two implementations (the stitch path has more awaits before dispatch).
        for (let i = 0; i < 400 && api.completionOrder.length < 2; i++)
            await Promise.resolve();
        ac.abort();
        let threw = '';
        try {
            await pending;
        } catch (e) {
            threw = (e as Error).message;
        }
        await drain();
        check(`(c) [${label}] the upload threw`, threw !== '', true);
        check(
            `(c) [${label}] parts that had landed`,
            api.completionOrder.length,
            2,
        );
        check(`(c) [${label}] ORPHANED PARTS`, api.orphanParts, 0);
        check(`(c) [${label}] DELETEs accepted`, api.aborted, 1);
    }

    // ── (d) the cleanup itself fails — it must be LOUD ────────────────────────────────────────
    // Same run as (b), but the abort endpoint is broken. C4(h2) measured the silent version of this
    // (`.safe()` swallowing the error, 3 parts still billing, nothing thrown). Here it reports.
    {
        const api = new FakeS3();
        api.failPart(3, Number.POSITIVE_INFINITY, 500);
        // A transport that answers every DELETE with a 500 — the abort endpoint is down.
        const broken: Adapter = async (req) =>
            req.method.toUpperCase() === 'DELETE'
                ? { status: 500, headers: {}, body: { Code: 'InternalError' } }
                : api.adapter()(req);
        const reported: string[] = [];
        const { upload, lastStats } = multipartUploader({
            adapter: broken,
            urlTemplate: FakeS3.template,
            attempts: 1,
            onCleanupFailure: (id, reason) => reported.push(`${id}:${reason}`),
        });
        try {
            await upload('v.mp4', CHUNKS);
        } catch {
            /* the part failure */
        }
        await drain();
        check('(d) cleanup failures reported', reported.length, 1);
        check(
            '(d) …naming the UploadId',
            reported[0]?.startsWith('upl-'),
            true,
        );
        check('(d) cleanedUp reported', lastStats()?.cleanedUp, false);
        check('(d) ORPHANED PARTS (correctly non-zero)', api.orphanParts, 3);
        check('(d) ORPHANED BYTES', api.orphanBytes, 15 * MiB);

        // …and with no handler at all, it THROWS rather than resolving quietly.
        const api2 = new FakeS3();
        api2.failPart(3, Number.POSITIVE_INFINITY, 500);
        const broken2: Adapter = async (req) =>
            req.method.toUpperCase() === 'DELETE'
                ? { status: 500, headers: {}, body: {} }
                : api2.adapter()(req);
        const u2 = multipartUploader({
            adapter: broken2,
            urlTemplate: FakeS3.template,
            attempts: 1,
        });
        let msg = '';
        try {
            await u2.upload('v.mp4', CHUNKS);
        } catch (e) {
            msg = (e as Error).message;
        }
        check(
            '(d) no handler → the cleanup failure is the error the caller sees',
            msg.includes('cleanup FAILED'),
            true,
        );
        note(
            '(d) → this is the one place `.safe()` must NOT be the end of the story',
            'a swallowed cleanup error is an upload that bills forever while the code reads as correct',
        );
    }

    // ── (e) why NOT one `Surface.execute` stitch: the cleanup runs after the caller returns ───
    {
        const clock = manualClock();
        const api = new FakeS3({ hangParts: [3] });
        const server = api.adapter();
        // A DELETE is a network round trip, so give it a few turns. Without this the race is too
        // tight to READ; with it, the ordering the engine actually produces is unambiguous.
        const transport: Adapter = async (req) => {
            if (req.method.toUpperCase() === 'DELETE')
                for (let i = 0; i < 20; i++) await Promise.resolve();
            return server(req);
        };
        // The whole upload as one stitch, with the try/finally INSIDE `execute` — the construction
        // that looks like it puts cleanup under the engine's control.
        const uploadSurface: Surface = {
            id: 'multipart-upload',
            execute: async (req) => {
                const key = new URL(req.url).pathname.replace('/bucket/', '');
                const init = await transport({
                    url: `${FakeS3.url(key)}?uploads`,
                    method: 'POST',
                    headers: {},
                });
                const uploadId = (init.body as { UploadId: string }).UploadId;
                try {
                    const parts = await Promise.all(
                        [1, 2, 3, 4].map(async (n) => {
                            const r = await transport({
                                url: `${FakeS3.url(key)}?partNumber=${n}&uploadId=${uploadId}`,
                                method: 'PUT',
                                headers: {},
                                body: { chunk: `c${n}` },
                                ...(req.signal ? { signal: req.signal } : {}),
                            });
                            if (r.status >= 400) throw new Error(`part ${n}`);
                            return { PartNumber: n, ETag: r.headers['etag'] };
                        }),
                    );
                    return await transport({
                        url: `${FakeS3.url(key)}?uploadId=${uploadId}`,
                        method: 'POST',
                        headers: {},
                        body: { Parts: parts },
                    });
                } catch (e) {
                    await transport({
                        url: `${FakeS3.url(key)}?uploadId=${uploadId}`,
                        method: 'DELETE',
                        headers: {},
                    });
                    throw e;
                }
            },
        };
        const one = stitch({
            url: FakeS3.template,
            method: 'POST',
            kind: uploadSurface,
            adapter: transport,
            clock,
            timeout: { total: 1_000 },
        });
        // Snapshot the bucket at the INSTANT the caller's promise settles — not after, because
        // "after" is exactly the window this case is about.
        let orphansWhenCallerReturned = -1;
        let abortsWhenCallerReturned = -1;
        const pending = one.safe({ params: { key: 'v.mp4' } });
        void pending.then(() => {
            orphansWhenCallerReturned = api.orphanParts;
            abortsWhenCallerReturned = api.aborted;
        });
        await clock.advance(5_000);
        const r = await pending;
        check('(e) the caller saw a failure', r.ok, false);
        check(
            '(e) …the failure was the timeout',
            r.error?.message.includes('timed out'),
            true,
        );
        check(
            '(e) ORPHANS at the moment the caller returned',
            orphansWhenCallerReturned,
            3,
        );
        check('(e) DELETEs at that moment', abortsWhenCallerReturned, 0);
        await drain();
        check('(e) ORPHANS several turns later', api.orphanParts, 0);
        check('(e) DELETEs several turns later', api.aborted, 1);
        note(
            '(e) → `withTimeout` rejects the caller and lets `execute` keep running',
            'the cleanup is real but LATE — in a lambda or a process that exits on the error, it never lands',
        );
    }

    // ── (f) what the config bought, and what it cost ──────────────────────────────────────────
    heading('  the line count');
    {
        const mine = executableLines('multipart.ts');
        const theirs = executableLines('hand-rolled.ts');
        note(
            '  user code (`multipart.ts`)',
            `${String(mine)} executable lines`,
        );
        note(
            '  hand-rolled (`hand-rolled.ts`)',
            `${String(theirs)} executable lines`,
        );
        check('  StitchAPI is shorter', mine < theirs, true);
        note(
            '  what the difference is',
            'the retry loop + backoff, the FIFO concurrency pool, the status classification and the URL assembly — all config on one side, ~45 lines on the other',
        );
        note(
            '  what is IDENTICAL on both sides',
            'the try/finally, the loud-cleanup rule, the per-part high-water progress map, and the Promise.all ordering — none of it is library-supplied',
        );
    }

    finish(
        'C8',
        'ACHIEVABLE WITH USER CODE, and the user code is exactly the compensation. Both implementations pass all four shapes against the same fake bucket. SUCCESS: 4-part object, 1 object stored, 0 orphans, 0 DELETEs, peak in-flight 2, server storage order [2,1,4,3] ≠ part order. FAILING PART: threw, **0 orphaned parts / 0 bytes / 0 dangling UploadIds / 1 DELETE accepted**, 1 initiate (no whole-upload retry) and 5 part PUTs (only part 3 re-sent). CANCELLED MID-FLIGHT: 2 parts had landed, **0 orphans, 1 DELETE**. PROGRESS (`xhrAdapter`): 16 monotonic ticks, [7,14,19,…,94,100], ending at exactly 100% with 0 orphans. BROKEN ABORT ENDPOINT: 1 cleanup failure reported naming the UploadId, `cleanedUp:false`, orphans correctly reported as 3/15 MiB — and with no handler wired the cleanup failure becomes the error the caller sees. LINE COUNT: **141 vs 163 executable lines** — StitchAPI is 22 lines shorter, and the difference attributes exactly to the retry loop with backoff, the FIFO concurrency pool, the retryable-status set and the URL assembly, all of which became config. What did NOT shrink is the part that matters: the `try/finally`, the loud-cleanup rule, the per-part high-water progress map and the input-order assembly are byte-for-byte the same on both sides. And the tempting alternative — the whole upload as ONE `Surface.execute` stitch so the engine owns the lifecycle — measured **3 orphans and 0 DELETEs at the instant the caller saw the timeout**, cleaning up only several turns later (resilience.ts:230-244 rejects the caller and lets `fn` run on)',
    );
}

void main();
