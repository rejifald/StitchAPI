// USER CODE — the half StitchAPI does not have. A Stripe-shaped webhook signature, signed and
// verified over the RAW request bytes with `node:crypto`.
//
// This file exists in the proofs because nothing in `packages/*/src` does it (C2), so every claim
// that needs a genuine signature has to bring one. It is also the subject of C7's line count: this
// is what you write yourself, and it is the boundary made concrete.
//
// The scheme is Stripe's, because it is the one the capture names:
//
//   Stripe-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
//   signed payload   = `${t}.${rawBody}`          ← the RAW bytes, not a re-serialised object
//   verify           = timing-safe compare, then |now - t| <= tolerance
//
// Three details are the ones that are easy to get wrong, and all three are load-bearing here:
//   1. The MAC covers `${t}.${raw}` — the timestamp is INSIDE the MAC, so it cannot be moved.
//   2. The compare is `timingSafeEqual`, which throws on a length mismatch — hence the length
//      guard before it (a 63-char `v1=` would otherwise crash the handler rather than reject).
//   3. The tolerance check is separate from the MAC check. A valid MAC on a 2-hour-old timestamp
//      is a replay, and passing the MAC is not enough to accept it.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Default replay tolerance, in seconds — Stripe's own default. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Why a delivery was rejected. `ok` carries the reason for the assertions to read. */
export type VerifyResult =
    | { ok: true }
    | {
          ok: false;
          reason: 'malformed' | 'bad-signature' | 'stale' | 'future';
      };

/**
 * Produce the header a provider would send for these exact bytes. Used by the fake provider and by
 * every proof that needs a genuine signature; `raw` is a `Buffer` on purpose, so a caller cannot
 * accidentally sign a re-serialised string without noticing.
 */
export function signPayload(
    raw: Buffer,
    secret: string,
    timestampSeconds: number,
): string {
    const mac = createHmac('sha256', secret)
        .update(`${timestampSeconds}.`)
        .update(raw)
        .digest('hex');
    return `t=${timestampSeconds},v1=${mac}`;
}

/** Parse `t=…,v1=…` into its parts. Unknown scheme versions are ignored, as Stripe's own does. */
function parseHeader(header: string): { t: number; v1: string } | undefined {
    let t: number | undefined;
    let v1: string | undefined;
    for (const part of header.split(',')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const key = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (key === 't') t = Number(value);
        else if (key === 'v1') v1 = value;
    }
    if (t === undefined || !Number.isFinite(t) || v1 === undefined)
        return undefined;
    return { t, v1 };
}

/**
 * Verify a delivery. `raw` MUST be the bytes off the socket — the whole point of the exercise.
 * `nowSeconds` is injected so the tolerance boundary is testable without sleeping.
 */
export function verifySignature(
    raw: Buffer,
    header: string | undefined,
    secret: string,
    nowSeconds: number,
    toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): VerifyResult {
    if (!header) return { ok: false, reason: 'malformed' };
    const parts = parseHeader(header);
    if (!parts) return { ok: false, reason: 'malformed' };

    const expected = createHmac('sha256', secret)
        .update(`${parts.t}.`)
        .update(raw)
        .digest('hex');

    // `timingSafeEqual` THROWS on differing lengths, so the length is compared first — in the
    // clear, which leaks nothing a hex-digest length does not already tell an attacker.
    const got = Buffer.from(parts.v1, 'utf8');
    const want = Buffer.from(expected, 'utf8');
    if (got.length !== want.length)
        return { ok: false, reason: 'bad-signature' };
    if (!timingSafeEqual(got, want))
        return { ok: false, reason: 'bad-signature' };

    // A correct MAC on an old timestamp is a REPLAY, which is why this check is not folded into
    // the one above. The future arm catches a badly-skewed sender rather than an attack.
    const drift = nowSeconds - parts.t;
    if (drift > toleranceSeconds) return { ok: false, reason: 'stale' };
    if (drift < -toleranceSeconds) return { ok: false, reason: 'future' };
    return { ok: true };
}
