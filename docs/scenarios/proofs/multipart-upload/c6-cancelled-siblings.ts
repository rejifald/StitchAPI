// C6 — when `all()` auto-cancels the siblings after one part fails, what happens to the parts that
// ALREADY LANDED? Are their ETags still reachable for the abort, or lost?
//
// Two different quantities, both counted by the server / the client:
//
//   - **stored server-side** — parts sitting in the bucket under the UploadId. These are billed.
//   - **nameable client-side** — parts whose ETag the client can still produce.
//
// `all()` rejects with the FIRST error and discards the resolved values of the members that
// succeeded (it is `Promise.all`, pipe.ts:133), so the second number is ZERO by default while the
// first is not. That gap is why "the parts that already landed still need the abort" is a real
// concern rather than a theoretical one — and it is why a resumable upload (re-using the landed
// parts instead of discarding them) is impossible without a side channel.
//
// pipe.ts:20 is explicit that there is no `allSettled` variant: "for that, compose `.safe()` members
// by hand".
//
//   pnpm exec tsx docs/scenarios/proofs/multipart-upload/c6-cancelled-siblings.ts
import { stitch, verdictOf } from '../../../../packages/core/src/index';
import * as pipe from '../../../../packages/core/src/pipe';
import { all } from '../../../../packages/core/src/pipe';
import type { Surface } from '../../../../packages/core/src/surface';
import type { Stitch } from '../../../../packages/core/src/types';
import { FakeS3 } from './fake-s3';
import { check, checkSeq, finish, heading, note } from './harness';

const partSurface: Surface = {
    id: 'multipart-part',
    interpret: (res, cfg) =>
        verdictOf(res, cfg) ?? { ok: true, data: res.headers['etag'] },
};

/** Parts 1 and 2 land immediately; part 3 fails at tick 10; part 4 is still in flight. */
const TIMING = { 1: 0, 2: 0, 3: 10, 4: 40 };

/**
 * Spin the microtask queue so a cancelled member's handler finishes before anything is counted.
 * `all()` rejects the moment part 3 fails — part 4's request is still inside the server when
 * control returns, so measuring immediately reports 3 hits and misses the cancellation itself.
 */
const drain = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) await Promise.resolve();
};

async function openUpload(api: FakeS3, key: string): Promise<string> {
    const res = await api.adapter()({
        url: `${FakeS3.url(key)}?uploads`,
        method: 'POST',
        headers: {},
    });
    return (res.body as { UploadId: string }).UploadId;
}

/** N part stitches with the part number baked into the URL — what `all()` requires (C3(c)). */
function members(
    api: FakeS3,
    uploadId: string,
    onEtag?: (n: number, etag: string) => void,
): Stitch[] {
    return [1, 2, 3, 4].map(
        (n) =>
            stitch({
                url: `${FakeS3.template}?partNumber=${n}&uploadId=${uploadId}`,
                method: 'PUT',
                kind: partSurface,
                adapter: api.adapter(),
                ...(onEtag
                    ? {
                          hooks: {
                              onResponse: (ctx) => {
                                  const etag = ctx.res?.headers['etag'];
                                  if (etag && ctx.res && ctx.res.status < 400)
                                      onEtag(n, etag);
                              },
                          },
                      }
                    : {}),
            }) as Stitch,
    );
}

async function main(): Promise<void> {
    heading('C6 — the parts that landed before the fan was cancelled');

    // ── (a) the default: stored ≠ nameable ────────────────────────────────────────────────────
    {
        const api = new FakeS3({ partTicks: TIMING });
        api.failPart(3, Number.POSITIVE_INFINITY, 500);
        const uploadId = await openUpload(api, 'v.mp4');
        let nameable = 0;
        let caught = '';
        try {
            const values = (await all(members(api, uploadId))({
                params: { key: 'v.mp4' },
                body: { chunk: 'c' },
            })) as unknown[];
            nameable = values.length;
        } catch (e) {
            caught = (e as Error).message;
        }
        await drain();
        check('(a) all() rejected', caught !== '', true);
        check('(a) parts STORED server-side', api.storedParts(uploadId), 2);
        check('(a) parts the client can NAME', nameable, 0);
        check('(a) part PUTs that reached the server', api.partPuts, 4);
        checkSeq(
            '(a) …their statuses',
            api.hits.filter((h) => h.op === 'part').map((h) => h.status),
            [200, 200, 500, 499],
        );
        check('(a) orphaned parts', api.orphanParts, 2);
        note(
            '(a) → the auto-cancel WORKS (part 4 was cut off, status 499) and is not cleanup',
            '2 parts are in the bucket and the client holds zero of their ETags',
        );
    }

    // ── (b) a side channel recovers them ──────────────────────────────────────────────────────
    // `hooks.onResponse` writes each ETag into a Map as it arrives, so the values survive the
    // rejection. This is the shape any resumable/partial-retry design needs.
    {
        const api = new FakeS3({ partTicks: TIMING });
        api.failPart(3, Number.POSITIVE_INFINITY, 500);
        const uploadId = await openUpload(api, 'v.mp4');
        const landed = new Map<number, string>();
        try {
            await all(members(api, uploadId, (n, e) => landed.set(n, e)))({
                params: { key: 'v.mp4' },
                body: { chunk: 'c' },
            });
        } catch {
            /* expected */
        }
        await drain();
        checkSeq(
            '(b) ETags recovered from the side channel',
            [...landed.keys()].sort((x, y) => x - y),
            [1, 2],
        );
        check(
            '(b) …and they match what the server stored',
            landed.get(1),
            `"${uploadId}-p1"`,
        );
        check('(b) stored server-side', api.storedParts(uploadId), 2);
        note(
            '(b) → the fix is a closure, not a config field',
            'nothing in `all()` hands back partial results; `hooks.onResponse` is the only place to catch them',
        );
    }

    // ── (c) there is no `allSettled`, and that is on purpose ──────────────────────────────────
    {
        const combinators = Object.keys(pipe).filter(
            (k) => typeof (pipe as Record<string, unknown>)[k] === 'function',
        );
        // Note the subpath is named `pipe` and there is no `pipe()` combinator in it.
        checkSeq('(c) exported combinators', combinators.sort(), [
            'all',
            'any',
            'linked',
            'race',
        ]);
        check(
            '(c) an `allSettled` combinator exists',
            combinators.includes('allSettled'),
            false,
        );
        note(
            '(c) → pipe.ts:20 says so outright',
            '"There is deliberately NO `allSettled` (best-effort) variant; for that, compose `.safe()` members by hand"',
        );
    }

    // ── (d) `.safe()` members: every value survives, and so does the auto-cancel loss ─────────
    // Composing `.safe()` by hand keeps the successes — but a `.safe()` member never REJECTS, so
    // `all()` never cancels anything. You trade the loss of partial results for the loss of
    // fail-fast. Measured: 4 parts land instead of 2.
    {
        const api = new FakeS3({ partTicks: TIMING });
        api.failPart(3, Number.POSITIVE_INFINITY, 500);
        const uploadId = await openUpload(api, 'v.mp4');
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
        });
        const settled = await Promise.all(
            [1, 2, 3, 4].map((n) =>
                part.safe({
                    params: { key: 'v.mp4' },
                    query: { partNumber: n, uploadId },
                    body: { chunk: `c${n}` },
                }),
            ),
        );
        check(
            '(d) .safe() members → results the client holds',
            settled.filter((r) => r.ok).length,
            3,
        );
        check('(d) parts STORED server-side', api.storedParts(uploadId), 3);
        checkSeq(
            '(d) statuses the server saw',
            api.hits.filter((h) => h.op === 'part').map((h) => h.status),
            [200, 200, 500, 200],
        );
        note(
            '(d) → part 4 was NOT cancelled: it uploaded in full after part 3 had already failed',
            'on a real 5 GB upload that is megabytes sent for an upload that is already doomed',
        );
    }

    // ── (e) the practical consequence: with the ETags in hand, the abort still needs the ID ───
    // Cancellation loses the values; it never loses the UploadId, because the UploadId is a plain
    // variable in the orchestration. That asymmetry is the whole reason a `try/finally` works at
    // all — and the reason nothing smaller than the orchestration can do the cleanup.
    {
        const api = new FakeS3({ partTicks: TIMING });
        api.failPart(3, Number.POSITIVE_INFINITY, 500);
        const uploadId = await openUpload(api, 'v.mp4');
        const abort = stitch({
            url: FakeS3.template,
            method: 'DELETE',
            adapter: api.adapter(),
        });
        try {
            await all(members(api, uploadId))({
                params: { key: 'v.mp4' },
                body: { chunk: 'c' },
            });
        } catch {
            await abort({ params: { key: 'v.mp4' }, query: { uploadId } });
        }
        await drain();
        check('(e) DELETEs accepted', api.aborted, 1);
        check('(e) orphaned parts', api.orphanParts, 0);
        check('(e) upload status', api.statusOf(uploadId), 'aborted');
    }

    finish(
        'C6',
        'The auto-cancel works and it is NOT cleanup — the two counts diverge. Measured with parts 1-2 landing, part 3 failing 500, part 4 still in flight: the server saw statuses **[200,200,500,499]** (part 4 genuinely cut off by the group signal), **2 parts stored**, **2 orphaned** — and the client could name **0** of their ETags, because `all()` is `Promise.all` (pipe.ts:133) and discards resolved values on rejection. A `hooks.onResponse` side channel recovered exactly **[1,2]** with byte-exact ETags, which is the only way partial results survive. There is no `allSettled`: the pipe subpath exports exactly ["all","any","linked","race"] (there is no `pipe()` combinator in it either) and pipe.ts:20 says the omission is deliberate. Composing `.safe()` members instead keeps every value (**3 of 4 ok**) but disables the fail-fast — measured statuses **[200,200,500,200]**, i.e. part 4 uploaded in full into an upload that was already doomed. The UploadId, unlike the ETags, is never lost: it is a plain variable in the orchestration, which is why a `try/finally` at that level cleans up (measured 1 DELETE, 0 orphans, status `aborted`) and nothing narrower can',
    );
}

void main();
