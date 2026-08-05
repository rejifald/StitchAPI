// The two signing instruments this scenario measures with, and why there have to be two.
//
// `@stitchapi/aws-sigv4`'s `awsSigV4` stamps its timestamp from `new Date()` (aws-sigv4/src/
// index.ts:301) — NOT from the stitch's injected `clock`. C5 measures that directly. The
// consequence for everything else is procedural: on a `manualClock` the throttle, the backoff and
// the circuit cooldown all run on virtual time while the signature's timestamp keeps ticking on
// wall time, so an age computed across the two is meaningless. Six virtual minutes of queueing —
// the interval where this scenario actually bites — cannot be measured with the shipped signer at
// all without waiting six real ones.
//
// So:
//   • `stampedSigV4` wraps the REAL `awsSigV4` and brackets its `apply` with wall-clock reads. It
//     measures the SHIPPED code path, on real time, over queue intervals short enough to run in a
//     few seconds. This is the instrument that keeps the findings honest.
//   • `clockSigV4` is ~20 lines of user code that mints the timestamp from an injected `Clock` and
//     hands it to the package's own exported `signRequestV4`. Same engine seam (`cfg.auth.apply`),
//     same signing function, same headers — only the clock source differs. It measures the same
//     ordering at virtual intervals large enough to cross the five-minute window.
//
// Both are used for C1–C4 and they must agree. Where they do, the ordering finding rests on the
// shipped code and the virtual-time run is just a magnifying glass. `clockSigV4` is also the
// answer to C5 and the foundation of C8, so it is written as production code, not test scaffolding.
import {
    EMPTY_PAYLOAD_SHA256,
    awsSigV4,
    signRequestV4,
} from '../../../../packages/aws-sigv4/src/index';
import type { AuthStrategy, Clock } from '../../../../packages/core/src/types';
import { amzDateOf } from './fake-aws';

/** One recorded signing: when `auth.apply` ran, and what timestamp it minted. */
export interface SignEvent {
    /** 1-based signing order. */
    n: number;
    /** Clock time at which `apply` was entered — the instant the engine reached the signing seam. */
    at: number;
    /** The `x-amz-date` this signing produced. */
    amzDate: string;
}

/** A mutable clock correction, shared between a failure handler and the signer. C7's whole subject. */
export interface SkewOffset {
    /** Milliseconds added to the clock before stamping. Starts at 0; a skew handler writes it. */
    ms: number;
}

export interface SignerOptions {
    region: string;
    service: string;
    accessKeyId: string;
    secretAccessKey: string;
}

export const CREDS: SignerOptions = {
    region: 'us-east-1',
    service: 's3',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

/**
 * The SHIPPED `awsSigV4`, bracketed so the moment its `apply` ran is recorded. Nothing about the
 * signing changes — this delegates to the real strategy and then reads back the `x-amz-date` it
 * wrote onto the request.
 *
 * `now` defaults to wall-clock because that is the only clock the wrapped strategy honours; passing
 * anything else would record a time the signature does not agree with, which is the very confusion
 * C5 is about.
 */
export function stampedSigV4(
    opts: SignerOptions,
    log: SignEvent[],
    now: () => number = Date.now,
): AuthStrategy {
    const inner = awsSigV4(opts);
    return {
        name: 'stampedSigV4',
        async apply(req, ctx) {
            const at = now();
            await inner.apply(req, ctx);
            log.push({
                n: log.length + 1,
                at,
                amzDate: req.headers['x-amz-date'] ?? '',
            });
        },
    };
}

/**
 * SigV4 signing that mints its timestamp from an INJECTED clock — the seam `awsSigV4` does not
 * expose. Everything else is the package's own `signRequestV4`, so the wire bytes are the same
 * shape the shipped strategy produces.
 *
 * `offset` is a mutable correction added before stamping. It is the entire mechanism behind
 * clock-skew correction (C7): a failure handler that learns the server's real time writes
 * `offset.ms`, and because the engine re-runs `auth.apply` on every attempt (C1), the NEXT attempt
 * signs with the corrected clock. Nothing needs to reach back into the signer.
 *
 * Deliberately payload-less (`EMPTY_PAYLOAD_SHA256`): every request in these proofs is a GET, which
 * is what the shipped strategy signs for a GET too (aws-sigv4/src/index.ts:307-313).
 */
export function clockSigV4(
    opts: SignerOptions & { clock: Clock; offset?: SkewOffset },
    log?: SignEvent[],
): AuthStrategy {
    return {
        name: 'clockSigV4',
        async apply(req, ctx) {
            // Stamped SYNCHRONOUSLY, before any await: the timestamp must be the instant the
            // engine reached this seam, not the instant the (genuinely async) Web Crypto work
            // happened to settle.
            const at = opts.clock.now() + (opts.offset?.ms ?? 0);
            const amzDate = amzDateOf(at);
            log?.push({ n: log.length + 1, at, amzDate });

            const url = new URL(req.url);
            req.headers['host'] = url.host;
            req.headers['x-amz-date'] = amzDate;
            req.headers['x-amz-content-sha256'] = EMPTY_PAYLOAD_SHA256;

            const { authorization } = await signRequestV4({
                method: req.method,
                url: req.url,
                headers: { ...req.headers },
                payloadHash: EMPTY_PAYLOAD_SHA256,
                accessKeyId: opts.accessKeyId,
                secretAccessKey: opts.secretAccessKey,
                region: opts.region,
                service: opts.service,
                amzDate,
            });
            req.headers['authorization'] = authorization;
            ctx.emit('auth', `clock sigv4 ${opts.service}/${opts.region}`);
        },
    };
}

/**
 * THE CONTROL — the bug, expressed in this library, so the instrument is shown to detect it.
 *
 * A measured age of 0 across a six-minute queue only means something if a genuinely sign-then-queue
 * construction measures something else through the SAME fake server and the SAME ledger. This is
 * that construction: the headers are computed ONCE, before the calls are enqueued, and replayed
 * verbatim on every `apply`. It is precisely the shape AWS describes — *"the SDK signs the request,
 * and then puts the request in a queue"* — and precisely what a hand-rolled `presign(); await
 * limiter.acquire(); send()` does.
 *
 * It is also not a straw man. Pre-signing outside the engine is what someone reaches for when they
 * want the signature to cover something the strategy cannot see, and nothing in the config
 * vocabulary discourages it.
 */
export function presignedSigV4(
    headers: Readonly<Record<string, string>>,
): AuthStrategy {
    return {
        name: 'presignedSigV4',
        apply(req) {
            Object.assign(req.headers, headers);
        },
    };
}

/**
 * Compute one SigV4 header set for `url` at instant `at` — the input to {@link presignedSigV4}, and
 * the "what does hand-rolling this cost" baseline C8 counts lines against.
 */
export async function presign(
    opts: SignerOptions,
    url: string,
    at: number,
    method = 'GET',
): Promise<Record<string, string>> {
    const amzDate = amzDateOf(at);
    const host = new URL(url).host;
    const headers: Record<string, string> = {
        host,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256,
    };
    const { authorization } = await signRequestV4({
        method,
        url,
        headers: { ...headers },
        payloadHash: EMPTY_PAYLOAD_SHA256,
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
        region: opts.region,
        service: opts.service,
        amzDate,
    });
    headers['authorization'] = authorization;
    return headers;
}
