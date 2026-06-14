// Standard Schema fingerprint contract (ADR 0004).
//
// The response cache (ADR 0003) stores the post-validation value and skips
// re-validation on a hit, so a stored value is bound to the `output` schema
// (plus `transform`/`unwrap`) it was validated against. Ship a changed schema and
// a hit would serve an old-shape value for the whole TTL. This module computes a
// stable FINGERPRINT that folds into the cache GENERATION so a contract change
// auto-invalidates.
//
// A generic fingerprint is impossible from the Standard Schema spec alone — the
// `~standard` surface exposes only `version`/`vendor`/an opaque `validate`/phantom
// `types` — so structural fingerprinting is per-validator. Core ships only this
// CONTRACT (a {@link SchemaFingerprinter} interface + a registry) and the
// {@link resolveFingerprint} fallback ladder; the per-vendor strategies live in
// their own packages (`@stitchapi/fingerprint-*`) with the validator as a peer
// dependency, each proving compliance via `verifyFingerprintContract`
// (`stitchapi/testing`). No validator ever enters core's dependency graph.
import { type StandardSchemaV1, isStandardSchema } from './standard-schema';

// ---------------------------------------------------------------------------
// hash primitive — synchronous, browser-safe, non-crypto, no dependency
// ---------------------------------------------------------------------------

// FNV-1a over UTF-16 code units, 64-bit, rendered base36. Computed once at
// stitch-definition time, never on the hot path, so a non-crypto hash is fine.
// A COLLISION (two different contracts → same token) is the only unsafe failure,
// because it would under-invalidate; 64 bits keeps that probability negligible
// for any realistic number of distinct schemas. WebCrypto is async + Node `crypto`
// is not browser-safe, so neither is usable here (browser-first gate). The token
// is opaque: ADR 0003 may later swap this for the shared xxh128 key primitive — a
// one-time, safe over-invalidation — without changing this contract.
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** Stable non-crypto hash of a string → a short opaque token. */
export function hash(input: string): string {
    let h = FNV_OFFSET;
    for (let i = 0; i < input.length; i++) {
        const c = input.charCodeAt(i);
        h = ((h ^ BigInt(c & 0xff)) * FNV_PRIME) & MASK64;
        h = ((h ^ BigInt((c >> 8) & 0xff)) * FNV_PRIME) & MASK64;
    }
    // Length-prefix adds a cheap extra discriminator against collisions.
    return `${input.length.toString(36)}_${h.toString(36)}`;
}

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

/**
 * The result of fingerprinting one schema.
 *
 * `value` is an opaque, stable token that MUST change whenever the schema's
 * validation/shape semantics change, and MUST be equal for two structurally
 * identical schemas. `value === null` is the strategy ABSTAINING: it has
 * encountered something it cannot soundly capture (an opaque `.refine`/
 * `.transform`, an unrepresentable type) and is signalling that the caller must
 * fall back rather than trust a possibly-colliding token.
 *
 * `strength` mirrors HTTP ETag semantics (RFC 9110): a `'strong'` fingerprint
 * changes on any observable structural change; a `'weak'` one may stay equal
 * across owner-declared equivalences. Strong is the safe default.
 */
export interface SchemaFingerprint {
    readonly value: string | null;
    readonly strength: 'strong' | 'weak';
}

/**
 * A per-validator fingerprint strategy. Implemented by `@stitchapi/fingerprint-*`
 * packages and registered via {@link registerFingerprinter}.
 *
 * `fingerprint` MUST be synchronous and browser-safe (no `node:*`, no async),
 * because it runs on the path that derives the cache generation.
 */
export interface SchemaFingerprinter {
    /** The `~standard.vendor` this strategy handles, e.g. `'zod'`. */
    readonly vendor: string;
    /** The validator major-version range it is proven against, e.g. `'^4'`. */
    readonly supports: string;
    fingerprint(schema: StandardSchemaV1): SchemaFingerprint;
}

// ---------------------------------------------------------------------------
// registry — process-local, like the other core seams
// ---------------------------------------------------------------------------

const registry = new Map<string, SchemaFingerprinter>();

/** Register a per-vendor fingerprint strategy (last registration wins). */
export function registerFingerprinter(fp: SchemaFingerprinter): void {
    registry.set(fp.vendor, fp);
}

/** The strategy registered for a `~standard.vendor`, if any. */
export function getFingerprinter(
    vendor: string,
): SchemaFingerprinter | undefined {
    return registry.get(vendor);
}

/** Every registered strategy (registration order not guaranteed). */
export function listFingerprinters(): readonly SchemaFingerprinter[] {
    return [...registry.values()];
}

/** Drop all registrations — for tests. */
export function clearFingerprinters(): void {
    registry.clear();
}

// ---------------------------------------------------------------------------
// resolver — the ADR 0004 fallback ladder
// ---------------------------------------------------------------------------

/**
 * What the cache may do with a stitch given its fingerprint:
 * - `fast` — the stored value is bound to a known token; serve it without
 *   re-validating, and fold `generation` into the cache generation.
 * - `revalidate` — the schema can't be fingerprinted; cache, but re-validate the
 *   stored value against the current schema on every hit (catches schema changes).
 * - `refuse` — an un-versioned `transform` is present, which re-validation cannot
 *   detect; do not cache this stitch.
 */
export type CachePolicy = 'fast' | 'revalidate' | 'refuse';

/**
 * The fingerprint-relevant slice of a stitch's config. Decoupled from the full
 * cache config (ADR 0003, not yet implemented) so the resolver is a pure function
 * the future cache wires in.
 */
export interface FingerprintInput {
    /** `config.output` — a Standard Schema, `Validator`, or `DriftSpec`. */
    readonly output?: unknown;
    /** `config.transform` — opaque; cannot be soundly hashed (see ADR 0004 §6). */
    readonly transform?: ((body: unknown) => unknown) | undefined;
    /** `config.unwrap` — a dot-path string; serialisable, so always sound. */
    readonly unwrap?: string | undefined;
    /** Explicit `cache.version` — authoritative override; always wins. */
    readonly version?: string | number | undefined;
    /** A user tag making an opaque `transform` sound. */
    readonly transformVersion?: string | number | undefined;
    /** Opt-in: cache despite an un-versioned `transform`, bounded only by TTL. */
    readonly trustTransform?: boolean | undefined;
}

export interface FingerprintResolution {
    /** Token to fold into the ADR 0003 cache generation (empty when not caching the fast way). */
    readonly generation: string;
    readonly policy: CachePolicy;
    /** Human-readable explanation of the chosen policy, for observability. */
    readonly reason: string;
}

function vendorOf(schema: unknown): string | undefined {
    return isStandardSchema(schema) ? schema['~standard'].vendor : undefined;
}

/**
 * Resolve a stitch's fingerprint and caching policy via the ADR 0004 ladder
 * (highest precedence first):
 *
 * 1. explicit `version` → authoritative fast path;
 * 2. a registered strategy returns a non-null token AND the transform is sound
 *    (absent / versioned / trusted) → fast path, token folded into `generation`;
 * 3. the schema can't be fingerprinted but the transform is sound → `revalidate`;
 * 4. an un-versioned `transform` is present → `refuse` (re-validation can't see it).
 */
export function resolveFingerprint(
    input: FingerprintInput,
): FingerprintResolution {
    const unwrap = input.unwrap ?? '';

    // rung 1 — explicit cache.version is authoritative.
    if (input.version != null) {
        return {
            generation: hash(`v|${input.version}|u|${unwrap}`),
            policy: 'fast',
            reason: 'explicit cache.version',
        };
    }

    // transform soundness — an opaque closure is not soundly hashable (ADR 0004 §6).
    let xTag: string;
    let xSound: boolean;
    if (!input.transform) {
        xTag = 'x:none';
        xSound = true;
    } else if (input.transformVersion != null) {
        xTag = `x:v:${input.transformVersion}`;
        xSound = true;
    } else if (input.trustTransform) {
        xTag = 'x:trusted';
        xSound = true;
    } else {
        xTag = 'x:opaque';
        xSound = false;
    }

    // schema soundness — delegated to the registered per-vendor strategy.
    const vendor = vendorOf(input.output);
    const fp = vendor
        ? getFingerprinter(vendor)?.fingerprint(
              input.output as StandardSchemaV1,
          )
        : undefined;

    // rung 4 — un-versioned transform: re-validation can't detect a transform
    // change (a stale value still satisfies an unchanged schema), so refuse.
    if (!xSound) {
        return {
            generation: '',
            policy: 'refuse',
            reason: 'opaque transform without cache.transformVersion or trustTransform',
        };
    }

    // rung 2 — sound structural fingerprint → fast path.
    if (fp?.value != null) {
        return {
            generation: hash(
                `s|${vendor}|${fp.value}|${fp.strength}|u|${unwrap}|${xTag}`,
            ),
            policy: 'fast',
            reason: 'sound structural fingerprint',
        };
    }

    // rung 3 — schema not fingerprintable, transform sound → re-validate on hit.
    return {
        generation: '',
        policy: 'revalidate',
        reason:
            input.output == null
                ? 'no output schema'
                : vendor
                  ? fp
                      ? `fingerprint strategy for '${vendor}' abstained`
                      : `no fingerprinter registered for '${vendor}'`
                  : 'output is not a Standard Schema',
    };
}
