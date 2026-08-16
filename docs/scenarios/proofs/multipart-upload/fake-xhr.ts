// A fake `XMLHttpRequest` that satisfies core's `XhrLike` structurally, so `xhrAdapter(FakeXhr)`
// runs off-browser. This is not a workaround: `xhrAdapter` takes an optional constructor for
// exactly this reason (xhr-adapter.ts:49-68), the same dependency-injection seam `axiosAdapter`
// uses for its client.
//
// It does the one thing `fetch` cannot: fire `upload.onprogress` with bytes SENT, before the
// response exists. The tick schedule is deterministic (`uploadTicks` evenly spaced fractions of the
// encoded body length), so C1 and C7 assert an exact sequence rather than "some ticks happened".
//
// The response itself is produced by the real {@link FakeS3} handler, so the xhr path and the fetch
// path hit one server — a difference between them is a TRANSPORT difference, which is the whole
// question C1 asks.
import type { Adapter } from '../../../../packages/core/src/types';
import type {
    XhrLike,
    XhrProgress,
} from '../../../../packages/core/src/xhr-adapter';

export interface FakeXhrOptions {
    /** How many `upload.onprogress` ticks to fire per request. Default 4. */
    uploadTicks?: number;
    /** Fire one `onprogress` (download) tick as the response lands. Default true. */
    downloadTick?: boolean;
    /** Report `lengthComputable: false` — the chunked-body case, where `total` is unknown. */
    unknownLength?: boolean;
}

/**
 * Build an `XhrLikeCtor` bound to a transport. `xhrAdapter` constructs it with `new` and no
 * arguments, so the server has to be captured in a closure — hence the factory.
 */
export function fakeXhrCtor(
    transport: Adapter,
    opts: FakeXhrOptions = {},
): new () => XhrLike {
    const uploadTicks = opts.uploadTicks ?? 4;
    const downloadTick = opts.downloadTick ?? true;
    const unknownLength = opts.unknownLength ?? false;

    return class FakeXhr implements XhrLike {
        responseType = '';
        status = 0;
        response: unknown = null;
        readonly upload: { onprogress: ((e: XhrProgress) => void) | null } = {
            onprogress: null,
        };
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onabort: (() => void) | null = null;
        onprogress: ((e: XhrProgress) => void) | null = null;

        private method = 'GET';
        private url = '';
        private readonly reqHeaders: Record<string, string> = {};
        private resHeaders: Record<string, string> = {};
        private aborted = false;

        open(method: string, url: string): void {
            this.method = method;
            this.url = url;
        }
        setRequestHeader(name: string, value: string): void {
            this.reqHeaders[name] = value;
        }
        getAllResponseHeaders(): string {
            return Object.entries(this.resHeaders)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\r\n');
        }
        abort(): void {
            this.aborted = true;
            this.onabort?.();
        }

        send(body: string | FormData | null): void {
            const total = typeof body === 'string' ? body.length : 0;
            void (async () => {
                // Bytes SENT, before any response exists. `fetch` has no equivalent.
                const emit = this.upload.onprogress;
                if (emit && total > 0) {
                    for (let i = 1; i <= uploadTicks; i++) {
                        if (this.aborted) return;
                        await Promise.resolve();
                        const loaded = Math.round((total * i) / uploadTicks);
                        emit(
                            unknownLength
                                ? { lengthComputable: false, loaded, total: 0 }
                                : { lengthComputable: true, loaded, total },
                        );
                    }
                }

                let res;
                try {
                    res = await transport({
                        url: this.url,
                        method: this.method,
                        headers: this.reqHeaders,
                        body:
                            typeof body === 'string'
                                ? (JSON.parse(body) as unknown)
                                : undefined,
                    });
                } catch {
                    this.onerror?.();
                    return;
                }
                if (this.aborted) return;

                this.status = res.status;
                this.resHeaders = {
                    ...res.headers,
                    'content-type': 'application/json',
                };
                const text =
                    res.body === undefined ? '' : JSON.stringify(res.body);
                this.response = new TextEncoder().encode(text).buffer;
                if (downloadTick && this.onprogress)
                    this.onprogress({
                        lengthComputable: true,
                        loaded: text.length,
                        total: text.length,
                    });
                this.onload?.();
            })();
        }
    };
}
