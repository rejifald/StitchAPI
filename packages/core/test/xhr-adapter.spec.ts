// The xhrAdapter (ADR 0005 Decision 9): a browser-only, zero-dep Adapter whose reason to exist
// over fetchAdapter is UPLOAD progress (fetch can't report bytes sent). Driven here by an
// injected fake XMLHttpRequest, since vitest runs in node (no XMLHttpRequest global).
import { xhrAdapter } from '../src';
import type { AdapterProgress } from '../src/types';
import type { XhrLikeCtor, XhrProgress } from '../src/xhr-adapter';

// A minimal fake XMLHttpRequest: records open/headers/body, then on `send` fires upload
// progress, download progress, and onload with a scripted arraybuffer response.
class FakeXHR {
    static last: FakeXHR | undefined;
    static script: { status: number; headers: string; body: ArrayBuffer } = {
        status: 200,
        headers: 'content-type: application/json\r\n',
        body: new ArrayBuffer(0),
    };

    method = '';
    url = '';
    sent: unknown;
    responseType = '';
    requestHeaders: Record<string, string> = {};
    status = 0;
    response: unknown = null;
    upload = { onprogress: null as ((e: XhrProgress) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    onprogress: ((e: XhrProgress) => void) | null = null;

    constructor() {
        FakeXHR.last = this;
    }
    open(method: string, url: string): void {
        this.method = method;
        this.url = url;
    }
    setRequestHeader(name: string, value: string): void {
        this.requestHeaders[name.toLowerCase()] = value;
    }
    getAllResponseHeaders(): string {
        return FakeXHR.script.headers;
    }
    abort(): void {
        this.onabort?.();
    }
    send(body: string | FormData | null): void {
        this.sent = body;
        queueMicrotask(() => {
            this.upload.onprogress?.({
                lengthComputable: true,
                loaded: 5,
                total: 10,
            });
            this.upload.onprogress?.({
                lengthComputable: true,
                loaded: 10,
                total: 10,
            });
            this.onprogress?.({ lengthComputable: true, loaded: 8, total: 16 });
            this.onprogress?.({
                lengthComputable: true,
                loaded: 16,
                total: 16,
            });
            this.status = FakeXHR.script.status;
            this.response = FakeXHR.script.body;
            this.onload?.();
        });
    }
}

const asCtor = FakeXHR as unknown as XhrLikeCtor;
const jsonBody = (obj: unknown): ArrayBuffer =>
    new TextEncoder().encode(JSON.stringify(obj)).buffer;

describe('xhrAdapter (ADR 0005 Decision 9)', () => {
    beforeEach(() => {
        FakeXHR.last = undefined;
    });

    test('reports upload AND download progress, tagged by phase (upload first)', async () => {
        FakeXHR.script = {
            status: 200,
            headers: 'content-type: application/json\r\n',
            body: jsonBody({ ok: true }),
        };
        const events: AdapterProgress[] = [];

        const res = await xhrAdapter(asCtor)({
            url: 'http://h/u',
            method: 'POST',
            headers: {},
            bodyType: 'json',
            body: { a: 1 },
            onProgress: (p) => events.push(p),
        });

        expect(res).toEqual({
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: { ok: true },
        });
        const phases = events.map((e) => e.phase);
        expect(phases).toContain('upload');
        expect(phases).toContain('download');
        expect(phases.indexOf('upload')).toBeLessThan(
            phases.indexOf('download'),
        );
        // upload progress carries byte counts (the whole point of this adapter)
        expect(events.find((e) => e.phase === 'upload')).toMatchObject({
            loaded: 5,
            total: 10,
        });
    });

    test('encodes the request body via the shared helper + sets content-type', async () => {
        FakeXHR.script = { status: 200, headers: '', body: jsonBody({}) };

        await xhrAdapter(asCtor)({
            url: 'http://h/u',
            method: 'POST',
            headers: {},
            bodyType: 'json',
            body: { a: 1 },
        });

        expect(FakeXHR.last?.sent).toBe(JSON.stringify({ a: 1 }));
        expect(FakeXHR.last?.requestHeaders['content-type']).toBe(
            'application/json',
        );
    });

    test('rejects streaming (buffered-only transport)', async () => {
        await expect(
            xhrAdapter(asCtor)({
                url: 'http://h/u',
                method: 'GET',
                headers: {},
                stream: true,
            }),
        ).rejects.toThrow(/stream/i);
    });
});
