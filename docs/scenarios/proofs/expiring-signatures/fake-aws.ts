// The AWS-ish server this scenario measures against: an `Adapter` that VALIDATES the timestamp
// embedded in the signed request against its own clock and rejects with a `403
// RequestTimeTooSkewed` outside a five-minute window — the same window S3 and every other SigV4
// service enforces, for the same reason (replay protection).
//
// The single measurement everything here turns on is the SIGNATURE'S AGE ON ARRIVAL: the gap
// between the instant `x-amz-date` claims and the instant the request actually reached the
// transport. A library that signs before a wait it controls produces a growing age; one that signs
// after the wait produces zero regardless of how long the queue was. So every request is recorded
// with BOTH times and the difference between them, and the ledger is what each claim reads.
//
// Two clocks, deliberately separate:
//   • `clock`   — the CLIENT's clock. `arrivedAt` is stamped from it, so a virtual-time run can
//                 hold a request for six virtual minutes without waiting six real ones.
//   • `skewMs`  — how far the SERVER's clock sits from the client's. This is failure mode 1 from
//                 the capture (the drifting host) expressed as one number: `skewMs: 600_000` is a
//                 host ten minutes behind, and every signature it mints is already outside the
//                 window when it arrives, however fast it got there.
import type {
    Adapter,
    AdapterRequest,
    Clock,
} from '../../../../packages/core/src/types';

/** The five-minute window. Not configurable at AWS; configurable here only so a test can narrow it. */
export const SKEW_WINDOW_MS = 5 * 60 * 1000;

/** One recorded request: what the signature claimed, when it actually arrived, and the gap. */
export interface AwsCall {
    /** 1-based arrival order. */
    n: number;
    /** The `x-amz-date` that arrived on the wire, verbatim (`YYYYMMDDTHHMMSSZ`). */
    amzDate: string;
    /** `x-amz-date` parsed to epoch ms — the instant the signature CLAIMS it was minted. */
    signedAt: number;
    /** Client-clock time the request reached the transport. */
    arrivedAt: number;
    /**
     * `arrivedAt - signedAt` — how long the signature sat between minting and the wire. THE
     * measurement. Zero means the request was signed at the last moment before the transport;
     * anything large means it aged in a queue on the way there (botocore#149).
     */
    ageMs: number;
    /** `serverNow - signedAt` — the skew the SERVER saw, which is what the window is checked against. */
    skewMs: number;
    status: number;
    path: string;
    /** The `Signature=` hex from the `Authorization` header. Two attempts sharing one value is a REPLAY. */
    signature: string;
    /** The `Credential=.../<dateStamp>/...` scope date, which must agree with `x-amz-date`. */
    credentialScope: string;
}

export interface FakeAwsOptions {
    /** The client's clock — `arrivedAt` is stamped from it. */
    clock: Clock;
    /**
     * How far the SERVER's clock is AHEAD of the client's, in ms. `600_000` models a host ten
     * minutes slow: every signature it mints looks ten minutes stale to the server. Default 0.
     */
    skewMs?: number;
    /** The accepted window either side of the server's own time. Default {@link SKEW_WINDOW_MS}. */
    windowMs?: number;
    /** Hold each request this many client-clock ms before answering — a slow upstream, for the concurrency claim. */
    holdMs?: number;
    /** Fail every request with this status regardless of the timestamp — for the circuit claim. */
    failWith?: number;
}

/** Parse an AWS `YYYYMMDDTHHMMSSZ` datetime to epoch ms. `NaN` when it is not that shape. */
export function parseAmzDate(amzDate: string): number {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
    if (!m) return NaN;
    return Date.UTC(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6]),
    );
}

/** Render epoch ms as AWS's `YYYYMMDDTHHMMSSZ` — the same shape `@stitchapi/aws-sigv4` emits. */
export function amzDateOf(ms: number): string {
    return new Date(ms)
        .toISOString()
        .replace(/[:-]/g, '')
        .replace(/\.\d{3}/, '');
}

/** Pull the `Signature=` hex out of an `Authorization: AWS4-HMAC-SHA256 ...` header. */
export function signatureOf(authorization: string): string {
    return /Signature=([0-9a-f]+)/.exec(authorization)?.[1] ?? '';
}

/** Pull the `Credential=<key>/<scope>` scope out of an `Authorization` header. */
export function credentialScopeOf(authorization: string): string {
    return /Credential=[^/]+\/([^,]+)/.exec(authorization)?.[1] ?? '';
}

/**
 * The fake AWS endpoint. `adapter()` is what a stitch is handed; `calls` is the ledger every claim
 * reads its numbers off.
 */
export class FakeAws {
    readonly calls: AwsCall[] = [];
    private readonly clock: Clock;
    private readonly windowMs: number;
    private readonly holdMs: number;
    private readonly failWith: number | undefined;
    /** Mutable so a claim can heal a drifting host mid-run and watch the next attempt succeed. */
    skewMs: number;

    constructor(opts: FakeAwsOptions) {
        this.clock = opts.clock;
        this.skewMs = opts.skewMs ?? 0;
        this.windowMs = opts.windowMs ?? SKEW_WINDOW_MS;
        this.holdMs = opts.holdMs ?? 0;
        this.failWith = opts.failWith;
    }

    /** The server's own idea of the time — the client's clock plus whatever drift was configured. */
    serverNow(): number {
        return this.clock.now() + this.skewMs;
    }

    /** Every recorded signature age, in arrival order — the spine most claims assert on. */
    ages(): number[] {
        return this.calls.map((c) => c.ageMs);
    }

    /** Every recorded wire timestamp, in arrival order. Two identical entries across attempts = a replay. */
    stamps(): string[] {
        return this.calls.map((c) => c.amzDate);
    }

    /** How many DISTINCT signatures were seen — equal to `calls.length` iff every attempt re-signed. */
    distinctSignatures(): number {
        return new Set(this.calls.map((c) => c.signature)).size;
    }

    adapter(): Adapter {
        return async (req: AdapterRequest) => {
            const arrivedAt = this.clock.now();
            const amzDate = req.headers['x-amz-date'] ?? '';
            const authorization = req.headers['authorization'] ?? '';
            const signedAt = parseAmzDate(amzDate);
            const serverNow = this.serverNow();
            // `date` is what a real AWS error carries and what an SDK's skew correction learns
            // from — C7's whole seam question is whether anything can read it.
            const headers = { date: new Date(serverNow).toUTCString() };

            const n = this.calls.length + 1;
            const skewMs = serverNow - signedAt;
            const withinWindow =
                Number.isFinite(signedAt) && Math.abs(skewMs) <= this.windowMs;
            const status = !withinWindow ? 403 : (this.failWith ?? 200);

            this.calls.push({
                n,
                amzDate,
                signedAt,
                arrivedAt,
                ageMs: arrivedAt - signedAt,
                skewMs,
                status,
                path: new URL(req.url).pathname,
                signature: signatureOf(authorization),
                credentialScope: credentialScopeOf(authorization),
            });

            if (this.holdMs > 0) await this.clock.sleep(this.holdMs);

            if (!withinWindow) {
                return {
                    status: 403,
                    headers,
                    body: {
                        // The real S3 error envelope, near enough: the code is what any
                        // classification has to key on, because the STATUS alone (403) is
                        // indistinguishable from a genuinely bad credential.
                        Error: {
                            Code: 'RequestTimeTooSkewed',
                            Message:
                                'The difference between the request time and the current time is too large.',
                            RequestTime: amzDate,
                            ServerTime: new Date(serverNow).toISOString(),
                        },
                    },
                };
            }
            if (this.failWith !== undefined) {
                return {
                    status: this.failWith,
                    headers,
                    body: { Error: { Code: 'InternalError' } },
                };
            }
            return { status: 200, headers, body: { ok: true, n } };
        };
    }
}

/**
 * Run one call and reduce it to a short outcome token — `'ok'`, or `'<status>'` for a failure.
 *
 * `PromiseLike`, not `Promise`: a stitch call returns a lazy `StitchResult` thenable that starts on
 * `.then`, and it is deliberately not a full `Promise`.
 */
export async function outcomeOf(
    call: () => PromiseLike<unknown>,
): Promise<string> {
    try {
        await call();
        return 'ok';
    } catch (e) {
        const err = e as Error & { status?: number };
        return String(err.status ?? err.name);
    }
}

/** Is this response body the S3 skew envelope? The predicate a real classification would use. */
export function isSkewError(body: unknown): boolean {
    return (
        (body as { Error?: { Code?: string } } | undefined)?.Error?.Code ===
        'RequestTimeTooSkewed'
    );
}
