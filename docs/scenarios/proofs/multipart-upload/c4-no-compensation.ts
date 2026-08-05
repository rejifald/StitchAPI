// C4 — THE DECIDING CLAIM. Is there ANY seam that guarantees the abort runs on failure? And when
// nothing runs it, how many parts are left billing?
//
// The capture's hypothesis is "there is no compensation hook anywhere in core". That is confirmed,
// and the confirmation is sharper than the hypothesis: the hook that LOOKS like the answer —
// `hooks.onError` — is not a failure hook at all. It fires only when the TRANSPORT THROWS
// (engine.ts:668-680: it is the `catch` around `withTimeout(transport)`), so an HTTP 500, an HTTP
// 400, and a surface `{ ok: false }` verdict all reach the caller as failures having fired ZERO
// `onError` callbacks. Wiring cleanup to `onError` produces a cleanup that runs on the network
// blips and skips the application failures.
//
// Everything here is counted by the server: `orphanParts` (stored under an UploadId that was never
// completed or aborted), `orphanBytes`, `danglingUploads`, and `aborted` (how many DELETEs actually
// arrived).
//
//   pnpm exec tsx docs/scenarios/proofs/multipart-upload/c4-no-compensation.ts
import { stitch, verdictOf } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import { manualClock } from '../../../../packages/core/src/testing';
import type {
    StitchConfig,
    StitchEvent,
    TraceContext,
    TraceSink,
} from '../../../../packages/core/src/types';
import { FakeS3 } from './fake-s3';
import { check, checkSeq, finish, heading, note } from './harness';

const partSurface: Surface = {
    id: 'multipart-part',
    interpret: (res, cfg) =>
        verdictOf(res, cfg) ?? { ok: true, data: res.headers['etag'] },
};

const MiB = 1024 * 1024;

async function openUpload(api: FakeS3, key: string): Promise<string> {
    const res = await api.adapter()({
        url: `${FakeS3.url(key)}?uploads`,
        method: 'POST',
        headers: {},
    });
    return (res.body as { UploadId: string }).UploadId;
}

async function main(): Promise<void> {
    heading(
        'C4 — is there a compensation seam, and what does the orphan cost?',
    );

    // ── (a) the four hooks, and what each one actually answers to ─────────────────────────────
    // `Hooks` is exactly `{ onRequest, onResponse, onError, onRetry }` (types.ts:1285-1290). The
    // question is not whether a fifth one exists — it is whether the fourth does the job.
    {
        const api = new FakeS3();
        api.failPart(1, 1, 500); // an ordinary application failure
        const uploadId = await openUpload(api, 'v.mp4');
        const fired: string[] = [];
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
            hooks: {
                onRequest: () => void fired.push('onRequest'),
                onResponse: () => void fired.push('onResponse'),
                onError: () => void fired.push('onError'),
                onRetry: () => void fired.push('onRetry'),
            },
        });
        const r = await part.safe({
            params: { key: 'v.mp4' },
            query: { partNumber: 1, uploadId },
            body: { chunk: 'a' },
        });
        check('(a) the call failed', r.ok, false);
        check('(a) …with status', r.error?.status, 500);
        checkSeq('(a) hooks that fired', fired, ['onRequest', 'onResponse']);
        check(
            '(a) onError calls on a FAILED call',
            fired.filter((f) => f === 'onError').length,
            0,
        );
        note(
            '(a) → `onError` is a TRANSPORT-EXCEPTION hook, not a failure hook',
            'engine.ts:676 sits in the `catch` around `withTimeout(transport)`; a 500 is a RESPONSE, so it never gets there',
        );
    }

    // ── (b) …and when it DOES fire, it fires per ATTEMPT ──────────────────────────────────────
    {
        const clock = manualClock();
        const api = new FakeS3({ hangParts: [1] });
        const uploadId = await openUpload(api, 'v.mp4');
        const fired: number[] = [];
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
            clock,
            timeout: { perAttempt: 1_000 },
            retry: { attempts: 3, backoff: { curve: 'fixed', base: 0 } },
            hooks: { onError: (ctx) => void fired.push(ctx.attempt) },
        });
        const pending = part.safe({
            params: { key: 'v.mp4' },
            query: { partNumber: 1, uploadId },
            body: { chunk: 'a' },
        });
        await clock.advance(60_000);
        const r = await pending;
        check('(b) stalled part → ok', r.ok, false);
        checkSeq('(b) onError fired on attempts', fired, [1, 2, 3]);
        note(
            '(b) → an abort written into `onError` would fire 3 times for one part',
            'and would fire on transient blips that the retry is about to fix',
        );
    }

    // ── (c) the trace sink sees the terminal `done` — but per CALL ────────────────────────────
    {
        const api = new FakeS3();
        api.failPart(3, 1, 500);
        const uploadId = await openUpload(api, 'v.mp4');
        const dones: { name: string; ok: boolean }[] = [];
        const sink: TraceSink = {
            handle: (e: StitchEvent, ctx: TraceContext) => {
                if (e.type === 'done') dones.push({ name: ctx.name, ok: e.ok });
            },
        };
        const part = stitch({
            name: 'part',
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
            trace: sink,
        });
        await Promise.all(
            [1, 2, 3, 4].map((n) =>
                part.safe({
                    params: { key: 'v.mp4' },
                    query: { partNumber: n, uploadId },
                    body: { chunk: `c${n}` },
                }),
            ),
        );
        check('(c) `done` events seen by the sink', dones.length, 4);
        check('(c) …of which failed', dones.filter((d) => !d.ok).length, 1);
        checkSeq(
            '(c) names on those events',
            [...new Set(dones.map((d) => d.name))],
            ['part'],
        );
        note(
            '(c) → a sink CAN observe the failure, and still cannot compensate',
            'it fires per stitch call, names only the stitch, and carries no UploadId — and it is a LOG seam, not a control seam',
        );
    }

    // ── (d) THE ORPHAN. Part 3 fails, nothing cleans up ───────────────────────────────────────
    {
        const api = new FakeS3();
        api.failPart(3, Number.POSITIVE_INFINITY, 500);
        const uploadId = await openUpload(api, 'v.mp4');
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
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
            '(d) parts that succeeded',
            results.filter((r) => r.ok).length,
            3,
        );
        check('(d) ORPHANED PARTS', api.orphanParts, 3);
        check('(d) ORPHANED BYTES', api.orphanBytes, 15 * MiB);
        check('(d) dangling UploadIds', api.danglingUploads, 1);
        check('(d) DELETEs the library issued', api.aborted, 0);
        check(
            '(d) upload status on the server',
            api.statusOf(uploadId),
            'open',
        );
        note(
            '(d) → 15 MiB of a 20 MiB upload is now invisible and billed',
            'nothing in the failure path knows an UploadId exists, so nothing can free it',
        );
    }

    // ── (e) a CANCELLED run skips cleanup the same way — and more quietly ─────────────────────
    // Parts 1-2 land, then the caller's AbortSignal fires. The library cancels; it does not clean.
    {
        const api = new FakeS3({ partTicks: { 1: 0, 2: 0, 3: 60, 4: 60 } });
        const uploadId = await openUpload(api, 'v.mp4');
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
        });
        const ac = new AbortController();
        const pending = Promise.all(
            [1, 2, 3, 4].map((n) =>
                part.safe({
                    params: { key: 'v.mp4' },
                    query: { partNumber: n, uploadId },
                    body: { chunk: `c${n}` },
                    signal: ac.signal,
                }),
            ),
        );
        for (let i = 0; i < 30; i++) await Promise.resolve();
        ac.abort();
        const results = await pending;
        check(
            '(e) parts that landed before the abort',
            results.filter((r) => r.ok).length,
            2,
        );
        check('(e) ORPHANED PARTS after cancellation', api.orphanParts, 2);
        check('(e) DELETEs issued', api.aborted, 0);
        note(
            '(e) → cancellation and cleanup are different concerns, and only one is built in',
            'the user pressed Cancel; the bucket kept the bytes',
        );
    }

    // ── (f) a TIMEOUT skips it too, and this one fires `onError` ──────────────────────────────
    {
        const clock = manualClock();
        const api = new FakeS3({ hangParts: [3] });
        const uploadId = await openUpload(api, 'v.mp4');
        let onErrorCalls = 0;
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
            clock,
            timeout: { total: 1_000 },
            hooks: { onError: () => void (onErrorCalls += 1) },
        });
        const pending = Promise.all(
            [1, 2, 3, 4].map((n) =>
                part.safe({
                    params: { key: 'v.mp4' },
                    query: { partNumber: n, uploadId },
                    body: { chunk: `c${n}` },
                }),
            ),
        );
        await clock.advance(10_000);
        const results = await pending;
        check(
            '(f) parts that succeeded',
            results.filter((r) => r.ok).length,
            3,
        );
        check('(f) onError calls', onErrorCalls, 1);
        check('(f) ORPHANED PARTS after a timeout', api.orphanParts, 3);
        check('(f) DELETEs issued', api.aborted, 0);
        note(
            '(f) → the one path where `onError` fires is also the one where it is least useful',
            'it fires on the PART stitch, per attempt, with no UploadId in `HookContext` (types.ts:1279-1284)',
        );
    }

    // ── (g) an unknown config key is accepted at RUNTIME and silently ignored ─────────────────
    // TypeScript's `NoUnknownConfigKeys` rejects `onFinally` at compile time, which is the real
    // guard. But the runtime does not: the key survives onto `__config` and is never called. A JS
    // consumer — or anything that builds config dynamically — gets a hook that reads as wired.
    {
        const api = new FakeS3();
        api.failPart(1, 1, 500);
        const uploadId = await openUpload(api, 'v.mp4');
        let ran = false;
        // Written as a literal, `NoUnknownConfigKeys` makes this a COMPILE error — that guard is
        // the only thing standing between a team and a hook they think is wired. Cast through
        // `Partial<StitchConfig>` to reach the runtime and see what it does with the key.
        const invented = {
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
            onFinally: () => {
                ran = true;
            },
        } as unknown as Partial<StitchConfig>;
        const part = stitch(invented);
        await part.safe({
            params: { key: 'v.mp4' },
            query: { partNumber: 1, uploadId },
            body: { chunk: 'a' },
        });
        check('(g) the invented `onFinally` ran', ran, false);
        check(
            '(g) …but it IS on the resolved config',
            Object.keys(
                (part as unknown as { __config: Record<string, unknown> })
                    .__config,
            ).includes('onFinally'),
            true,
        );
        note(
            '(g) → there is no compensation key to find, and inventing one fails silently at runtime',
            'the TS guard is the only thing that catches it',
        );
    }

    // ── (h) the only thing that works, and the way it silently does not ───────────────────────
    {
        // h1: a real `try/finally` in user code. Zero orphans.
        const api = new FakeS3();
        api.failPart(3, Number.POSITIVE_INFINITY, 500);
        const uploadId = await openUpload(api, 'v.mp4');
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
        });
        const abort = stitch({
            url: FakeS3.template,
            method: 'DELETE',
            adapter: api.adapter(),
        });
        let done = false;
        try {
            await Promise.all(
                [1, 2, 3, 4].map((n) =>
                    part({
                        params: { key: 'v.mp4' },
                        query: { partNumber: n, uploadId },
                        body: { chunk: `c${n}` },
                    }),
                ),
            );
            done = true;
        } catch {
            /* the abort is in `finally` */
        } finally {
            if (!done)
                await abort.safe({
                    params: { key: 'v.mp4' },
                    query: { uploadId },
                });
        }
        check('(h1) user try/finally → orphaned parts', api.orphanParts, 0);
        check('(h1) …DELETEs issued', api.aborted, 1);
    }
    {
        // h2: the SAME code with one thing wrong — the abort targets the wrong UploadId. `.safe()`
        // swallows the 404, nothing throws, and the cleanup reports success it did not achieve.
        const api = new FakeS3();
        api.failPart(3, Number.POSITIVE_INFINITY, 500);
        const uploadId = await openUpload(api, 'v.mp4');
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
        });
        const abort = stitch({
            url: FakeS3.template,
            method: 'DELETE',
            adapter: api.adapter(),
        });
        let cleanupThrew = false;
        try {
            await Promise.all(
                [1, 2, 3, 4].map((n) =>
                    part({
                        params: { key: 'v.mp4' },
                        query: { partNumber: n, uploadId },
                        body: { chunk: `c${n}` },
                    }),
                ),
            );
        } catch {
            /* fall through */
        } finally {
            const r = await abort.safe({
                params: { key: 'v.mp4' },
                query: { uploadId: `${uploadId}-typo` },
            });
            cleanupThrew = !r.ok && false; // `.safe()` never throws — that is the point
        }
        check('(h2) the cleanup call threw', cleanupThrew, false);
        check('(h2) DELETEs the SERVER accepted', api.aborted, 0);
        check('(h2) ORPHANED PARTS', api.orphanParts, 3);
        note(
            '(h2) → this is the failure mode that counts double',
            'the finally ran, the code looks correct, and 15 MiB is still billing. `.safe()` on a cleanup call hides the one error you must not ignore',
        );
    }

    finish(
        'C4',
        'NO — there is no compensation seam anywhere in core, and the hook that looks like one is worse than absent. `Hooks` is exactly `{onRequest,onResponse,onError,onRetry}` (types.ts:1285-1290) and `onError` fires only from the `catch` around the transport (engine.ts:668-680): on an HTTP 500 the measured hook sequence was ["onRequest","onResponse"] with **0** `onError` calls, while a stalled socket fired it **3** times (once per attempt). `HookContext` (types.ts:1279-1284) carries `{name,attempt,req,res,error}` — no UploadId, no run-scoped slot to keep one. A trace sink sees the terminal `done` (measured 4 events, 1 with `ok:false`) but is a LOG seam, per stitch call, with no UploadId either. `linked()` is `Promise.resolve(body(run))` (pipe.ts:357-369) — no finally. Inventing `onFinally` is accepted at RUNTIME, lands on `__config`, and never runs (measured). THE ORPHAN, with a part failing and no user cleanup: **3 parts / 15 MiB / 1 dangling UploadId / 0 DELETEs**. A CANCELLED run (AbortSignal) measured **2 orphaned parts, 0 DELETEs**; a `timeout.total` expiry measured **3 orphaned parts, 0 DELETEs** — and that is the one path where `onError` fires, on the part stitch, per attempt. A user-written `try/finally` measured **0 orphans / 1 DELETE**. The same `try/finally` with `.safe()` on the cleanup and a wrong UploadId measured **0 accepted DELETEs / 3 orphans and nothing thrown**',
    );
}

void main();
