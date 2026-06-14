# ADR 0004 — Standard Schema fingerprint for cache invalidation

-   **Status:** Accepted (contract + kit + vendor packages implemented; cache wiring folds into [ADR 0003](0003-derived-key-response-cache-and-coalescing.md) when its response cache lands)
-   **Date:** 2026-06-14
-   **Tags:** caching, validation, schema, standard-schema, contract-not-dependency, runtime

## Context

[ADR 0003](0003-derived-key-response-cache-and-coalescing.md) makes one decision
that this ADR exists to backstop. Decision 2 there stores the **fully-resolved,
post-validation `T`** and returns it on a hit **without re-validating**:

> The stored value is the fully-resolved `T` — after `transform`/`unwrap` and
> after output validation + drift. A hit returns it directly: no re-validation,
> no drift pass on the hit path. … a stored value is **bound to the output
> contract it was validated against**. Ship a changed `output` schema and a hit
> would return an old-shape value that violates the new one — silently, for the
> whole TTL. So an **output-schema fingerprint must fold into the generation
> (decision 8)** so a schema change invalidates the bucket.

ADR 0003 named the failure and the escape hatch (re-validate-on-hit "as the safe
default for any stitch whose schema can't be fingerprinted") but deferred the
fingerprint itself. This ADR specifies it.

The stored value is produced by a three-step pipeline
([`engine.ts`](../../packages/core/src/engine.ts)) — **`body → transform →
unwrap → validateOutput`** — so the value is bound to **all three** of
`config.output`, `config.transform`, and `config.unwrap`
([`types.ts`](../../packages/core/src/types.ts)), not the output schema alone.
The fingerprint must cover the whole pipeline.

### Why this is genuinely hard

A [Standard Schema](https://standardschema.dev) validator is a closure graph with
no universal serialisation. The shared runtime surface — the `~standard`
property — exposes only four members
([spec source `index.ts`](https://github.com/standard-schema/standard-schema/blob/main/packages/spec/src/index.ts)):

```ts
interface StandardSchemaV1Props {
    readonly version: 1; // always the literal 1
    readonly vendor: string; // 'zod' | 'valibot' | … (library, not schema)
    readonly validate: (value: unknown) => Result | Promise<Result>; // opaque
    readonly types?: { input; output }; // TYPE-ONLY (phantom; often `declare`d)
}
```

None of these carries runtime-readable shape. `vendor` names the **library**, so
every Zod schema shares `'zod'` and it cannot tell two Zod schemas apart.
`validate` is an opaque closure. `types` is phantom — read only by the
type-checker, frequently `declare`d to avoid runtime cost. **A generic,
spec-only structural fingerprint is therefore impossible; introspection is
irreducibly per-validator.** (Primary source: spec `index.ts`; corroborated by
[`zod.dev/library-authors`](https://zod.dev/library-authors), which tells library
authors doing black-box validation to use the Standard Schema interface precisely
_because_ it is opaque.)

### Constraints carried in from the gates

-   **Contract, not dependency** ([FEATURE-LENSES](../FEATURE-LENSES.md)): core
    ships a fingerprint **contract + platform defaults only** and never grows a
    validator dependency. Per-validator strategies are separate packages with the
    validator as a **peer** dependency, each proving compliance via the
    conformance kit (`stitchapi/testing`).
-   **Browser-first + bundle-frugal:** the hot path must stay free of `node:*`,
    WebCrypto-async, and any heavy converter. The fingerprint is **synchronous**
    and a **non-crypto** hash; it is computed **once at stitch-definition time**,
    never per request.
-   **Declarative spelling:** every capability needs a JSON-serialisable spelling.
    `transform` is "sugar, never the only way." The declarative escape hatch here
    is an explicit `cache.version`, which always round-trips as data.

## Decisions

### 1 — The fingerprint is a contract with a registry, not a built-in

Core ships a small, dependency-free contract and a vendor registry keyed on
`~standard.vendor`:

```ts
/** Opaque token; `value: null` means "I cannot soundly fingerprint this". */
export interface SchemaFingerprint {
    readonly value: string | null;
    readonly strength: 'strong' | 'weak'; // see Decision 5
}

export interface SchemaFingerprinter {
    readonly vendor: string; // the ~standard.vendor it handles
    readonly supports: string; // validator major range it is proven for, e.g. '^4'
    /** SYNCHRONOUS + browser-safe. Returns null to ABSTAIN → conservative fallback. */
    fingerprint(schema: StandardSchemaV1): SchemaFingerprint;
}

export function registerFingerprinter(fp: SchemaFingerprinter): void;
```

Vendor packages — `@stitchapi/fingerprint-zod`, `-valibot`, `-arktype`,
`-effect`, `-typebox` — register a strategy and prove it with the conformance kit
(see [Conformance-test shape](#conformance-test-shape)). Core's only default is
**no registered strategy → conservative
fallback** (Decision 4). This keeps the validator out of core's dependency graph,
satisfies the contract-not-dependency gate, and lets a vendor strategy use a
heavy converter (e.g. `z.toJSONSchema`) **inside its own package** — it runs once
at definition time and never enters core's call path or bundle.

This mirrors prior art precisely: **tRPC and Zodios deliberately do _not_ hash
schemas at runtime** — they lean on build-time TypeScript type-sharing and key
only on path + input values
([tRPC `getQueryKey.ts`](https://github.com/trpc/trpc/blob/main/packages/react-query/src/internals/getQueryKey.ts),
[Zodios `hooks.ts`](https://github.com/ecyrbe/zodios-react/blob/main/src/hooks.ts)).
A changed _output_ schema busts nothing at runtime in either. So a runtime schema
fingerprint is **novel surface area**, and its justification is exactly the case
those tools cannot serve: **cross-process / cross-deploy invalidation** when a
shipped schema change would otherwise serve stale-shape values for the whole TTL.

### 2 — The fingerprint covers the whole stored-value pipeline, and its parts have different soundness

The fingerprint input is the canonical composition of three contributions:

| Part          | Source                   | Serialisable?        | Soundness                                                    |
| ------------- | ------------------------ | -------------------- | ------------------------------------------------------------ |
| `S` schema    | `config.output`          | only via strategy    | sound **iff** a compliant strategy captures it fully, else ⊥ |
| `U` unwrap    | `config.unwrap` (string) | **yes** (a dot-path) | always sound — hash the string verbatim                      |
| `X` transform | `config.transform` (fn)  | **no** (closure)     | sound **iff** absent or carries an explicit version, else ⊥  |

`U` is trivially sound — it is already a string. The asymmetry that drives the
whole design is between `S` and `X`:

-   **A changed `S` is caught by re-validating on hit** — the stored value stops
    satisfying the new schema, so the hit misses and refetches. Re-validation is a
    safe degraded mode for the schema.
-   **A changed `X` is _not_ caught by re-validating on hit.** If only the
    `transform` changes (e.g. a clamp constant moves) but the schema is unchanged,
    the stale value still validates and is served. Re-validation gives **no**
    protection here. This is the sharp edge that forces a stricter default for
    transforms (Decision 4, rung 4).

### 3 — The fingerprint primitive

-   **Opaque token**, like an HTTP `ETag`: a short stable string that changes iff
    the contract's observable shape changes, whose construction the cache layer
    need not understand (RFC 9110 §8.8: _"Since the value is opaque, there is no
    need for the client to be aware of how each entity tag is constructed"_).
-   **Computed once at stitch-definition time**, cached on the stitch. The hot
    path reads a precomputed string — nothing to hash per request.
-   **Hashed with the same 128-bit non-crypto sync primitive ADR 0003 mandates
    for the cache key** (xxh128-class). No new dependency, no WebCrypto-async.
-   **Folded into the ADR 0003 _generation_, not the per-call key.** ADR 0003
    Decision 8 already bumps a per-stitch generation counter to bulk-invalidate.
    The fingerprint simply becomes part of that generation namespace: when it
    changes, every prior-generation entry becomes unreachable and TTLs out on its
    own. **No new store mechanism, no key enumeration, no `SCAN`.**

```ts
// core, at stitch-definition time (sketch)
function stitchGeneration(cfg: StitchConfig): string {
    const unwrap = cfg.unwrap ?? '';
    if (cfg.cache?.version != null) return h(['v', cfg.cache.version, unwrap]); // rung 1 — authoritative

    const vendor = (cfg.output as StandardSchemaV1)?.['~standard']?.vendor;
    const fp = vendor
        ? registry.get(vendor)?.fingerprint(cfg.output)
        : undefined;

    const xTag = !cfg.transform
        ? 'x:none'
        : cfg.cache?.transformVersion != null
          ? `x:${cfg.cache.transformVersion}`
          : 'x:OPAQUE';

    if (fp?.value != null && xTag !== 'x:OPAQUE')
        return h([vendor, fp.value, fp.strength, unwrap, xTag]); // rung 2 — sound

    return DEGRADED; // rung 3/4 — policy decides re-validate vs refuse
}
```

### 4 — The fallback ladder (and the defaults)

Resolved once per stitch, highest precedence first:

1.  **Explicit `cache.version` → authoritative.** The user owns correctness; the
    fingerprint is `hash(version, unwrap)`. JSON-serialisable, satisfies the
    declarative-spelling gate, and is the always-available manual override. Fast
    path (skip re-validate-on-hit).
2.  **Sound structural fingerprint** — a compliant strategy is registered for the
    vendor **and** reports full capture (`value !== null`), **and** the transform
    is absent or versioned. Fold `hash(vendor, S, U, X)` into the generation.
    Fast path.
3.  **Schema un-fingerprintable** (no strategy, unknown vendor, converter throws,
    or strategy abstains) **but transform sound** → **re-validate-on-hit**
    (default). Catches schema changes by re-checking the stored value against the
    current schema; the only cost is one validation pass on the hit. This is the
    default ADR 0003 already named. `refuse-to-cache` is the strict opt-in.
4.  **Un-versioned `transform` present** → re-validate-on-hit cannot see a
    transform change (Decision 2), so the safe default **escalates to
    refuse-to-cache**, unless the user supplies `cache.transformVersion` (→ rung 2)
    or explicitly opts into `cache.trustTransform: true` (cache anyway, bounded
    only by TTL).

**Recommended defaults:**

| Situation                                                     | Default behaviour                          |
| ------------------------------------------------------------- | ------------------------------------------ |
| Known vendor + serialisable pipeline (no/versioned transform) | auto-fingerprint, fast path                |
| Unknown vendor / lossy schema / strategy abstains             | re-validate-on-hit (safe, slightly slower) |
| Un-versioned `transform` present                              | refuse-to-cache (re-validate can't see it) |
| Anything                                                      | `cache.version` overrides everything       |

### 5 — Strong vs weak, and "fail toward over-invalidation"

Borrowing RFC 9110's validator taxonomy:

-   A **strong** fingerprint changes on **any** observable structural change
    (RFC 9110 §8.8.1: a strong validator _"changes value whenever a change occurs
    to the representation data that would be observable"_). **This is the
    default.**
-   A **weak** fingerprint may stay equal across owner-declared equivalences
    (e.g. a description-only edit). It is an opt-in optimisation, marked so the
    cache layer can choose comparison semantics, exactly as ETag marks weak
    validators `W/`.

The governing safety rule, true of every prior-art system surveyed:
**fail toward over-invalidation, never under-invalidation.** A spurious cache
miss costs a refetch; a _missed_ invalidation serves a contract-violating value
for the whole TTL — the precise bug this ADR prevents. When a strategy is
unsure, it must make the fingerprint **change** (or abstain → fallback), never
hold steady.

### 6 — The opaque parts: `.refine()` / `.transform()` / custom predicates

These cannot be soundly fingerprinted from the closure, and **function-source
hashing (`Function.prototype.toString`) is not a sound option:**

-   **Minifiers rewrite the source.** terser/swc rename identifiers and reformat
    whitespace, so `toString` differs across builds for identical logic — churn
    (safe but wasteful) — and the
    [TC39 stricter-`toString` proposal](https://github.com/tc39/proposal-stricter-function-tostring)
    can return a placeholder body, **erasing** the logic — which would make
    different logic hash the **same** (unsafe).
-   **Closures capture values the source text does not show.** `(b) => clamp(b,
MAX)` has identical source regardless of `MAX`; a changed `MAX` is a changed
    contract with an unchanged `toString`. This false-negative is the decisive
    argument: source hashing can serve stale values.

Therefore opaque logic is handled by **abstain-or-version**, never by hashing it:

-   If a strategy encounters an opaque `.refine`/`.transform`/`.brand`/predicate
    it cannot represent, it **abstains** (`value: null`) → conservative fallback.
-   `config.transform` is opaque to core. Its provenance enters the fingerprint
    only as `cache.transformVersion` (a user tag) or it forces rung 4.

This is exactly how every prior-art system treats non-serialisable logic:
GraphQL schema hashing excludes resolvers from the SDL ("the hash describes the
contract, not the implementation"); ETag pushes the "what counts as the same"
decision to the side that owns the logic; TanStack Query keeps `select`/`queryFn`
out of the key entirely.

## Per-validator strategy sketches

JSON Schema is a **necessary-but-insufficient** common substrate. The
StandardJSONSchemaV1 _sister_ spec (merged Dec 2025, opt-in, limited adoption)
and per-validator converters exist, but JSON Schema is **irreducibly lossy for
exactly the semantic-bearing parts a fingerprint must capture**: transforms are
dropped or throw, refinements/brands/custom error maps are **silently dropped**,
and many types (bigint/date/map/set/symbol/custom) are unrepresentable
(sources: [standard-schema #21](https://github.com/standard-schema/standard-schema/issues/21),
[zod.dev/json-schema](https://zod.dev/json-schema),
[effect JSONSchema](https://effect.website/docs/schema/json-schema/),
[arktype](https://arktype.io/docs/integrations)). A fingerprint built from JSON
Schema would **not change when only a `.refine`/`.transform` changes** — a
soundness hole, not a crash. So each strategy should prefer the validator's
**richest native structural artifact** and fall back to JSON Schema only where no
richer surface exists, applying the **Apollo normalise-then-hash recipe** before
hashing: _stable-sort all definitions, strip insignificant whitespace, strip
comments but not docstrings_
([Apollo schema-reporting protocol](https://github.com/apollographql/apollo-schema-reporting-preview-docs/blob/master/schema-reporting-protocol.md)).

-   **Zod** — prefer native `z.toJSONSchema(schema, { io: 'input' })` (shipped
    since v4 / `[email protected]`; `zod-to-json-schema` is the deprecated v3
    path), or walk internals. Detect version at runtime via `'_zod' in schema`
    (`schema._zod.def` on v4 vs `schema._def` on v3 —
    [zod.dev/library-authors](https://zod.dev/library-authors)). `z.toJSONSchema`
    **throws by default** on unrepresentable parts (transform/bigint/date/…) —
    treat that throw as the **abstain** signal. **Stability:** internals broke
    across a _major_ (`z.literal().value` → `.values` as a `Set`,
    [zod #4497](https://github.com/colinhacks/zod/issues/4497)); pin `supports` to
    a major, conformance-gate every minor.
-   **Valibot** — walk the plain-object graph: `schema.type`, `schema.entries`
    (objects), and the `schema.pipe` action array. Each action carries a `.type`
    discriminator, so a `transform`/`check` action's **presence is detectable**
    even though its predicate function is opaque → abstain (or version) when one
    is present. `@valibot/to-json-schema` (separate peer dep) is the JSON-Schema
    fallback.
-   **ArkType** — every `Type` exposes a native `.json` canonical serialisation
    and `.toJsonSchema()`. Hash `.json` (richer than JSON Schema). `.toJsonSchema()`
    **throws by default** on morphs/predicates/narrows/bigint/symbol/instanceof —
    the abstain signal (its fallback handlers _silently drop_, so do **not** use
    them for fingerprinting).
-   **Effect Schema** — **best case.** Hash the canonical `schema.ast`. The AST
    represents transformations as nodes (with from/to types), so it captures the
    _presence and typing_ of a transform even though the transform body stays
    opaque — strictly more than JSON Schema, whose `JSONSchema.make` _"stops at
    the first transformation encountered"_ and drops it
    ([effect docs](https://effect.website/docs/schema/json-schema/)).
-   **Typebox** — the schema **is** JSON Schema (a canonical plain object).
    Canonicalise (sort keys) and hash directly — no conversion, no loss for the
    JSON-Schema-expressible parts. `Type.Transform` codec functions are opaque
    (detectable via the `[Transform]` symbol) → abstain/version.

## Conformance-test shape

A vendor package proves soundness with `verifyFingerprintContract`, mirroring the
existing `verify*Contract` → `ContractReport` shape
([`testing.ts`](../../packages/core/src/testing.ts)): a framework-agnostic,
browser-safe async function returning `{ seam: 'fingerprint', ok, passed[],
violations[] }`, paired with `assertConformance`. The vendor supplies fixtures;
the kit asserts these independent rules:

1.  **Determinism** — same schema → same fingerprint across repeated calls and
    across processes (no `Date.now`/`Math.random`/object-identity inputs).
2.  **Stability (no false positives)** — two structurally-identical schemas built
    independently (incl. permuted object-key order) → **same** fingerprint.
3.  **Sensitivity (no false negatives)** — a mutation battery each yields a
    **different** fingerprint: field add/remove, type change, optional↔required,
    nullable, min/max/length/regex/format constraint change, enum value change,
    `unwrap`-path change, and — where representable — refine/transform change.
4.  **Minor-version invariance** — run the fixtures across the vendor's supported
    minor-version matrix in CI → identical fingerprints for unchanged schemas.
    This is the cross-version proof that guards against undocumented-internal
    drift.
5.  **Soundness-or-abstain (the critical rule)** — for fixtures containing parts
    the strategy cannot soundly capture (opaque refine/transform/brand,
    unrepresentable types), the strategy MUST return `value: null` rather than a
    fingerprint that could collide across semantically-different schemas. This
    converts every soundness hole into a safe fallback.
6.  **Synchronous + browser-safe** — `fingerprint()` returns a string
    synchronously with no `node:*` / WebCrypto-async (the hot-path constraint).

```ts
// vendor CI, one-liner
assertConformance(
    await verifyFingerprintContract(zodFingerprinter, zodFixtures),
);
```

## Prior art (what we borrow, and what we don't)

| Source                          | Mechanism (verified, primary sources)                                                                        | Borrowed                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| **tRPC / Zodios**               | No runtime schema hash; build-time TS types + path/input keying                                              | Confirms a runtime fingerprint is novel; the cross-deploy gap is our justification                                        |
| **orval / openapi-typescript**  | Build-time only; `--check` = regenerate-and-string-compare, exit 1 on mismatch                               | A future `stitch check` CI gate that diffs a re-derived snapshot                                                          |
| **TanStack Query** `hashKey`    | `JSON.stringify` with a recursive **key-sorting** replacer; hashes the _key_, not the schema                 | The canonicalisation replacer for the ADR 0003 **key** (anti-pattern for schema invalidation — it punts to the developer) |
| **GraphQL APQ / Apollo schema** | SHA-256 of a **canonical serialisable text** (sorted defs, stripped whitespace/comments); resolvers excluded | **Normalise-then-hash**; exclude opaque behaviour by design                                                               |
| **HTTP ETag (RFC 9110)**        | Opaque validator that changes iff the representation changes; strong vs weak comparison                      | Opaque-token model + strong/weak policy (Decisions 3, 5)                                                                  |
| **oasdiff**                     | **Structural** (not byte) diff; inline subschema ≡ `$ref` to validation-equivalent                           | Fingerprint the structural/canonical projection, not raw text                                                             |

## Consequences

### Positive

-   Schema changes auto-invalidate via the existing generation mechanism — no new
    store surface, no `SCAN`, no contract extension.
-   Core stays dependency-free and bundle-frugal; heavy converters live in opt-in
    vendor packages and run once at definition time.
-   Every failure mode degrades safely (re-validate-on-hit or refuse-to-cache);
    the system never silently serves a value bound to an unverifiable shape.
-   `cache.version` is a always-available, JSON-serialisable manual override.

### Negative / trade-offs

-   **Per-validator effort.** Each vendor needs a strategy and a conformance-gated
    CI matrix; there is no shared shortcut (the spec surface forbids it).
-   **Internals are undocumented-ish and version-sensitive.** Pinning to a major
    and gating every minor is mandatory, not optional
    ([zod #4497](https://github.com/colinhacks/zod/issues/4497)).
-   **Transforms are a genuine blind spot.** An un-versioned `transform` forces
    refuse-to-cache; this is correct but costs the cache for transform-heavy
    stitches until the author adds `cache.transformVersion`.
-   **Over-invalidation by design.** Strong-by-default fingerprints will bump on
    cosmetic schema refactors (e.g. inlining a sub-schema) unless a weak strategy
    is chosen. We accept refetch cost over staleness risk.
-   **Do not lean on StandardJSONSchemaV1 yet.** It is new (Dec 2025) with limited
    adoption; treat it as an optional fallback substrate, not the foundation.

## Open questions

-   Default for an **unknown/unregistered vendor**: re-validate-on-hit (chosen
    here) vs refuse-to-cache — and should it differ for bare-stitch vs subpath
    cache placement (ADR 0003)?
-   Should core ship a **first-party Typebox strategy** in core's test fixtures
    (since Typebox _is_ JSON Schema and needs no converter), or keep even that in a
    vendor package for consistency?
-   Is a `weak` strategy worth shipping per-vendor, or is strong-by-default
    sufficient until a concrete refetch-cost complaint arrives?
-   Empirically: do any target validators change introspection internals under
    **semver-minor** (not just major)? The conformance matrix will answer this per
    vendor; until it runs, treat minor-stability as unproven.

## Implementation status

Shipped on this branch (the cache wiring itself waits on ADR 0003's response
cache; everything below is standalone and unit-/conformance-tested):

-   **`stitchapi/fingerprint`** — the contract: `SchemaFingerprinter` /
    `SchemaFingerprint`, the registry (`registerFingerprinter` /
    `getFingerprinter`), the synchronous FNV-1a `hash`, and `resolveFingerprint`
    (the ladder). Browser-safe, synchronous, no new core dependency.
-   **`stitchapi/testing` → `verifyFingerprintContract`** — the conformance kit
    (vendor agreement, sync result-shape, determinism + stability, sensitivity,
    soundness-or-abstain, committed snapshots).
-   **Five vendor packages**, each with the validator as a _peer_ dependency and
    each proving compliance via the kit:
    -   `@stitchapi/fingerprint-zod` — walks `_def` (Zod 3) and `_zod.def`
        (Zod 4); abstains on `ZodEffects`/`.default`/custom checks.
    -   `@stitchapi/fingerprint-valibot` — walks `.type`/`.entries`/`.pipe`;
        abstains on transformation/`check`/`custom` actions, function
        requirements, and injected defaults.
    -   `@stitchapi/fingerprint-arktype` — hashes the canonical `t.json`;
        abstains on `$ark.fn` morph/predicate refs (opaque _and_
        non-deterministic) and on defaults.
    -   `@stitchapi/fingerprint-effect` — walks the `.ast`; abstains on
        `Transformation`/`Refinement`/`Suspend`/`Declaration`. Consumes
        `Schema.standardSchemaV1(schema)` (a raw Effect schema carries no
        `~standard`).
    -   `@stitchapi/fingerprint-typebox` — canonical-hashes the JSON Schema;
        abstains on `Type.Transform` (detected via symbol, recursively, since it
        is invisible to `JSON.stringify`) and on opaque kinds. **Caveat:**
        TypeBox 0.34 schemas have no `~standard`, so a TypeBox schema must be
        surfaced as a Standard Schema (a thin wrapper today, or a future TypeBox
        release) for the registry to dispatch to it; the package proves the
        fingerprint logic.

## References

Primary sources, verified during research (2026-06-14):

-   Standard Schema spec: [`index.ts`](https://github.com/standard-schema/standard-schema/blob/main/packages/spec/src/index.ts),
    [JSON Schema sister spec / issue #21](https://github.com/standard-schema/standard-schema/issues/21),
    [standardschema.dev/json-schema](https://standardschema.dev/json-schema)
-   Zod: [library-authors](https://zod.dev/library-authors),
    [json-schema](https://zod.dev/json-schema),
    [issue #4497 (`.value`→`.values`)](https://github.com/colinhacks/zod/issues/4497)
-   Effect: [Schema → JSON Schema](https://effect.website/docs/schema/json-schema/) ·
    ArkType: [integrations](https://arktype.io/docs/integrations),
    [configuration](https://arktype.io/docs/configuration) ·
    Valibot: [JSON Schema guide](https://valibot.dev/guides/json-schema)
-   Function source hashing: [terser](https://terser.org/docs/options/),
    [swc minification](https://swc.rs/docs/configuration/minification),
    [TC39 stricter-function-toString](https://github.com/tc39/proposal-stricter-function-tostring),
    [MDN `Function.prototype.toString`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/toString)
-   Prior art:
    [tRPC `getQueryKey.ts`](https://github.com/trpc/trpc/blob/main/packages/react-query/src/internals/getQueryKey.ts),
    [Zodios `hooks.ts`](https://github.com/ecyrbe/zodios-react/blob/main/src/hooks.ts),
    [openapi-typescript `cli.js`](https://github.com/openapi-ts/openapi-typescript/blob/main/packages/openapi-typescript/bin/cli.js),
    [TanStack Query `utils.ts`](https://github.com/TanStack/query/blob/main/packages/query-core/src/utils.ts),
    [Apollo schema-reporting protocol](https://github.com/apollographql/apollo-schema-reporting-preview-docs/blob/master/schema-reporting-protocol.md),
    [Apollo APQ](https://www.apollographql.com/docs/apollo-server/performance/apq),
    [RFC 9110 §8.8](https://www.rfc-editor.org/rfc/rfc9110.txt),
    [oasdiff `FINGERPRINT.md`](https://github.com/oasdiff/oasdiff/blob/main/docs/FINGERPRINT.md)
