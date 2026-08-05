// C1 — does `xhrAdapter` actually report UPLOAD progress, does `fetchAdapter` report none, and is
// the difference visible BEFORE the call?
//
// The capture says "`xhrAdapter` exists precisely for this" and wonders whether there is "real
// capability negotiation, and possibly a diagnostic when you ask `fetch` for progress". Both halves
// are testable. `xhrAdapter` is browser-only by default but takes an injected constructor
// (xhr-adapter.ts:49-68), so a structural fake runs it on Node with no polyfill.
//
// The part worth reading twice is (e): the diagnostic exists, but it is gated on the adapter having
// DECLARED capabilities (engine.ts:1113-1114). A custom transport — which is what every fake, every
// test double, and every BYO client in this repo's own proofs is — declares nothing, and gets
// silence. The teaching note is a property of the built-ins, not of the engine.
//
//   pnpm exec tsx docs/scenarios/proofs/multipart-upload/c1-upload-progress.ts
import {
    fetchAdapter,
    stitch,
    xhrAdapter,
} from '../../../../packages/core/src/index';
import type {
    Adapter,
    AdapterProgress,
    StitchEvent,
} from '../../../../packages/core/src/types';
import { FakeS3 } from './fake-s3';
import { fakeXhrCtor } from './fake-xhr';
import { check, checkSeq, finish, heading, note } from './harness';

/** Collect the engine's event stream for one call. */
async function eventsOf(
    run: (sink: (e: StitchEvent) => void) => Promise<unknown>,
): Promise<StitchEvent[]> {
    const evts: StitchEvent[] = [];
    await run((e) => evts.push(e));
    return evts;
}

/** Open a real upload on the server so the part PUTs below run on the success path. */
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
        'C1 — upload progress, and whether the transport gap is visible in advance',
    );

    // ── (a) the capability descriptor, read BEFORE any call is made ───────────────────────────
    // This is the "detectable in advance" half. Both built-ins hang an `AdapterCapabilities`
    // off the function itself (types.ts:936-941), so a host can branch on it at wiring time.
    {
        const xhr = xhrAdapter(fakeXhrCtor(new FakeS3().adapter()));
        const fetchA = fetchAdapter({ fetch: new FakeS3().fetchImpl() });
        checkSeq(
            '(a) xhrAdapter().capabilities.supports',
            xhr.capabilities?.supports ?? [],
            ['uploadProgress', 'downloadProgress'],
        );
        checkSeq(
            '(a) fetchAdapter().capabilities.supports',
            fetchA.capabilities?.supports ?? [],
            ['stream', 'downloadProgress'],
        );
        check(
            '(a) can a host ask "does this transport do upload progress?" with no call',
            String(xhr.capabilities?.supports.includes('uploadProgress')) +
                '/' +
                String(
                    fetchA.capabilities?.supports.includes('uploadProgress'),
                ),
            'true/false',
        );
        // And the inverse gap, which matters for the OTHER half of this scenario: xhr cannot stream.
        check(
            '(a) xhr supports stream',
            xhr.capabilities?.supports.includes('stream'),
            false,
        );
        note(
            '(a) → the two built-ins are strict complements',
            'xhr: upload+download progress, no stream. fetch: stream+download, no upload progress',
        );
    }

    // ── (b) xhrAdapter through a real stitch: does `direction: 'upload'` actually arrive? ──────
    {
        const api = new FakeS3();
        const uploadId = await openUpload(api, 'video.mp4');
        const ticks: AdapterProgress[] = [];
        const put = stitch({
            url: FakeS3.url('video.mp4'),
            method: 'PUT',
            adapter: xhrAdapter(fakeXhrCtor(api.adapter(), { uploadTicks: 4 })),
        });
        const r = await put.safe({
            query: { partNumber: 1, uploadId },
            body: { chunk: 'x'.repeat(96) },
            onProgress: (p) => ticks.push(p),
        });

        check('(b) xhr → the part PUT succeeded', r.ok, true);
        const uploads = ticks.filter((t) => t.direction === 'upload');
        const downloads = ticks.filter((t) => t.direction === 'download');
        check('(b) xhr → upload ticks', uploads.length, 4);
        checkSeq(
            '(b) xhr → upload `loaded` sequence',
            uploads.map((t) => t.loaded),
            [27, 54, 81, 108],
        );
        checkSeq(
            '(b) xhr → upload `total` (same on every tick)',
            [...new Set(uploads.map((t) => t.total))],
            [108],
        );
        check('(b) xhr → download ticks', downloads.length, 1);
        note(
            '(b) → the upload phase is genuinely instrumented',
            'ticks arrive BEFORE the response exists — the thing a progress bar needs',
        );
    }

    // ── (c) the same call over the REAL fetchAdapter: how many upload ticks? ──────────────────
    {
        const api = new FakeS3();
        const uploadId = await openUpload(api, 'video.mp4');
        const ticks: AdapterProgress[] = [];
        const put = stitch({
            url: FakeS3.url('video.mp4'),
            method: 'PUT',
            adapter: fetchAdapter({ fetch: api.fetchImpl() }),
        });
        await put.safe({
            query: { partNumber: 1, uploadId },
            body: { chunk: 'x'.repeat(96) },
            onProgress: (p) => ticks.push(p),
        });

        check(
            '(c) fetch → upload ticks',
            ticks.filter((t) => t.direction === 'upload').length,
            0,
        );
        check(
            '(c) fetch → download ticks',
            ticks.filter((t) => t.direction === 'download').length > 0,
            true,
        );
        note(
            '(c) → `onProgress` is not ignored on fetch, it is HALF-served',
            'the download phase reports; the upload phase is silent. A bar wired to `loaded` moves only after the bytes are already gone',
        );
    }

    // ── (d) …and the engine says so. The `info` event, on the built-in fetch adapter ──────────
    {
        const api = new FakeS3();
        const uploadId = await openUpload(api, 'video.mp4');
        const put = stitch({
            url: FakeS3.url('video.mp4'),
            method: 'PUT',
            adapter: fetchAdapter({ fetch: api.fetchImpl() }),
        });
        const evts = await eventsOf(async (sink) => {
            for await (const e of put.stream({
                query: { partNumber: 1, uploadId },
                body: { chunk: 'x' },
                onProgress: () => undefined,
            }))
                sink(e);
        });
        const info = evts.find((e) => e.type === 'info');
        check(
            '(d) info event topic',
            info && 'topic' in info ? info.topic : '(none)',
            'adapter.upload-progress-unsupported',
        );
        check(
            '(d) the detail names the fix',
            info && 'detail' in info
                ? String(info.detail).includes('xhrAdapter()')
                : false,
            true,
        );

        // It is gated on a BODY (engine.ts:1111): a bodyless GET asking for progress is a
        // legitimate download-progress request, so no note fires.
        const evtsNoBody = await eventsOf(async (sink) => {
            for await (const e of put.stream({
                query: { partNumber: 2, uploadId },
                onProgress: () => undefined,
            }))
                sink(e);
        });
        check(
            '(d) same call with NO body → info events',
            evtsNoBody.filter((e) => e.type === 'info').length,
            0,
        );
        note(
            '(d) → asking fetch for upload progress is NOT silence',
            'one `info` event per call, naming xhrAdapter() — but only on the event stream',
        );
    }

    // ── (e) the gate: the note only exists if the adapter DECLARED capabilities ───────────────
    // Every custom transport — and every fake in these proofs — declares nothing, so it is treated
    // as unknown and the open contract stands (engine.ts:1114). Silence, not a note.
    {
        const api = new FakeS3();
        const uploadId = await openUpload(api, 'video.mp4');
        const bare: Adapter = (req) => api.adapter()(req);
        const put = stitch({
            url: FakeS3.url('video.mp4'),
            method: 'PUT',
            adapter: bare,
        });
        const ticks: AdapterProgress[] = [];
        const evts = await eventsOf(async (sink) => {
            for await (const e of put.stream({
                query: { partNumber: 1, uploadId },
                body: { chunk: 'x' },
                onProgress: (p) => ticks.push(p),
            }))
                sink(e);
        });
        check(
            '(e) undeclared custom adapter → info events',
            evts.filter((e) => e.type === 'info').length,
            0,
        );
        check(
            '(e) undeclared custom adapter → progress ticks',
            ticks.length,
            0,
        );
        note(
            '(e) → this is the real-world default and it IS silent',
            'a BYO transport (or any test double) gets zero ticks and zero diagnostics',
        );
    }

    // ── (f) the awaited path never sees the note ──────────────────────────────────────────────
    // `.safe()` / `await` resolve normally; `info` is an EVENT. A team that never wires a trace
    // sink or `.stream()` gets the same silence the note exists to prevent.
    {
        const api = new FakeS3();
        const uploadId = await openUpload(api, 'video.mp4');
        const put = stitch({
            url: FakeS3.url('video.mp4'),
            method: 'PUT',
            adapter: fetchAdapter({ fetch: api.fetchImpl() }),
        });
        const r = await put.safe({
            query: { partNumber: 1, uploadId },
            body: { chunk: 'x' },
            onProgress: () => undefined,
        });
        check('(f) .safe() → ok', r.ok, true);
        check('(f) .safe() → error', r.error, null);
        note(
            '(f) → the diagnostic is opt-in by observation',
            '`await put(...)` and `.safe()` surface nothing; you must consume `.stream()` or attach a trace sink',
        );
    }

    finish(
        'C1',
        'YES on both halves, with one gate. `xhrAdapter` with an injected constructor reported 4 `direction: "upload"` ticks (loaded [27,54,81,108] of total 108) BEFORE the response existed, plus 1 download tick; the identical call through the real `fetchAdapter` reported 0 upload ticks and download ticks only. The difference is readable with NO call made: `xhrAdapter().capabilities.supports` measured ["uploadProgress","downloadProgress"] and `fetchAdapter().capabilities.supports` measured ["stream","downloadProgress"] — strict complements, so choosing progress costs you streaming. Asking fetch for upload progress is not silence: one `info` event, topic `adapter.upload-progress-unsupported`, whose detail names `xhrAdapter()` (engine.ts:1107-1123) — gated on a request body being present, so a bodyless GET gets none. THE GATE: it fires only when the adapter declared `capabilities`. A custom/BYO transport declares nothing and measured 0 info events and 0 progress ticks — silence, which is the case most real code is in',
    );
}

void main();
