// A fake, in-memory S3-shaped MULTIPART UPLOAD provider. Four endpoints, no network:
//
//   POST   /bucket/{key}?uploads                          → 200 `{ UploadId }`
//   PUT    /bucket/{key}?partNumber=N&uploadId=…          → 200, **`ETag` RESPONSE HEADER**, no body
//   POST   /bucket/{key}?uploadId=…  `{ Parts: [...] }`   → 200 the assembled object
//   DELETE /bucket/{key}?uploadId=…                       → 204 abort, parts discarded
//
// Three things about it are deliberate, because they are what turns this scenario's questions into
// measurements rather than arguments:
//
//   1. **The part result is a RESPONSE HEADER.** `PUT` answers with `etag: '"p3-…"'` and a body of
//      `undefined` — exactly like S3, which puts nothing useful in a part's body. A client that can
//      only see `res.body` cannot complete the upload at all.
//   2. **`complete` REJECTS a wrong list.** Out-of-order parts → `400 InvalidPartOrder`; a missing
//      part → `400 InvalidPart`; a wrong ETag → `400 InvalidPart`. So "the ETags were assembled in
//      part order" is something the server checks, not something the proof assumes.
//   3. **Orphans are counted.** A part stored under an UploadId that was never completed and never
//      aborted is exactly what AWS bills for and hides from `aws s3 ls`. `orphanParts` /
//      `orphanBytes` / `danglingUploads` are the numbers every C4/C5/C6 verdict cites.
//
// Completion order is controllable and RECORDED. `partTicks` delays a part's response by N
// microtask turns, so a test can make part 3 land before part 1 — and `completionOrder` reports the
// order the server actually stored them in, so C2's "part order, not completion order" is measured
// end to end rather than assumed. Ticks, not timers: the concurrency limiter arms no timer
// (resilience.ts:118-127), so a bounded fan needs no clock advancing and stays deterministic.
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
} from '../../../../packages/core/src/types';

const HOST = 'https://s3.example';
const BUCKET = 'bucket';

/** One part as the server stored it. */
export interface StoredPart {
    partNumber: number;
    etag: string;
    bytes: number;
}

/** One multipart upload's server-side state. `open` is the billing hazard. */
export interface UploadState {
    uploadId: string;
    key: string;
    /** Stored parts, keyed by part number. Discarded by `complete` and by `abort`. */
    parts: Map<number, StoredPart>;
    /** `open` = neither completed nor aborted = **orphaned**, and billed forever. */
    status: 'open' | 'completed' | 'aborted';
}

/** One recorded request, as the server saw it. */
export interface RecordedHit {
    method: string;
    /** `initiate` | `part` | `complete` | `abort` | `unknown`. */
    op: string;
    key: string;
    uploadId: string;
    /** Part number on a `part` hit, else 0. */
    partNumber: number;
    status: number;
}

/** The assembled object `complete` returns. */
export interface CompletedObject {
    Location: string;
    Bucket: string;
    Key: string;
    ETag: string;
    Parts: number;
    Bytes: number;
}

export interface FakeS3Options {
    /**
     * Microtask turns to stall each part's response by, keyed by part number. Default 0. This is
     * how a test makes COMPLETION order differ from PART order: `{ 3: 0, 1: 30, 2: 40, 4: 50 }`
     * lands part 3 first. Whatever it produces, `completionOrder` records what actually happened.
     */
    partTicks?: Record<number, number>;
    /** Bytes per part reported in progress + the assembled size. Default 5 MiB (S3's floor). */
    partBytes?: number;
    /**
     * Part numbers whose PUT never answers — a stalled socket. The request resolves only when its
     * `signal` aborts (which is what an engine `timeout` does), so a timeout is a reachable failure
     * mode and not just a hypothetical.
     */
    hangParts?: number[];
}

/** How a part should fail, and how many times before it starts working. */
interface PartFailure {
    status: number;
    /** Remaining attempts to fail. `Infinity` = always. */
    times: number;
}

const PART_BYTES = 5 * 1024 * 1024;

/** Wait N microtask turns — deterministic ordering with no timers and no clock. */
const ticks = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await Promise.resolve();
};

/**
 * The multipart provider. One instance is one bucket. Every counter on it is a measurement some
 * claim cites; the one that decides the scenario is {@link FakeS3.orphanParts}.
 */
export class FakeS3 {
    /** Every hit, in order. */
    readonly hits: RecordedHit[] = [];
    /** Part numbers in the order the server STORED them — completion order, not part order. */
    readonly completionOrder: number[] = [];
    /** Peak simultaneous in-flight part PUTs. The number C3 is about. */
    peakInFlight = 0;
    /** In-flight part PUTs right now. */
    private inFlight = 0;

    private readonly uploads = new Map<string, UploadState>();
    private readonly objects = new Map<string, CompletedObject>();
    private readonly failures = new Map<number, PartFailure>();
    private readonly partTicks: Record<number, number>;
    private readonly partBytes: number;
    private readonly hangParts: Set<number>;
    private nextUploadId = 0;

    constructor(opts: FakeS3Options = {}) {
        this.partTicks = opts.partTicks ?? {};
        this.partBytes = opts.partBytes ?? PART_BYTES;
        this.hangParts = new Set(opts.hangParts ?? []);
    }

    // ---- the URLs a stitch is pointed at ------------------------------------------------------

    /** `https://s3.example/bucket/{key}` — the one path all four operations share. */
    static url(key: string): string {
        return `${HOST}/${BUCKET}/${key}`;
    }
    /** RFC 6570 template form, for a stitch that takes the key as a `params` value. */
    static readonly template = `${HOST}/${BUCKET}/{key}`;

    // ---- the measurements ---------------------------------------------------------------------

    /**
     * **Parts left in the bucket under an UploadId that was never completed or aborted.** The AWS
     * bill line nobody sees. Zero is the only acceptable value after a failed upload.
     */
    get orphanParts(): number {
        let n = 0;
        for (const u of this.uploads.values())
            if (u.status === 'open') n += u.parts.size;
        return n;
    }
    /** The same thing in bytes — what the invisible storage actually costs. */
    get orphanBytes(): number {
        let n = 0;
        for (const u of this.uploads.values())
            if (u.status === 'open')
                for (const p of u.parts.values()) n += p.bytes;
        return n;
    }
    /** UploadIds still `open` — each one an upload the client walked away from. */
    get danglingUploads(): number {
        return [...this.uploads.values()].filter((u) => u.status === 'open')
            .length;
    }
    /** `POST ?uploads` count. More than one per logical upload means a re-initiate. */
    get initiated(): number {
        return this.hits.filter((h) => h.op === 'initiate').length;
    }
    /** `DELETE ?uploadId` count — how many times cleanup actually ran. */
    get aborted(): number {
        return this.hits.filter((h) => h.op === 'abort' && h.status < 400)
            .length;
    }
    /** Successful `POST ?uploadId` count. */
    get completed(): number {
        return this.hits.filter((h) => h.op === 'complete' && h.status < 400)
            .length;
    }
    /** Every part PUT that reached the server, successful or not. C5's "did it re-send?" number. */
    get partPuts(): number {
        return this.hits.filter((h) => h.op === 'part').length;
    }
    /** Part numbers of every part PUT, in arrival order. */
    get partPutOrder(): number[] {
        return this.hits
            .filter((h) => h.op === 'part')
            .map((h) => h.partNumber);
    }
    /** The ops that reached the server, in order — the request spine. */
    get ops(): string[] {
        return this.hits.map((h) => h.op);
    }
    /** Objects that actually exist in the bucket. */
    get objectCount(): number {
        return this.objects.size;
    }
    /** Look up an assembled object. */
    object(key: string): CompletedObject | undefined {
        return this.objects.get(key);
    }
    /** Parts currently stored under one UploadId (regardless of its status). */
    storedParts(uploadId: string): number {
        return this.uploads.get(uploadId)?.parts.size ?? 0;
    }
    /** One upload's status, or `'(unknown)'`. */
    statusOf(uploadId: string): string {
        return this.uploads.get(uploadId)?.status ?? '(unknown)';
    }
    /** Every UploadId the server ever minted, in order. */
    get uploadIds(): string[] {
        return [...this.uploads.keys()];
    }

    // ---- failure injection --------------------------------------------------------------------

    /**
     * Make part `n` fail. `times` bounds it (`1` = fail once then succeed, the retry case);
     * omitted = fail forever, the case that forces cleanup.
     */
    failPart(n: number, times = Number.POSITIVE_INFINITY, status = 500): void {
        this.failures.set(n, { status, times });
    }

    // ---- the transport ------------------------------------------------------------------------

    /** A StitchAPI {@link Adapter} bound to this bucket. */
    adapter(): Adapter {
        return (req: AdapterRequest): Promise<AdapterResponse> =>
            this.handle(req);
    }

    /**
     * A `fetch`-shaped entry point onto the same server, so C8's hand-rolled twin and the StitchAPI
     * implementation run over ONE transport contract rather than either getting a shortcut.
     */
    fetchImpl(): typeof fetch {
        return async (input, init) => {
            const url = typeof input === 'string' ? input : String(input);
            const headers: Record<string, string> = {};
            new Headers(init?.headers).forEach((v, k) => {
                headers[k] = v;
            });
            const res = await this.handle({
                url,
                method: init?.method ?? 'GET',
                headers,
                body:
                    typeof init?.body === 'string'
                        ? (JSON.parse(init.body) as unknown)
                        : undefined,
            });
            return new Response(
                res.body === undefined ? null : JSON.stringify(res.body),
                {
                    status: res.status,
                    headers: {
                        ...res.headers,
                        'content-type': 'application/json',
                    },
                },
            );
        };
    }

    /** The one request handler both entry points share. */
    private async handle(req: AdapterRequest): Promise<AdapterResponse> {
        const url = new URL(req.url);
        const key = url.pathname.replace(`/${BUCKET}/`, '');
        const method = req.method.toUpperCase();
        const uploadId = url.searchParams.get('uploadId') ?? '';
        const partNumber = Number(url.searchParams.get('partNumber') ?? 0);

        if (method === 'POST' && url.searchParams.has('uploads'))
            return this.initiate(key);
        if (method === 'PUT' && partNumber > 0)
            return this.putPart(key, uploadId, partNumber, req.signal);
        if (method === 'POST' && uploadId)
            return this.complete(key, uploadId, req.body);
        if (method === 'DELETE' && uploadId) return this.abort(key, uploadId);

        this.hits.push({
            method,
            op: 'unknown',
            key,
            uploadId,
            partNumber,
            status: 400,
        });
        return {
            status: 400,
            headers: {},
            body: { Code: 'MalformedRequest' },
        };
    }

    private initiate(key: string): AdapterResponse {
        const uploadId = `upl-${(this.nextUploadId += 1)}`;
        this.uploads.set(uploadId, {
            uploadId,
            key,
            parts: new Map(),
            status: 'open',
        });
        this.hits.push({
            method: 'POST',
            op: 'initiate',
            key,
            uploadId,
            partNumber: 0,
            status: 200,
        });
        return {
            status: 200,
            headers: {},
            body: { UploadId: uploadId, Key: key },
        };
    }

    private async putPart(
        key: string,
        uploadId: string,
        partNumber: number,
        signal: AbortSignal | undefined,
    ): Promise<AdapterResponse> {
        this.inFlight += 1;
        this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
        try {
            await ticks(this.partTicks[partNumber] ?? 0);

            // A stalled socket: answer only when someone gives up on us. `withTimeout`
            // (engine.ts:668-673) aborts the attempt signal, which is what lands here.
            if (this.hangParts.has(partNumber)) {
                await new Promise<void>((resolve) => {
                    if (signal)
                        signal.addEventListener('abort', () => resolve(), {
                            once: true,
                        });
                });
                this.hits.push({
                    method: 'PUT',
                    op: 'part',
                    key,
                    uploadId,
                    partNumber,
                    status: 499,
                });
                throw new Error('stalled');
            }

            // A cancelled sibling never reaches the store — that is what makes C6's
            // "already-landed parts vs cancelled ones" a real distinction.
            if (signal?.aborted) {
                this.hits.push({
                    method: 'PUT',
                    op: 'part',
                    key,
                    uploadId,
                    partNumber,
                    status: 499,
                });
                throw new Error('aborted');
            }

            const fail = this.failures.get(partNumber);
            if (fail && fail.times > 0) {
                fail.times -= 1;
                this.hits.push({
                    method: 'PUT',
                    op: 'part',
                    key,
                    uploadId,
                    partNumber,
                    status: fail.status,
                });
                return {
                    status: fail.status,
                    headers: {},
                    body: { Code: 'InternalError' },
                };
            }

            const upload = this.uploads.get(uploadId);
            if (!upload || upload.status !== 'open') {
                this.hits.push({
                    method: 'PUT',
                    op: 'part',
                    key,
                    uploadId,
                    partNumber,
                    status: 404,
                });
                return {
                    status: 404,
                    headers: {},
                    body: { Code: 'NoSuchUpload' },
                };
            }

            const etag = `"${uploadId}-p${partNumber}"`;
            upload.parts.set(partNumber, {
                partNumber,
                etag,
                bytes: this.partBytes,
            });
            this.completionOrder.push(partNumber);
            this.hits.push({
                method: 'PUT',
                op: 'part',
                key,
                uploadId,
                partNumber,
                status: 200,
            });
            // The whole point: the result is a HEADER. The body carries nothing.
            return { status: 200, headers: { etag }, body: undefined };
        } finally {
            this.inFlight -= 1;
        }
    }

    private complete(
        key: string,
        uploadId: string,
        body: unknown,
    ): AdapterResponse {
        const upload = this.uploads.get(uploadId);
        const record = (status: number): void => {
            this.hits.push({
                method: 'POST',
                op: 'complete',
                key,
                uploadId,
                partNumber: 0,
                status,
            });
        };
        if (!upload || upload.status !== 'open') {
            record(404);
            return {
                status: 404,
                headers: {},
                body: { Code: 'NoSuchUpload' },
            };
        }

        const listed = (body as { Parts?: unknown })?.Parts;
        const parts = Array.isArray(listed)
            ? (listed as { PartNumber?: number; ETag?: string }[])
            : [];

        // STRICT, like S3: ascending order, no gaps, every stored part present, ETags byte-exact.
        const ascending = parts.every(
            (p, i) =>
                i === 0 ||
                (parts[i - 1]?.PartNumber ?? 0) < (p.PartNumber ?? 0),
        );
        if (!ascending) {
            record(400);
            return {
                status: 400,
                headers: {},
                body: {
                    Code: 'InvalidPartOrder',
                    Message:
                        'parts must be listed in ascending PartNumber order',
                },
            };
        }
        if (parts.length !== upload.parts.size) {
            record(400);
            return {
                status: 400,
                headers: {},
                body: {
                    Code: 'InvalidPart',
                    Message: `listed ${parts.length} parts, ${upload.parts.size} were uploaded`,
                },
            };
        }
        for (const p of parts) {
            const stored = upload.parts.get(p.PartNumber ?? -1);
            if (!stored || stored.etag !== p.ETag) {
                record(400);
                return {
                    status: 400,
                    headers: {},
                    body: {
                        Code: 'InvalidPart',
                        Message: `part ${String(p.PartNumber)} has no matching stored ETag`,
                    },
                };
            }
        }

        const object: CompletedObject = {
            Location: FakeS3.url(key),
            Bucket: BUCKET,
            Key: key,
            ETag: `"${uploadId}-${parts.length}"`,
            Parts: parts.length,
            Bytes: [...upload.parts.values()].reduce((n, p) => n + p.bytes, 0),
        };
        this.objects.set(key, object);
        upload.status = 'completed';
        upload.parts.clear(); // assembled — no longer billed as parts
        record(200);
        return { status: 200, headers: {}, body: object };
    }

    private abort(key: string, uploadId: string): AdapterResponse {
        const upload = this.uploads.get(uploadId);
        if (!upload || upload.status !== 'open') {
            this.hits.push({
                method: 'DELETE',
                op: 'abort',
                key,
                uploadId,
                partNumber: 0,
                status: 404,
            });
            return {
                status: 404,
                headers: {},
                body: { Code: 'NoSuchUpload' },
            };
        }
        upload.status = 'aborted';
        upload.parts.clear(); // the bill stops here
        this.hits.push({
            method: 'DELETE',
            op: 'abort',
            key,
            uploadId,
            partNumber: 0,
            status: 204,
        });
        return { status: 204, headers: {}, body: undefined };
    }
}
