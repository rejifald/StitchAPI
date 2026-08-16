// C3 — can the part fan be bounded, and by what? The number reported is `peakInFlight`, which the
// FAKE SERVER increments on entry and decrements on exit. Nothing here is inferred from the config.
//
// Eight parts, each stalled long enough that an unbounded fan is unambiguously eight-wide.
//
// Two findings sit in here that the capture does not anticipate:
//
//   1. `all()` bounds NOTHING. `runAllArray` is `members.map(...)` into `Promise.all`
//      (pipe.ts:122-136) — every member starts in the same turn. It is a fail-fast + auto-cancel +
//      child-run combinator, not a pool.
//   2. `all()` hands EVERY member the SAME `StitchInput` (`{...input, signal}`, pipe.ts:75-76). A
//      fan over N parts needs N part numbers, so it needs N pre-built stitches — and N stitches
//      means N SEPARATE throttle buckets, because the default `pool: 'stitch'` gives each stitch
//      its own state map (resilience.ts:103-109). So the two features do not compose: the obvious
//      `all([...]) + throttle.concurrency` measured a peak of 8 against a limit of 3.
//
//   pnpm exec tsx docs/scenarios/proofs/multipart-upload/c3-bounded-concurrency.ts
import { seam, stitch, verdictOf } from '../../../../packages/core/src/index';
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

const PARTS = [1, 2, 3, 4, 5, 6, 7, 8];
/** Every part stalls 20 microtask turns, so an unbounded fan is unmistakably 8 wide. */
const SLOW = Object.fromEntries(PARTS.map((n) => [n, 20]));

async function openUpload(api: FakeS3, key: string): Promise<string> {
    const res = await api.adapter()({
        url: `${FakeS3.url(key)}?uploads`,
        method: 'POST',
        headers: {},
    });
    return (res.body as { UploadId: string }).UploadId;
}

/**
 * The throttle shape these cases use. Deliberately NOT `ThrottleOptions`: that type is optional in
 * every field, and `StitchConfig.throttle` is `AtLeastOne<ThrottleOptions>` (P20 — the opaque `{}`
 * is a compile error), so a bare `ThrottleOptions` is not assignable to the config slot.
 */
type Bound = { concurrency: number; pool?: 'stitch' | 'host' };

/** One reusable part stitch — the fan is N CALLS to it. */
function onePartStitch(api: FakeS3, throttle?: Bound): Stitch {
    return stitch({
        url: FakeS3.template,
        method: 'PUT',
        kind: partSurface,
        adapter: api.adapter(),
        ...(throttle ? { throttle } : {}),
    }) as Stitch;
}

/** N part stitches, one per part number — what `all()` forces, since every member gets one input. */
function perPartStitches(
    api: FakeS3,
    uploadId: string,
    throttle?: Bound,
): Stitch[] {
    return PARTS.map(
        (n) =>
            stitch({
                url: `${FakeS3.template}?partNumber=${n}&uploadId=${uploadId}`,
                method: 'PUT',
                kind: partSurface,
                adapter: api.adapter(),
                ...(throttle ? { throttle } : {}),
            }) as Stitch,
    );
}

async function main(): Promise<void> {
    heading('C3 — bounded concurrency: the measured peak in-flight count');

    // ── (a) baseline: no bound at all ─────────────────────────────────────────────────────────
    {
        const api = new FakeS3({ partTicks: SLOW });
        const uploadId = await openUpload(api, 'v.mp4');
        const part = onePartStitch(api);
        await Promise.all(
            PARTS.map((n) =>
                part({
                    params: { key: 'v.mp4' },
                    query: { partNumber: n, uploadId },
                    body: { chunk: `c${n}` },
                }),
            ),
        );
        check('(a) 8 parts, no throttle → peak in-flight', api.peakInFlight, 8);
    }

    // ── (b) does `all()` bound anything? ──────────────────────────────────────────────────────
    {
        const api = new FakeS3({ partTicks: SLOW });
        const uploadId = await openUpload(api, 'v.mp4');
        await all(perPartStitches(api, uploadId))({
            params: { key: 'v.mp4' },
            body: { chunk: 'c' },
        });
        check('(b) all() over 8 members → peak in-flight', api.peakInFlight, 8);
        check('(b) parts actually stored', api.storedParts(uploadId), 8);
        note(
            '(b) → `all()` is fail-fast + auto-cancel + child runs, NOT a pool',
            'pipe.ts:122-136 is `members.map(...)` straight into `Promise.all` — nothing rations starts',
        );
    }

    // ── (c) …and every member gets the SAME input ─────────────────────────────────────────────
    // The reason (b) had to build 8 stitches. Give `all()` the same stitch 8 times and all 8 PUTs
    // carry the same part number — 8 requests, ONE part stored.
    {
        const api = new FakeS3({ partTicks: SLOW });
        const uploadId = await openUpload(api, 'v.mp4');
        const part = onePartStitch(api);
        await all([part, part, part, part, part, part, part, part])({
            params: { key: 'v.mp4' },
            query: { partNumber: 1, uploadId },
            body: { chunk: 'c' },
        });
        check('(c) requests the server saw', api.partPuts, 8);
        checkSeq(
            '(c) part numbers on those requests',
            [...new Set(api.partPutOrder)],
            [1],
        );
        check('(c) distinct parts stored', api.storedParts(uploadId), 1);
        note(
            '(c) → `all()` cannot vary input across members',
            '`runMember` spreads ONE `StitchInput` over all of them (pipe.ts:75-76) — a part fan needs N stitches or N closures',
        );
    }

    // ── (d) one stitch, N calls, `throttle.concurrency` — the bound that WORKS ────────────────
    {
        const api = new FakeS3({ partTicks: SLOW });
        const uploadId = await openUpload(api, 'v.mp4');
        const part = onePartStitch(api, { concurrency: 3 });
        await Promise.all(
            PARTS.map((n) =>
                part({
                    params: { key: 'v.mp4' },
                    query: { partNumber: n, uploadId },
                    body: { chunk: `c${n}` },
                }),
            ),
        );
        check(
            '(d) one stitch × 8 calls, concurrency: 3 → peak',
            api.peakInFlight,
            3,
        );
        check('(d) all 8 parts landed', api.storedParts(uploadId), 8);
        note(
            '(d) → this is the real answer',
            'the bound lives on the STITCH, so the fan has to be N calls to ONE stitch',
        );
    }

    // ── (e) …and the combination that looks right and is not ──────────────────────────────────
    // `all()` + `throttle.concurrency: 3` on each member. Default `pool: 'stitch'` gives each
    // stitch its OWN state map (resilience.ts:103-109), so 8 stitches = 8 buckets of 3 = no bound.
    {
        const api = new FakeS3({ partTicks: SLOW });
        const uploadId = await openUpload(api, 'v.mp4');
        await all(perPartStitches(api, uploadId, { concurrency: 3 }))({
            params: { key: 'v.mp4' },
            body: { chunk: 'c' },
        });
        check(
            '(e) all() + concurrency: 3 on EVERY member → peak',
            api.peakInFlight,
            8,
        );
        note(
            '(e) → the limit is per stitch, and `all()` needs one stitch per part',
            'the config reads "concurrency: 3" eight times and bounds nothing',
        );
    }

    // ── (f) the two spellings that DO pool across stitches ────────────────────────────────────
    // `pool: 'host'` keys the bucket on the URL host and keeps its state in a module-level map
    // (resilience.ts:107), so separate stitch instances share it.
    {
        const api = new FakeS3({ partTicks: SLOW });
        const uploadId = await openUpload(api, 'v.mp4');
        await all(
            perPartStitches(api, uploadId, { concurrency: 3, pool: 'host' }),
        )({ params: { key: 'v.mp4' }, body: { chunk: 'c' } });
        check(
            '(f) all() + concurrency: 3, pool: "host" → peak',
            api.peakInFlight,
            3,
        );
    }
    {
        // A seam re-keys every member's acquire onto one seam-stable key (seam.ts:46-68).
        const api = new FakeS3({ partTicks: SLOW });
        const uploadId = await openUpload(api, 'v.mp4');
        const bucket = seam({
            throttle: { concurrency: 3 },
            adapter: api.adapter(),
        });
        const members = PARTS.map(
            (n) =>
                bucket.stitch({
                    url: `${FakeS3.template}?partNumber=${n}&uploadId=${uploadId}`,
                    method: 'PUT',
                    kind: partSurface,
                }) as Stitch,
        );
        await all(members)({ params: { key: 'v.mp4' }, body: { chunk: 'c' } });
        check(
            '(f) seam({ throttle: { concurrency: 3 } }) → peak',
            api.peakInFlight,
            3,
        );
        note(
            '(f) → two working spellings, neither of them the obvious one',
            '`pool: "host"` or a seam bucket; plain per-stitch `concurrency` is a per-stitch bound',
        );
    }

    // ── (g) the bound holds under the ordering C2 needs ───────────────────────────────────────
    // A pool changes WHEN parts land; it must not change what order the ETags end up in.
    {
        const api = new FakeS3({
            partTicks: { 8: 0, 7: 1, 6: 2, 5: 3, 4: 40, 3: 41, 2: 42, 1: 43 },
        });
        const uploadId = await openUpload(api, 'v.mp4');
        const part = onePartStitch(api, { concurrency: 3 });
        const etags = await Promise.all(
            PARTS.map(async (n) => ({
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
        check('(g) peak under the pool', api.peakInFlight, 3);
        check(
            '(g) server storage order differed from part order',
            api.completionOrder.join(',') !== PARTS.join(','),
            true,
        );
        checkSeq(
            '(g) ETag list order',
            etags.map((e) => e.PartNumber),
            PARTS,
        );
        check('(g) complete → ok', done.ok, true);
        check('(g) orphans', api.orphanParts, 0);
    }

    finish(
        'C3',
        'PASS, but NOT via `all()`. Measured peaks over 8 stalled parts: no throttle → **8**; `all()` over 8 members → **8** (it bounds nothing — pipe.ts:122-136 maps every member straight into `Promise.all`); ONE stitch called 8 times with `throttle: { concurrency: 3 }` → **3**. The trap is the combination that reads correct: `all()` hands every member the SAME `StitchInput` (measured: one stitch × 8 members produced 8 PUTs all carrying `partNumber=1` and stored ONE part), so a part fan needs 8 distinct stitches — and 8 stitches with `concurrency: 3` each measured a peak of **8**, because the default `pool: "stitch"` gives every stitch its own state map (resilience.ts:103-109). Two spellings do pool across stitches: `{ concurrency: 3, pool: "host" }` → **3**, and a `seam({ throttle: { concurrency: 3 } })` bucket → **3** (seam.ts:46-68). Under the pool the ordering C2 needs still holds: peak 3, server storage order ≠ part order, ETag list [1..8], complete ok, 0 orphans',
    );
}

void main();
