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
import { xxh128 } from './hash';
import { type StandardSchemaV1, isStandardSchema } from './standard-schema';

// ---------------------------------------------------------------------------
// hash primitive — synchronous, browser-safe, non-crypto, no dependency
// ---------------------------------------------------------------------------

// The fingerprint token rides the SAME 128-bit xxh128 the cache key uses — the swap this module's
// FNV-1a placeholder always anticipated, now that ADR 0003's cache is wired. One well-tested
// primitive: computed once at stitch-definition time, never on the hot path. A COLLISION (two
// different contracts → same token) is the only unsafe failure — it would under-invalidate — and
// 128 bits puts that past ~2^64 distinct schemas, unreachable. WebCrypto is async and Node `crypto`
// is not browser-safe, so neither is usable here (browser-first gate). The token is opaque, so the
// one-time change in its bytes from the old FNV form is a safe over-invalidation (no production
// users; any cached values self-heal under TTL).

/** Stable non-crypto hash of a string → an opaque 128-bit token (32-char hex). */
export function hash(input: string): string {
    return xxh128(input);
}

// ---------------------------------------------------------------------------
// contract
// ---------------------------------------------------------------------------

/**
 * The result of fingerprinting one schema.
 *
 * `token` is an opaque, stable token that MUST change whenever the schema's
 * validation/shape semantics change, and MUST be equal for two structurally
 * identical schemas. `token === null` is the strategy ABSTAINING: it has
 * encountered something it cannot soundly capture (an opaque `.refine`/
 * `.transform`, an unrepresentable type) and is signalling that the caller must
 * fall back rather than trust a possibly-colliding token.
 *
 * `strength` mirrors HTTP ETag semantics (RFC 9110): a `'strong'` fingerprint
 * changes on any observable structural change; a `'weak'` one may stay equal
 * across owner-declared equivalences. Strong is the safe default.
 */
export interface SchemaFingerprint {
    readonly token: string | null;
    /** @deprecated Renamed to {@link SchemaFingerprint.token} (CONTRACT.md P5: `value` is the success payload, not a token). Read until the 1.0 GA cut. */
    readonly value?: string | null;
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
 * - `fast` — the stored value is bound to a known token (or to nothing — no output
 *   schema); serve it without re-validating, and fold `generation` into the cache
 *   generation.
 * - `revalidate` — opt-in (`onUnfingerprintable: 'revalidate'`): cache despite an
 *   un-fingerprintable schema, but re-validate the stored value against the current
 *   schema on every hit. Catches schema changes that REJECT the stored value;
 *   assumes validation is idempotent (no coercion/transform inside the schema).
 * - `refuse` — do not cache. The default when a schema can't be soundly
 *   fingerprinted (unknown/unregistered vendor, non-Standard-Schema validator, or
 *   the strategy abstained), and always when an un-versioned `transform` is present
 *   (which re-validation cannot detect).
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
    /**
     * Policy when an OUTPUT SCHEMA is present but can't be soundly fingerprinted
     * (unknown/unregistered vendor, non-Standard-Schema validator, or the strategy
     * abstained). `'refuse'` (the default) does not cache — fail closed, and a
     * clear nudge to register the vendor's fingerprint package. `'revalidate'`
     * caches but re-validates on every hit (network savings, but only sound for
     * pure validators — see {@link CachePolicy}).
     */
    readonly onUnfingerprintable?: 'refuse' | 'revalidate' | undefined;
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
 * 2. an un-versioned `transform` is present → `refuse` (re-validation can't see a
 *    transform change, so neither fast nor revalidate is sound);
 * 3. a registered strategy returns a non-null token → fast path, token folded
 *    into `generation`;
 * 4. no output schema at all → fast (nothing validated, so no shape to go stale);
 * 5. an output schema is present but un-fingerprintable → `onUnfingerprintable`
 *    (default `refuse`; opt into `revalidate`).
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

    // rung 2 — un-versioned transform: re-validation can't detect a transform
    // change (a stale value still satisfies an unchanged schema), so refuse.
    if (!xSound) {
        return {
            generation: '',
            policy: 'refuse',
            reason: 'opaque transform without cache.transformVersion or trustTransform. Fix: set cache.transformVersion when you change the transform, or cache.trustTransform: true to opt out.',
        };
    }

    // rung 3 — sound structural fingerprint → fast path. Prefer `token`; fall back to the
    // @deprecated `value` so an external fingerprinter still on the old spelling keeps working.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- back-compat fallback for the renamed `value` alias (CONTRACT.md P5)
    const token = fp?.token ?? fp?.value;
    if (token != null) {
        return {
            generation: hash(
                `s|${vendor}|${token}|${fp?.strength}|u|${unwrap}|${xTag}`,
            ),
            policy: 'fast',
            reason: 'sound structural fingerprint',
        };
    }

    // rung 4 — no output schema: the stored value is bound to no shape, so there
    // is nothing to go stale. Cache fast; `unwrap`/transform tag still fold in.
    if (input.output == null) {
        return {
            generation: hash(`noschema|u|${unwrap}|${xTag}`),
            policy: 'fast',
            reason: 'no output schema',
        };
    }

    // rung 5 — an output schema is present but can't be soundly fingerprinted.
    // Default to refusing (fail closed); a caller may opt into re-validate-on-hit.
    const reason = vendor
        ? fp
            ? `fingerprint strategy for '${vendor}' abstained. Fix: set cache.version, or onUnfingerprintable: 'revalidate'.`
            : `no fingerprinter registered for '${vendor}'. Fix: install @stitchapi/fingerprint-${vendor}, set cache.version, or onUnfingerprintable: 'revalidate'.`
        : "output is not a Standard Schema, so a stale value can't be detected. Fix: set cache.version, pass onUnfingerprintable: 'revalidate', or use a blessed validator with a fingerprint-* vendor pkg.";
    return {
        generation: '',
        policy:
            input.onUnfingerprintable === 'revalidate'
                ? 'revalidate'
                : 'refuse',
        reason,
    };
}
