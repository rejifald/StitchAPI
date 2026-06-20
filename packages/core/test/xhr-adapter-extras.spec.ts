// xhrAdapter branches (src/xhr-adapter.ts) beyond xhr-adapter.spec.ts (progress, body encoding,
// streaming-reject, pre-aborted). Driven by a configurable fake XMLHttpRequest. Pins:
//   - no XMLHttpRequest available → rejects;
//   - onload parses status + response headers (lowercased, CRLF-split, malformed lines skipped) and
//     decodes the body;
//   - onerror rejects with a network error; an in-flight abort() rejects via onabort;
//   - a caller-supplied content-type is preserved (not overridden by the body's);
//   - non-lengthComputable progress reports loaded with no total.
import { xhrAdapter } from '../src';
import type { AdapterProgress, AdapterRequest } from '../src/types';
import type { XhrLikeCtor, XhrProgress } from '../src/xhr-adapter';

type Mode = 'onload' | 'onerror' | 'pending' | 'progress-noncomputable';

class Fake {
    static mode: Mode = 'onload';
    static script = {
        status: 200,
        headers: 'content-type: application/json\r\n',
        body: new ArrayBuffer(0),
    };
    static last: Fake | undefined;

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
        Fake.last = this;
    }
    open(): void {
        /* no-op */
    }
    setRequestHeader(name: string, value: string): void {
        this.requestHeaders[name.toLowerCase()] = value;
    }
    getAllResponseHeaders(): string {
        return Fake.script.headers;
    }
    abort(): void {
        this.onabort?.();
    }
    send(body: unknown): void {
        this.sent = body;
        queueMicrotask(() => {
            if (Fake.mode === 'pending') return;
            if (Fake.mode === 'onerror') {
                this.onerror?.();
                return;
            }
            if (Fake.mode === 'progress-noncomputable') {
                // Real XHR sets total: 0 when length is not computable.
                this.upload.onprogress?.({
                    lengthComputable: false,
                    loaded: 5,
                    total: 0,
                });
                this.onprogress?.({
                    lengthComputable: false,
                    loaded: 8,
                    total: 0,
                });
            }
            this.status = Fake.script.status;
            this.response = Fake.script.body;
            this.onload?.();
        });
    }
}

const asCtor = Fake as unknown as XhrLikeCtor;
const req = (over: Partial<AdapterRequest> = {}): AdapterRequest => ({
    url: 'https://api.test/x',
    method: 'GET',
    headers: {},
    ...over,
});

beforeEach(() => {
    Fake.mode = 'onload';
    Fake.last = undefined;
    Fake.script = {
        status: 200,
        headers: 'content-type: application/json\r\n',
        body: new ArrayBuffer(0),
    };
});

test('rejects when no XMLHttpRequest is available', async () => {
    const g = globalThis as { XMLHttpRequest?: unknown };
    const saved = g.XMLHttpRequest;
    delete g.XMLHttpRequest;
    try {
        await expect(xhrAdapter()(req())).rejects.toThrow(
            /requires XMLHttpRequest/,
        );
    } finally {
        if (saved !== undefined) g.XMLHttpRequest = saved;
    }
});

test('onload parses status, lowercased headers (skipping malformed lines), and the body', async () => {
    Fake.script = {
        status: 201,
        headers:
            'Content-Type: application/json\r\nX-Custom: yes\r\nmalformed-no-colon\r\n',
        body: new TextEncoder().encode(JSON.stringify({ ok: true })).buffer,
    };
    const res = await xhrAdapter(asCtor)(req());
    expect(res.status).toBe(201);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['x-custom']).toBe('yes');
    expect(res.headers['malformed-no-colon']).toBeUndefined();
    expect(res.body).toEqual({ ok: true });
});

test('onerror rejects with a network error', async () => {
    Fake.mode = 'onerror';
    await expect(xhrAdapter(asCtor)(req())).rejects.toThrow(/network error/);
});

test('an in-flight abort rejects via onabort', async () => {
    Fake.mode = 'pending'; // never settles on its own
    const ac = new AbortController();
    const p = xhrAdapter(asCtor)(req({ signal: ac.signal }));
    ac.abort(); // → adapter's listener → xhr.abort() → onabort → reject
    await expect(p).rejects.toThrow(/aborted/);
});

test('a caller-supplied content-type is preserved (not overridden by the body type)', async () => {
    await xhrAdapter(asCtor)(
        req({
            method: 'POST',
            headers: { 'content-type': 'application/custom' },
            body: { a: 1 },
            bodyType: 'json',
        }),
    );
    expect(Fake.last?.requestHeaders['content-type']).toBe('application/custom');
});

test('non-lengthComputable progress reports loaded with no total', async () => {
    Fake.mode = 'progress-noncomputable';
    const events: AdapterProgress[] = [];
    await xhrAdapter(asCtor)(req({ onProgress: (p) => events.push(p) }));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
        expect(e.loaded).toBeGreaterThan(0);
        expect(e.total).toBeUndefined();
    }
});
