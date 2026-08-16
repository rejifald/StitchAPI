// C2 — the part's result is a RESPONSE HEADER. Which seam can capture it, and can N of them be
// assembled in PART order when they arrive in a different order?
//
// The fake makes part 3 land first (`partTicks`), and the server REJECTS a mis-ordered list with
// `400 InvalidPartOrder`, so "in part order, not completion order" is checked by the server rather
// than assumed by the proof. `completionOrder` reports what actually happened on the wire.
//
// Four seams are tried. The finding is that `interpret` is the right one and the ordinary result
// accessors are the wrong ones — `.safe()`, `await`, and `.inspect()` carry NO response headers at
// all (`Inspection` is `{data, raw, findings, status, error, source}` — types.ts:1736-1766), so a
// stitch whose surface does not lift the header has permanently lost it.
//
//   pnpm exec tsx docs/scenarios/proofs/multipart-upload/c2-etag-header.ts
import { stitch, verdictOf } from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import type {
    Adapter,
    AdapterResponse,
} from '../../../../packages/core/src/types';
import { FakeS3 } from './fake-s3';
import { check, checkSeq, finish, heading, note } from './harness';

/** The part surface: the stitch's DATA is the `ETag` response header. */
const partSurface: Surface = {
    id: 'multipart-part',
    // `verdictOf` first (surface.ts:174-191) — an `interpret` hook REPLACES the default verdict,
    // so a surface that forgets this turns a 500 into a success. Case (d) measures exactly that.
    interpret: (res, cfg) =>
        verdictOf(res, cfg) ?? { ok: true, data: res.headers['etag'] },
};

/** The same surface written the way it is easy to write it — no verdict. The footgun in (d). */
const naivePartSurface: Surface = {
    id: 'multipart-part-naive',
    interpret: (res) => ({ ok: true, data: res.headers['etag'] }),
};

/** Land part 3 first, then 1, then 4, then 2 — completion order ≠ part order, by construction. */
const OUT_OF_ORDER = { 3: 0, 1: 12, 4: 24, 2: 36 };

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
        'C2 — the ETag is a response header, and the list must be in part order',
    );

    // ── (a) which seams can see the header at all? ────────────────────────────────────────────
    {
        const api = new FakeS3();
        const uploadId = await openUpload(api, 'video.mp4');
        const seen: string[] = [];
        let fromExecute = '(none)';
        let fromHook = '(none)';

        const spyExecute: Adapter = async (req) => {
            const res: AdapterResponse = await api.adapter()(req);
            fromExecute = res.headers['etag'] ?? '(none)';
            return res;
        };

        const withInterpret = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
            hooks: {
                onResponse: (ctx) => {
                    fromHook = ctx.res?.headers['etag'] ?? '(none)';
                },
            },
        });
        const r = await withInterpret.safe({
            params: { key: 'video.mp4' },
            query: { partNumber: 1, uploadId },
            body: { chunk: 'a' },
        });
        seen.push(String(r.data));

        const withExecute = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: { id: 'exec-part', execute: spyExecute },
            adapter: api.adapter(),
        });
        await withExecute.safe({
            params: { key: 'video.mp4' },
            query: { partNumber: 2, uploadId },
            body: { chunk: 'b' },
        });

        check(
            '(a) `interpret` → the ETag IS the data',
            seen[0],
            `"${uploadId}-p1"`,
        );
        check(
            '(a) `hooks.onResponse` → ctx.res.headers.etag',
            fromHook,
            `"${uploadId}-p1"`,
        );
        check(
            '(a) `Surface.execute` → its own response',
            fromExecute,
            `"${uploadId}-p2"`,
        );
        note(
            '(a) → all three seams see it; they differ in where the value can GO',
            '`interpret` returns it as the value; the other two must write to a closure',
        );
    }

    // ── (b) and which seams CANNOT: the ordinary result accessors carry no headers ────────────
    {
        const api = new FakeS3();
        const uploadId = await openUpload(api, 'video.mp4');
        const plain = stitch({
            url: FakeS3.template,
            method: 'PUT',
            adapter: api.adapter(),
        });
        const r = await plain.safe({
            params: { key: 'video.mp4' },
            query: { partNumber: 1, uploadId },
            body: { chunk: 'a' },
        });
        const probe = await plain.inspect({
            params: { key: 'video.mp4' },
            query: { partNumber: 2, uploadId },
            body: { chunk: 'b' },
        });
        check('(b) a bare stitch → ok', r.ok, true);
        check('(b) a bare stitch → data (the part body)', r.data, undefined);
        check('(b) .inspect() → status', probe.status, 200);
        check('(b) .inspect() → raw (the part body)', probe.raw, null);
        checkSeq(
            '(b) header-bearing fields on Inspection',
            Object.keys(probe).filter((k) =>
                k.toLowerCase().includes('header'),
            ),
            [],
        );
        note(
            '(b) → a part upload SUCCEEDS and yields nothing usable',
            'no accessor on the awaited path exposes response headers — the surface/hook seam is the only way in',
        );
    }

    // ── (c) N parts, landing out of order, assembled in PART order ────────────────────────────
    {
        const api = new FakeS3({ partTicks: OUT_OF_ORDER });
        const uploadId = await openUpload(api, 'video.mp4');
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
        });
        const complete = stitch({
            url: FakeS3.template,
            method: 'POST',
            adapter: api.adapter(),
        });

        const nums = [1, 2, 3, 4];
        const etags = await Promise.all(
            nums.map(async (n) => ({
                PartNumber: n,
                ETag: (await part({
                    params: { key: 'video.mp4' },
                    query: { partNumber: n, uploadId },
                    body: { chunk: `part-${n}` },
                })) as string,
            })),
        );

        checkSeq(
            '(c) the order the SERVER stored parts in',
            api.completionOrder,
            [3, 1, 4, 2],
        );
        checkSeq(
            '(c) the order the ETags are held in (Promise.all preserves INPUT order)',
            etags.map((e) => e.PartNumber),
            [1, 2, 3, 4],
        );

        const done = await complete.safe({
            params: { key: 'video.mp4' },
            query: { uploadId },
            body: { Parts: etags },
        });
        check('(c) complete → ok', done.ok, true);
        check(
            '(c) assembled parts',
            (done.data as { Parts?: number }).Parts,
            4,
        );
        check('(c) orphaned parts after a clean run', api.orphanParts, 0);
        note(
            '(c) → `Promise.all` already does the ordering',
            'it resolves in INPUT order regardless of settle order — the sort most write by hand is redundant',
        );
    }

    // ── (d) the order really is checked: send COMPLETION order and watch it fail ──────────────
    {
        const api = new FakeS3({ partTicks: OUT_OF_ORDER });
        const uploadId = await openUpload(api, 'video.mp4');
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
        });
        const complete = stitch({
            url: FakeS3.template,
            method: 'POST',
            adapter: api.adapter(),
        });
        const collected: { PartNumber: number; ETag: string }[] = [];
        await Promise.all(
            [1, 2, 3, 4].map(async (n) => {
                const etag = (await part({
                    params: { key: 'video.mp4' },
                    query: { partNumber: n, uploadId },
                    body: { chunk: `part-${n}` },
                })) as string;
                collected.push({ PartNumber: n, ETag: etag }); // push order = COMPLETION order
            }),
        );
        checkSeq(
            '(d) collected in completion order',
            collected.map((c) => c.PartNumber),
            [3, 1, 4, 2],
        );
        const bad = await complete.safe({
            params: { key: 'video.mp4' },
            query: { uploadId },
            body: { Parts: collected },
        });
        check('(d) complete with that list → ok', bad.ok, false);
        check('(d) status', bad.error?.status, 400);
        // `.inspect().raw` is `null` on a failure (measured), so the server's error CODE is
        // reachable only through `StitchError.body` — worth knowing when the code IS the diagnosis.
        check(
            '(d) the server’s complaint (StitchError.body.Code)',
            (bad.error?.body as { Code?: string } | undefined)?.Code,
            'InvalidPartOrder',
        );
        check('(d) …and the parts are still sitting there', api.orphanParts, 4);
        note(
            '(d) → collecting in an `await` callback is the bug',
            'push-on-settle gives completion order; the fix is to return the value and let `Promise.all` order it',
        );
    }

    // ── (e) the interpret footgun: a surface that forgets `verdictOf` ─────────────────────────
    // `interpret` REPLACES the default verdict (surface.ts:57-64). A naive one turns a 500 into
    // `{ ok: true, data: undefined }` — the part upload "succeeds" carrying no ETag, and the
    // failure only surfaces two calls later as `InvalidPart`.
    {
        const api = new FakeS3();
        api.failPart(2);
        const uploadId = await openUpload(api, 'video.mp4');
        const naive = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: naivePartSurface,
            adapter: api.adapter(),
        });
        const r = await naive.safe({
            params: { key: 'video.mp4' },
            query: { partNumber: 2, uploadId },
            body: { chunk: 'b' },
        });
        check('(e) naive interpret + HTTP 500 → ok', r.ok, true);
        check('(e) naive interpret + HTTP 500 → data', r.data, undefined);

        const guarded = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: api.adapter(),
        });
        const g = await guarded.safe({
            params: { key: 'video.mp4' },
            query: { partNumber: 2, uploadId },
            body: { chunk: 'b' },
        });
        check('(e) `verdictOf` composed + HTTP 500 → ok', g.ok, false);
        check('(e) `verdictOf` composed → status', g.error?.status, 500);
        note(
            '(e) → `verdictOf(res, cfg) ?? …` is not optional boilerplate',
            'without it a failed part is indistinguishable from a successful one until `complete` rejects the list',
        );
    }

    finish(
        'C2',
        'PASS via `Surface.interpret`, and the ordinary accessors are a dead end. Measured: `interpret` returns the `etag` RESPONSE HEADER as the stitch\'s data (`"upl-1-p1"`); `hooks.onResponse` (`ctx.res.headers`) and `Surface.execute` both see it too, but can only write it to a closure. A BARE stitch on the same PUT measured `ok:true`/`data:undefined`, and `.inspect()` measured `status:200`/`raw:null` with ZERO header-bearing fields — `Inspection` (types.ts:1736-1766) carries no headers, so without a surface the ETag is unrecoverable. Ordering is measured against a server that checks it: with part 3 landing first (server-recorded `completionOrder` [3,1,4,2]) `Promise.all` still resolved in INPUT order [1,2,3,4] and `complete` returned the 4-part object with 0 orphans, while the SAME ETags pushed in settle order [3,1,4,2] were rejected `400 InvalidPartOrder` and left 4 parts orphaned. The footgun: `interpret` REPLACES the default verdict, so a surface that omits `verdictOf` turned an HTTP 500 part into `ok:true`/`data:undefined` (measured) — the failure then surfaces only at `complete`',
    );
}

void main();
