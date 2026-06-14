// 128-bit synchronous non-cryptographic hash (xxHash family) — the ONE key/fingerprint primitive.
//
// Shared by the response cache (ADR 0003: the derived opaque request key) and the Standard Schema
// fingerprint (ADR 0004: the cache-generation token). It lives in its own tiny module — NOT in
// `util.ts`, which the engine/stitch hot path imports, because a BigInt hash there would tax every
// cache-free stitch (bundle-frugal gate). Both importers (`cache.ts`, `fingerprint.ts`) are
// off-the-hot-path subpaths reached only when a `cache` block is present, so this code never lands
// in the main bundle.
//
// The digest is two XXH64 passes (seeds A and B) over the canonical string's UTF-8 bytes — a
// well-specified, bit-stable xxHash member needing only 64-bit integer math (BigInt; JS has no
// native u64) and no async/WebCrypto (`crypto.subtle.digest` is async and a JS crypto hash is
// bundle weight). 128 bits puts a collision past ~2^64 entries — unreachable — so the cache needs
// no verify-on-read (which would mean storing the plaintext request beside the value, re-introducing
// the leak the opaque key avoids). The algorithm is frozen behind the cache's KEY_VERSION: any
// change to it is a key-schema bump (a mass self-healing miss, never a stale-key hit).

const MASK64 = (1n << 64n) - 1n;
const P1 = 11400714785074694791n;
const P2 = 14029467366897019727n;
const P3 = 1609587929392839161n;
const P4 = 9650029242287828579n;
const P5 = 2870177450012600261n;
const SEED_A = 0n;
const SEED_B = 0x9e3779b185ebca87n; // a second, independent seed → the high 64 bits

const mul = (a: bigint, b: bigint): bigint => (a * b) & MASK64;
const rotl = (x: bigint, r: bigint): bigint =>
    ((x << r) | (x >> (64n - r))) & MASK64;
const xxhRound = (acc: bigint, input: bigint): bigint =>
    mul(rotl((acc + mul(input, P2)) & MASK64, 31n), P1);
const mergeRound = (acc: bigint, val: bigint): bigint =>
    (mul(acc ^ xxhRound(0n, val), P1) + P4) & MASK64;

// All reads are bounds-guaranteed by the callers' stripe arithmetic; `?? 0` keeps the indexed
// access total without a non-null assertion (noUncheckedIndexedAccess).
function read64LE(b: Uint8Array, i: number): bigint {
    let v = 0n;
    for (let j = 7; j >= 0; j--) v = (v << 8n) | BigInt(b[i + j] ?? 0);
    return v;
}
function read32LE(b: Uint8Array, i: number): bigint {
    return BigInt(
        ((b[i] ?? 0) |
            ((b[i + 1] ?? 0) << 8) |
            ((b[i + 2] ?? 0) << 16) |
            ((b[i + 3] ?? 0) << 24)) >>>
            0,
    );
}

function xxh64(b: Uint8Array, seed: bigint): bigint {
    const len = b.length;
    let h: bigint;
    let p = 0;
    if (len >= 32) {
        let v1 = (seed + P1 + P2) & MASK64;
        let v2 = (seed + P2) & MASK64;
        let v3 = seed & MASK64;
        let v4 = (seed - P1) & MASK64;
        const limit = len - 32;
        while (p <= limit) {
            v1 = xxhRound(v1, read64LE(b, p));
            p += 8;
            v2 = xxhRound(v2, read64LE(b, p));
            p += 8;
            v3 = xxhRound(v3, read64LE(b, p));
            p += 8;
            v4 = xxhRound(v4, read64LE(b, p));
            p += 8;
        }
        h =
            (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) &
            MASK64;
        h = mergeRound(h, v1);
        h = mergeRound(h, v2);
        h = mergeRound(h, v3);
        h = mergeRound(h, v4);
    } else {
        h = (seed + P5) & MASK64;
    }
    h = (h + BigInt(len)) & MASK64;
    while (p + 8 <= len) {
        h ^= xxhRound(0n, read64LE(b, p));
        h = (mul(rotl(h, 27n), P1) + P4) & MASK64;
        p += 8;
    }
    if (p + 4 <= len) {
        h ^= mul(read32LE(b, p), P1);
        h = (mul(rotl(h, 23n), P2) + P3) & MASK64;
        p += 4;
    }
    while (p < len) {
        h ^= mul(BigInt(b[p] ?? 0), P5);
        h = mul(rotl(h, 11n), P1);
        p += 1;
    }
    h ^= h >> 33n;
    h = mul(h, P2);
    h ^= h >> 29n;
    h = mul(h, P3);
    h ^= h >> 32n;
    return h & MASK64;
}

const encoder = new TextEncoder();
const toHex16 = (v: bigint): string => v.toString(16).padStart(16, '0');

/** A 128-bit synchronous non-cryptographic digest of `input` as a 32-char hex string. */
export function xxh128(input: string): string {
    const bytes = encoder.encode(input);
    return toHex16(xxh64(bytes, SEED_A)) + toHex16(xxh64(bytes, SEED_B));
}
