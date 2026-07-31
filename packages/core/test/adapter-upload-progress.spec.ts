// The adapter seam's quiet trap: a call passes `onProgress` with a body expecting an upload bar,
// but the active transport can't report bytes SENT, so the upload phase stays dark with no error.
// The engine turns that silence into one teaching `info` event (topic
// `adapter.upload-progress-unsupported`) when the adapter declares its capabilities and
// `'uploadProgress'` is NOT among them (ADR 0005 Decision 9) — never a throw, since a body +
// `onProgress` can also legitimately want DOWNLOAD progress, which `fetch` does serve. These tests
// pin: built-in capabilities, when the note fires (fetch — the only built-in that can't do upload
// progress), and when it stays quiet (xhr and axios, which both wire upload progress; GET-no-body;
// no-onProgress; and unknown custom adapters).
import { axiosAdapter, fetchAdapter, stitch, xhrAdapter } from '../src';
import type {
    Adapter,
    AdapterCapabilities,
    AdapterProgress,
    AdapterResponse,
    AxiosLike,
    AxiosLikeConfig,
    StitchEvent,
    TraceSink,
} from '../src';

import { describe, expect, test } from 'vitest';

const TOPIC = 'adapter.upload-progress-unsupported';
const noop = (): void => undefined;

// Capture the event stream off a stitch and pluck the upload-progress note (if any).
function recorder() {
    const events: StitchEvent[] = [];
    const sink: TraceSink = {
        handle: (e) => {
            events.push(e);
        },
    };
    const warning = (): Extract<StitchEvent, { type: 'info' }> | undefined =>
        events.find(
            (e): e is Extract<StitchEvent, { type: 'info' }> =>
                e.type === 'info' && e.topic === TOPIC,
        );
    return { sink, warning };
}

// A buffered adapter that resolves offline. `capabilities` is attached only when provided, so the
// same helper makes a "declares it can't" transport, a "declares it can" one, and an unknown one.
const stubAdapter = (capabilities?: AdapterCapabilities): Adapter =>
    Object.assign(
        async (): Promise<AdapterResponse> => ({
            status: 200,
            headers: {},
            body: { ok: true },
        }),
        capabilities ? { capabilities } : {},
    );

describe('adapter capabilities are declared on the built-ins', () => {
    test('fetch supports stream + download progress, not upload', () => {
        expect(fetchAdapter().capabilities).toEqual({
            name: 'fetchAdapter',
            supports: ['stream', 'downloadProgress'],
        });
    });
    test('xhr supports both progress phases but not stream', () => {
        expect(xhrAdapter().capabilities).toEqual({
            name: 'xhrAdapter',
            supports: ['uploadProgress', 'downloadProgress'],
        });
    });
    test('axios supports both progress phases but not stream', () => {
        const client: AxiosLike = {
            request: async () => ({ status: 200, headers: {}, data: '' }),
        };
        expect(axiosAdapter(client).capabilities).toEqual({
            name: 'axiosAdapter',
            supports: ['uploadProgress', 'downloadProgress'],
        });
    });
});

describe('upload-progress teaching event', () => {
    test("fires for an adapter whose supports omits 'uploadProgress'", async () => {
        const { sink, warning } = recorder();
        const upload = stitch({
            url: 'https://api.test/files',
            method: 'POST',
            adapter: stubAdapter({ name: 'stub', supports: [] }),
            trace: sink,
        });
        await upload({ body: { file: 'data' }, onProgress: noop });

        const w = warning();
        expect(w).toBeDefined();
        expect(w?.detail).toContain('stub');
        expect(w?.detail).toContain('xhrAdapter');
    });

    test('the real fetchAdapter names itself and points at xhrAdapter', async () => {
        const { sink, warning } = recorder();
        const upload = stitch({
            url: 'https://api.test/files',
            method: 'POST',
            adapter: fetchAdapter({
                fetch: async () =>
                    new Response(JSON.stringify({ ok: true }), {
                        headers: { 'content-type': 'application/json' },
                    }),
            }),
            trace: sink,
        });
        await upload({ body: { file: 'data' }, onProgress: noop });

        expect(warning()?.detail).toContain('fetchAdapter');
        expect(warning()?.detail).toContain('xhrAdapter');
    });

    test('the default adapter (no `adapter` field) warns — it resolves to fetchAdapter', async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = async () =>
            new Response(JSON.stringify({ ok: true }), {
                headers: { 'content-type': 'application/json' },
            });
        try {
            const { sink, warning } = recorder();
            const upload = stitch({
                url: 'https://api.test/files',
                method: 'POST',
                trace: sink,
            });
            await upload({ body: { file: 'data' }, onProgress: noop });
            expect(warning()).toBeDefined();
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});

describe('the teaching event stays quiet when it should', () => {
    test('an adapter that CAN report upload progress (xhr-like) does not warn', async () => {
        const { sink, warning } = recorder();
        const upload = stitch({
            url: 'https://api.test/files',
            method: 'POST',
            adapter: stubAdapter({
                name: 'stub',
                supports: ['uploadProgress'],
            }),
            trace: sink,
        });
        await upload({ body: { file: 'data' }, onProgress: noop });
        expect(warning()).toBeUndefined();
    });

    test('a GET with no body does not warn (download progress is real on fetch)', async () => {
        const { sink, warning } = recorder();
        const get = stitch({
            url: 'https://api.test/report',
            adapter: stubAdapter({ name: 'stub', supports: [] }),
            trace: sink,
        });
        await get({ onProgress: noop });
        expect(warning()).toBeUndefined();
    });

    test('a body without onProgress does not warn', async () => {
        const { sink, warning } = recorder();
        const upload = stitch({
            url: 'https://api.test/files',
            method: 'POST',
            adapter: stubAdapter({ name: 'stub', supports: [] }),
            trace: sink,
        });
        await upload({ body: { file: 'data' } });
        expect(warning()).toBeUndefined();
    });

    test('axios does not warn — it wires native upload + download progress', async () => {
        const { sink, warning } = recorder();
        let cfg: AxiosLikeConfig | undefined;
        const client: AxiosLike = {
            request: async (c) => {
                cfg = c;
                return { status: 200, headers: {}, data: '' };
            },
        };
        const seen: AdapterProgress[] = [];
        const upload = stitch({
            url: 'https://api.test/files',
            method: 'POST',
            adapter: axiosAdapter(client),
            trace: sink,
        });
        await upload({
            body: { file: 'data' },
            onProgress: (p) => seen.push(p),
        });

        // No teaching note — axios reports upload progress.
        expect(warning()).toBeUndefined();
        // The adapter wired axios's native progress callbacks...
        expect(typeof cfg?.onUploadProgress).toBe('function');
        expect(typeof cfg?.onDownloadProgress).toBe('function');
        // ...and translates an axios progress event into AdapterProgress.
        cfg?.onUploadProgress?.({ loaded: 5, total: 10 });
        cfg?.onDownloadProgress?.({ loaded: 3 });
        expect(seen).toContainEqual({
            direction: 'upload',
            loaded: 5,
            total: 10,
        });
        expect(seen).toContainEqual({ direction: 'download', loaded: 3 });
    });

    test('axios with onProgress but no body does not wire progress on a GET', async () => {
        let cfg: AxiosLikeConfig | undefined;
        const client: AxiosLike = {
            request: async (c) => {
                cfg = c;
                return { status: 200, headers: {}, data: '' };
            },
        };
        const get = stitch({
            url: 'https://api.test/report',
            adapter: axiosAdapter(client),
        });
        // onProgress IS wired whenever set (download progress on a GET is legitimate).
        await get({ onProgress: noop });
        expect(typeof cfg?.onDownloadProgress).toBe('function');
    });

    test('an unknown custom adapter (no capabilities) does not warn — the open contract stands', async () => {
        const { sink, warning } = recorder();
        const upload = stitch({
            url: 'https://api.test/files',
            method: 'POST',
            adapter: stubAdapter(),
            trace: sink,
        });
        await upload({ body: { file: 'data' }, onProgress: noop });
        expect(warning()).toBeUndefined();
    });
});
