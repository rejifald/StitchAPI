// C7 — can per-part byte counts be combined into ONE number for a UI?
//
// Yes, and the sum is trivial. The three things that are not trivial are all measured here:
//
//   1. `AdapterProgress` is `{ direction, loaded, total }` (types.ts:858-867). **No part identity.**
//      One shared callback across a concurrent fan cannot tell which part a tick belongs to, so the
//      obvious "sum every `loaded`" is wrong — each tick is CUMULATIVE for its own part, not a
//      delta. Measured: the naive sum overshoots the file size by 2.5×.
//   2. A RETRY re-sends the part and replays its ticks from zero, so a per-part high-water mark is
//      the only thing that does not make the bar go backwards.
//   3. Byte progress has no event: `ProgressPhase` is `auth|request|throttled|retry|reconnect|
//      paginate|circuit|cache` (types.ts:1293-1305). `onProgress` is runtime-only — it is not on
//      `__config` and never reaches a trace sink.
//
//   pnpm exec tsx docs/scenarios/proofs/multipart-upload/c7-progress-aggregation.ts
import {
    stitch,
    verdictOf,
    xhrAdapter,
} from '../../../../packages/core/src/index';
import type { Surface } from '../../../../packages/core/src/surface';
import type { AdapterProgress } from '../../../../packages/core/src/types';
import { FakeS3 } from './fake-s3';
import { fakeXhrCtor } from './fake-xhr';
import { check, checkSeq, finish, heading, note } from './harness';

const partSurface: Surface = {
    id: 'multipart-part',
    interpret: (res, cfg) =>
        verdictOf(res, cfg) ?? { ok: true, data: res.headers['etag'] },
};

/** Four equal chunks; the encoded JSON body is 40 bytes each, so the "file" is 160 bytes. */
const CHUNK = 'z'.repeat(28); // `{"chunk":"z…z"}` → 40 chars
const PART_BODY_BYTES = JSON.stringify({ chunk: CHUNK }).length;
const PARTS = [1, 2, 3, 4];

async function openUpload(api: FakeS3, key: string): Promise<string> {
    const res = await api.adapter()({
        url: `${FakeS3.url(key)}?uploads`,
        method: 'POST',
        headers: {},
    });
    return (res.body as { UploadId: string }).UploadId;
}

async function main(): Promise<void> {
    heading('C7 — one number for the UI, out of N per-part byte counts');

    check('(setup) bytes per part body', PART_BODY_BYTES, 40);

    // ── (a) the naive aggregate: sum every `loaded` ───────────────────────────────────────────
    {
        const api = new FakeS3();
        const uploadId = await openUpload(api, 'v.mp4');
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: xhrAdapter(fakeXhrCtor(api.adapter(), { uploadTicks: 4 })),
        });
        let naive = 0;
        const ticks: number[] = [];
        await Promise.all(
            PARTS.map((n) =>
                part({
                    params: { key: 'v.mp4' },
                    query: { partNumber: n, uploadId },
                    body: { chunk: CHUNK },
                    onProgress: (p: AdapterProgress) => {
                        if (p.direction !== 'upload') return;
                        naive += p.loaded;
                        ticks.push(p.loaded);
                    },
                }),
            ),
        );
        check('(a) upload ticks in total', ticks.length, 16);
        checkSeq(
            '(a) the distinct `loaded` values a tick can carry',
            [...new Set(ticks)].sort((x, y) => x - y),
            [10, 20, 30, 40],
        );
        check('(a) naive Σ loaded', naive, 400);
        check('(a) the actual file size', PART_BODY_BYTES * PARTS.length, 160);
        note(
            '(a) → summing `loaded` overshoots by 2.5×',
            'each tick is CUMULATIVE within its own part; the sum of cumulative counters is not a total',
        );
    }

    // ── (b) …and the tick carries nothing to fix it with ──────────────────────────────────────
    {
        const api = new FakeS3();
        const uploadId = await openUpload(api, 'v.mp4');
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: xhrAdapter(fakeXhrCtor(api.adapter(), { uploadTicks: 2 })),
        });
        const shapes: string[] = [];
        await Promise.all(
            PARTS.map((n) =>
                part({
                    params: { key: 'v.mp4' },
                    query: { partNumber: n, uploadId },
                    body: { chunk: CHUNK },
                    onProgress: (p: AdapterProgress) => {
                        if (p.direction === 'upload')
                            shapes.push(Object.keys(p).sort().join(','));
                    },
                }),
            ),
        );
        checkSeq(
            '(b) fields on every upload tick',
            [...new Set(shapes)],
            ['direction,loaded,total'],
        );
        note(
            '(b) → no part number, no request, no url, no run id',
            'a SHARED `onProgress` across a fan is unattributable; the identity has to come from the call site',
        );
    }

    // ── (c) the aggregate that works: one closure per part, high-water per part ───────────────
    {
        const api = new FakeS3({ partTicks: { 1: 0, 2: 3, 3: 6, 4: 9 } });
        const uploadId = await openUpload(api, 'v.mp4');
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: xhrAdapter(fakeXhrCtor(api.adapter(), { uploadTicks: 4 })),
            throttle: { concurrency: 2 },
        });
        const sent = new Map<number, number>();
        const bar: number[] = [];
        const total = PART_BODY_BYTES * PARTS.length;
        await Promise.all(
            PARTS.map((n) =>
                part({
                    params: { key: 'v.mp4' },
                    query: { partNumber: n, uploadId },
                    body: { chunk: CHUNK },
                    // The part number is bound HERE — the only place it exists.
                    onProgress: (p: AdapterProgress) => {
                        if (p.direction !== 'upload') return;
                        sent.set(n, Math.max(sent.get(n) ?? 0, p.loaded));
                        let done = 0;
                        for (const v of sent.values()) done += v;
                        bar.push(Math.round((done / total) * 100));
                    },
                }),
            ),
        );
        check(
            '(c) final aggregate bytes',
            [...sent.values()].reduce((a, b) => a + b, 0),
            160,
        );
        check('(c) final percentage', bar[bar.length - 1], 100);
        check(
            '(c) the bar never went backwards',
            bar.every((v, i) => i === 0 || v >= (bar[i - 1] ?? 0)),
            true,
        );
        checkSeq(
            '(c) the percentage sequence',
            bar,
            [6, 13, 19, 25, 31, 38, 44, 50, 56, 63, 69, 75, 81, 88, 94, 100],
        );
        note(
            '(c) → 16 monotonic ticks ending exactly at 100%',
            'and the peak in-flight stayed at the configured bound while it happened',
        );
        check('(c) peak in-flight', api.peakInFlight, 2);
    }

    // ── (d) a RETRY replays the part's ticks from zero ─────────────────────────────────────────
    // The naive running sum goes backwards (or double-counts). The per-part high-water mark absorbs
    // it, because `Math.max` ignores the replay.
    {
        const api = new FakeS3();
        api.failPart(2, 1, 503);
        const uploadId = await openUpload(api, 'v.mp4');
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: xhrAdapter(fakeXhrCtor(api.adapter(), { uploadTicks: 2 })),
            retry: { attempts: 3, backoff: { curve: 'fixed', base: 0 } },
        });
        const perPart: number[] = [];
        const sent = new Map<number, number>();
        let naive = 0;
        await Promise.all(
            PARTS.map((n) =>
                part({
                    params: { key: 'v.mp4' },
                    query: { partNumber: n, uploadId },
                    body: { chunk: CHUNK },
                    onProgress: (p: AdapterProgress) => {
                        if (p.direction !== 'upload') return;
                        if (n === 2) perPart.push(p.loaded);
                        naive += p.loaded;
                        sent.set(n, Math.max(sent.get(n) ?? 0, p.loaded));
                    },
                }),
            ),
        );
        checkSeq(
            '(d) part 2’s ticks across the retry',
            perPart,
            [20, 40, 20, 40],
        );
        check('(d) naive Σ loaded (4 parts, 1 retried)', naive, 300);
        check(
            '(d) high-water aggregate',
            [...sent.values()].reduce((a, b) => a + b, 0),
            160,
        );
        note(
            '(d) → the retry replays the whole part',
            '`Math.max` per part is what keeps the bar honest; a `+=` counts the retried bytes twice',
        );
    }

    // ── (e) there is no EVENT for bytes ────────────────────────────────────────────────────────
    {
        const api = new FakeS3();
        const uploadId = await openUpload(api, 'v.mp4');
        const part = stitch({
            url: FakeS3.template,
            method: 'PUT',
            kind: partSurface,
            adapter: xhrAdapter(fakeXhrCtor(api.adapter(), { uploadTicks: 4 })),
        });
        const phases: string[] = [];
        for await (const e of part.stream({
            params: { key: 'v.mp4' },
            query: { partNumber: 1, uploadId },
            body: { chunk: CHUNK },
            onProgress: () => undefined,
        }))
            if (e.type === 'progress') phases.push(e.phase);
        checkSeq('(e) `progress` phases on the event stream', phases, [
            'request',
        ]);
        check(
            '(e) `onProgress` survives on the public config',
            Object.keys(
                (part as unknown as { __config: Record<string, unknown> })
                    .__config,
            ).includes('onProgress'),
            false,
        );
        note(
            '(e) → byte progress is a runtime callback and nothing else',
            'no event, no trace record, nothing on `__config` — a UI wires the closure or gets nothing',
        );
    }

    finish(
        'C7',
        'PASS, with a correct aggregate that is not the obvious one. Over 4 parts of 40 bytes each (160-byte "file") with 4 upload ticks apiece, the naive `Σ loaded` measured **400** against a real size of **160** — each tick is cumulative WITHIN its part, so summing cumulative counters overshoots by 2.5×. The tick cannot fix this itself: every upload tick measured exactly the fields `direction,loaded,total` (types.ts:858-867) — no part number, no request, no run id — so a SHARED `onProgress` across a concurrent fan is unattributable and the identity must be bound at the call site. Binding it there and keeping a per-part HIGH-WATER mark produced a clean bar: 16 monotonic ticks, percentages [6,13,19,…,94,100], final aggregate exactly 160, peak in-flight 2 under `throttle: { concurrency: 2 }`. A retry replays the part\'s ticks from zero (measured part 2: [20,40,20,40]), which makes the naive sum **300** while the high-water aggregate stayed **160**. And there is no EVENT for bytes: the only `progress` phase on the stream was `request`, `ProgressPhase` (types.ts:1293-1305) has no byte phase, and `onProgress` is absent from `__config` — a UI wires the closure or gets nothing',
    );
}

void main();
