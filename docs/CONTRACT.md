# StitchAPI API Meta-Contract

> **Status:** Living normative document. Adopted 2026-06-29.
> **Scope:** every consumer-facing contract in the published surface — `stitchapi`
> core + its subpaths (`/serve`, `/mcp`, `/registry`, `/testing`, `/fingerprint`)
> and every `@stitchapi/*` package.
> **Relationship to ADRs:** this governs **field- and shape-level** conventions
> (naming, typing, shorthand, envelopes). It **complements** and does not supersede
> [ADR 0012](adr/0012-integration-symbol-naming.md), which governs cross-package
> **symbol** naming; ADR 0012 rules are referenced, not restated. Enforced by
> [`scripts/check-contract.mjs`](../scripts/check-contract.mjs) (a ratchet, see
> [§7](#7-enforcement)).

This contract exists so the public API reads as **one coherent thing**: a consumer
who has learned one corner of StitchAPI can predict the rest. It turns patterns that
already exist locally in the core (`retry: 3`, `timeout: '5s'`, `cache: '1m'`) into
global law, and pins the cross-cutting vocabulary so the same word never means two
things.

The rules are **normative** (MUST / SHOULD / MUST NOT). The per-field rename
proposals in [§6](#6-migration-backlog) are the **backlog**, not part of the
normative text — exact target spellings are confirmed during the migration sweep.

---

## 0. Resolved decisions

Four forks were decided by the maintainer on adoption; the rules below assume them.

| #   | Decision                   | Resolution                                                                                                                                                                                                                                      | Drives                                         |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| D1  | Success-payload field name | **`data`** (align with axios / React Query / SWR / RTK Query, which every hook package wraps; `SafeResult` already uses it). Stream increments keep **`chunk`**; the Standard-Schema validation layer keeps spec-mandated **`value`/`issues`**. | [P5](#p5--one-success-field-one-failure-field) |
| D2  | Cap-word convention        | **Bare nouns, no `max-` prefix**, for **count** caps (`attempts`, `entries`, `pages`, `failures`, `concurrency`). `max-` is retained only where it bounds a continuous **magnitude** and a bare noun would be ambiguous (a delay ceiling).      | [P4](#p4--one-cap-vocabulary)                  |
| D3  | Duration style             | **ms is the one house unit; drop the `Ms` suffix _everywhere_** (input and emitted; the unit lives in JSDoc). Consumer-authored durations additionally accept **`number \| string`** (`'5s'` or raw ms) via one `parseDuration`.                | [P17](#p17--one-canonical-duration-form)       |
| D4  | Home of the contract       | **This `CONTRACT.md` (living doc) + an enforcement lint** in the verify gate.                                                                                                                                                                   | [§7](#7-enforcement)                           |

---

## 1. The serialization gate (the load-bearing invariant)

**P0 · `__config` round-trips as JSON; sugar is the only non-serializable layer.**

This is the existing contract that everything else hangs off
([`types.ts` `RedactedStitchConfig`](../packages/core/src/types.ts), ADR 0005
Decision 11). It is restated first because every shorthand and envelope rule below
must preserve it.

-   The public, redacted `__config` a stitch/seam exposes — read by `diagram`, `mcp`,
    `cli`, `config-summary`, and `export --openapi` — **MUST be plain JSON-serializable
    data**: no functions, no live handles, no sugar forms.
-   Every scalar/boolean/string **shorthand MUST be normalized** to its canonical
    envelope field by `compose()` **before it reaches `__config`** (a `retry: 3` is
    `{ attempts: 3 }` on `__config`, never `3`).
-   Every **function-valued field is sugar** and lives **off** `__config` (on the
    non-enumerable `__rawConfig`), exactly as `auth` / `store` / `adapter` / the live
    `Surface` already do. This explicitly includes the key-derivation functions
    ([`keyOf`](#p6--key-is-a-string-keyof-is-a-function)) — they are sugar, not a
    blessed `__config` exception.

> **Why first:** the program of adding shorthands (P12–P15) is safe **only** because
> normalization keeps `__config` stable. A shorthand that leaked its scalar form onto
> `__config` would break introspection. P0 is the budget the rest of the contract
> spends.

---

## 2. Naming — short, one word, one meaning

### P1 · One word, one concept, one value-space

A public field or symbol **MUST** be the shortest unambiguous token for its concept
(prefer one word), and that token **MUST** denote exactly one concept and one
value-space across the entire surface.

_Current violations:_ `key` is a `string` namespace in `CircuitOptions` but a
`(input) => string` in `IdempotencyOptions` / `CacheConfig`; `query` is a GraphQL
document string in `StitchConfig` but URL params in `StitchInput` / `InputSchemas`;
`on` is retry-trigger statuses **and** rate-limit-signal statuses; `bodyKind`
(`from-curl`) vs `bodyType` (everywhere else) for one `'json'|'form'` concept.

### P2 · Don't reuse one word for genuinely different concepts — rename one

When two fields legitimately mean **different** things, they **MUST NOT** share a
name even if each is individually defensible; rename one so a reader never has to know
they differ.

_Canonical case:_ `scope` is a **pool** axis (`'stitch'|'host'`) in `ThrottleOptions`
and a **tenancy** axis (`'principal'|'app'`) in `CacheConfig`/`CookieSessionOpts`.
These are real, distinct concepts → **`throttle.scope` is renamed to `pool`**, freeing
`scope` to mean tenancy everywhere. (This is a rename, **not** an assertion that they
were the same concept.)

### P3 · One suffix system

A type's role **MUST** be predictable from its suffix:

| Role                        | Suffix            | MUST NOT use                              |
| --------------------------- | ----------------- | ----------------------------------------- |
| Consumer-input envelope     | `*Options`        | `*Config`, `*Opts`, `*Info`, `*Params`    |
| Produced / read-back shape  | `*Result`         | `*Return`, `*Response`, `*State`, `*Info` |
| Duck-typed foreign contract | `*Like` (or none) | —                                         |

`*Options` **MUST NOT** appear on a returned value.
_Violations:_ `CacheConfig`, `OAuth2Opts`, `CookieSessionOpts`, `McpServerInfo`,
`SignV4Params`; `StitchQueryOptions` is actually a `{ queryKey, queryFn }` **result**.
_Carve-out:_ `StitchConfig`/`SeamConfig`/`RedactedStitchConfig` keep `*Config` as the
one well-known top-level authoring type family (the thing you literally call
`stitch(config)` with); the ban targets the **sibling capability bags**.

### P4 · One cap vocabulary

Per **D2**, a **count** upper-bound is a **bare plural noun** — `attempts`, `entries`,
`pages`, `failures`, `concurrency` — never `max`-prefixed, never `*Threshold`, never a
bare `max`. A **magnitude** ceiling (a delay) MAY keep `max` when a bare noun would be
ambiguous. Plural **`attempts`** = a running total; singular **`attempt`** = the
current index.

_Violations:_ `ReconnectOptions.maxAttempts` (→ `attempts`), `CacheConfig.maxEntries`
(→ `entries`), `CircuitOptions.failureThreshold` (→ `failures`), `paginate.max`
(→ `pages`), `deno-kv maxIncrRetries`.

---

## 3. Typing — predictable and consistent

### P5 · One success field, one failure field

Per **D1**, every StitchAPI **runtime** result/event envelope **MUST** expose its
success payload as **`data`** and its failure payload as **`error`**.

-   Streaming increments keep **`chunk`** (`StitchEvent.delta.chunk`) — `data` is the
    terminal/aggregated payload, `chunk` is an increment.
-   The **Standard-Schema validation layer** (`ValidationResult` / `StandardResult`)
    keeps **`value`** / **`issues`** — that is the external Standard-Schema spec, not
    ours to rename.
-   `value` **MUST NOT** be overloaded for non-payload tokens (e.g. rename
    `SchemaFingerprint.value` → `token`).

_Violations:_ success is `data` in `SafeResult` but `value` in `Inspection` /
`StitchEvent.result`; those two move to `data`.

### P6 · `key` is a string; `keyOf` is a function

A field named **`key` MUST be a string** identifier/namespace. A key-**derivation**
function **MUST** be named **`keyOf`** (a `(input) => string`) and **MUST NOT** be
called `key`.

_Violations:_ `IdempotencyOptions.key`, `CacheConfig.key` (both `(input) => string`)
→ `keyOf`. `CircuitOptions.key` and `StitchStore.get/set/incr(key)` are correct as-is.

### P7 · Status-classification parity

Any field that answers "does this HTTP status match?" **MUST** share one shape:
**`number[] | ((status: number) => boolean)`**. Any list-shaped field whose
single-value case is common **MUST** accept **`T | T[]`** and normalize internally.

_Violations:_ `acceptStatus` takes a predicate but `retry.on` / `rateLimit.on` are
`number[]`-only (widen them); `acceptStatus: 404` should be legal (today needs
`[404]`); `DriftOptions.ignore`, `refreshOn` are list-only while `DriftOptions.severity`
already widens `'warn' ≡ ['warn']` — make widening uniform.

### P8 · Same concept → same default across packages

A field reused across packages **MUST** carry the same default, or the divergence
**MUST** be reconciled deliberately and documented — never left as a silent inversion.

_Violations:_ `PinoSinkOptions.lifecycle` defaults `true` but `SentrySinkOptions.lifecycle`
defaults `false`; `OAuth2Opts.tenancy` defaults `'app'` but `CookieSessionOpts.scope`
defaults `'principal'` (same tenancy concept, two names **and** inverted defaults — fix
both under P2).

### P9 · Unique-by-shape exported types

An exported type identifier **MUST** denote one structural contract across all
packages. A genuinely per-framework shape **MUST** be framework-qualified
(`SolidStitchStore` vs `SvelteStitchStore`, ADR 0012 rule 6); a shared shape **MUST**
be hoisted into `query-core`/`core` and re-exported.

_Violations:_ `StitchStore<T>` means two incompatible things in `@stitchapi/solid`
(nested `.state`) vs `@stitchapi/svelte` (a `Readable`); `StitchLike` is redefined
three ways across `query-core` / `swr` / `rtk-query`; `RequestSeam` (express/elysia)
vs `HonoRequestSeam` vs `StitchHost` (fastify/nest) for the per-request seam;
`StitchError` vs `StitchErrorLike` for one runtime shape.

### P10 · Error-class taxonomy parity

Every thrown error type (`StitchError`, `RateLimitError`, and per-package re-exports)
**MUST** guarantee the same field set (`status?`, `attempts`, `body?`, `url?`, and a
stable discriminator) so a consumer can branch on any thrown error uniformly.

### P11 · Async/sync signature parity

The same verb **MUST** keep the same sync/async shape across every surface and adapter.
A `close()` is `() => Promise<void>` everywhere; a verb is not sync in one driver and
async in another.

_Violation:_ `DenoKvLike.close` is synchronous while every other store `close` returns
`Promise<void>`.

---

## 4. Shorthands & envelopes (the preferred authoring model)

> The maintainer's model: **every capability is a config object (an envelope), and an
> envelope with one dominant field also accepts that field's scalar as shorthand.** > `retry`/`timeout`/`cache` already prove it; the rest of the surface MUST follow.
> Every shorthand normalizes to the canonical field per **P0**.

### P12 · Envelope + scalar shorthand

Every capability **MUST** be expressible as a config object. An envelope whose
meaningful surface is a **single dominant field MUST** also accept that field's scalar
at its `StitchConfig` slot.

| Slot                      | Today              | MUST also accept                            | Shorthand              |
| ------------------------- | ------------------ | ------------------------------------------- | ---------------------- |
| `retry` `timeout` `cache` | ✅                 | —                                           | done                   |
| `stream`                  | `StreamOptions`    | `StreamDecode \| StreamOptions`             | `stream: 'ndjson'`     |
| `multipart`               | `MultipartOptions` | `MultipartNesting \| MultipartOptions`      | `multipart: 'dot'`     |
| `sse`                     | `{ reconnect }`    | `boolean \| ReconnectOptions \| SseOptions` | `sse: true`            |
| `.inspect()`              | `{ cache }`        | `boolean \| InspectOptions`                 | `inspect(input, true)` |

### P13 · Boolean toggle means enable-with-defaults

A capability whose primary act is an on-switch **MUST** accept **`boolean | Options`**,
where `true` = enable-with-documented-defaults; it **MUST NOT** require an object
literal merely to switch on.

_Apply to:_ `idempotency?: boolean | IdempotencyOptions` and `inspect(input, true)`.
`sse.reconnect: true` already sets the precedent. (Rate-limit delegation becomes a
`throttle` mode after the P14 fold, not its own toggle.)

### P14 · Multi-field envelopes are named, exported, and MAY shorthand their dominant field

A config sub-object with more than one field **MUST** be a named, exported `*Options`
interface (never an anonymous inline shape), so it can be imported, extended, and
referenced. A multi-field envelope **MAY** still offer a scalar shorthand for an
**unambiguously dominant** field (this is **not** the single-field collapse of P12).

_Violations:_ `paginate` (`{ next; items?; max? }`) is anonymous → extract
`PaginateOptions`. `rateLimit` (`{ delegate?; on? }`) is anonymous **and** a near-synonym
of `throttle` → **fold it into the `throttle` envelope** (`delegate` / `on` become
throttle modes), collapsing two top-level keys into one and turning the buried "delegate
makes throttle inert" interaction into a within-envelope rule.
_Allowed example:_ `throttle?: string | ThrottleOptions` where `'2/s' ≡ { rate: '2/s' }`
— `rate` dominates although `concurrency` also exists (so this is a P14 dominant-field
shorthand, not a P12 collapse).

### P15 · Required fields are deliberate and get a named/positional shorthand — not silent defaults

An `*Options` envelope **SHOULD** be `{}`-constructible (every field optional with a
documented default). Where a field is **required by design** because a silent default
is a footgun, it **MUST** stay required and the envelope **MUST** offer a scalar/
positional shorthand naming the required value(s).

-   `CircuitOptions.failures`/`cooldown` **stay required** (a breaker with invisible
    thresholds fails open/closed silently) — add a positional shorthand instead.
-   `CacheOptions.ttl` **stays required** — its shorthand `cache: '1m'` already names it.

> This corrects the audit draft, which tried to defend `ttl`-required while attacking
> `circuit`-required. Required-with-a-named-shorthand is the **one** acceptable form of
> a non-`{}` envelope.

---

## 5. Cross-cutting

### P16 · Cross-surface & cross-package parity

A concept **MUST** use the same field name, shorthand, and envelope on every surface
(`stitch` / `seam` / `pipe`) and every framework package, varying only the
framework-idiomatic verb (`use` / `create` / `inject`). New config fields are added to
`StitchConfig` and **projected** (`SeamConfig = Omit<StitchConfig, …>` is the model),
never re-declared per surface. ADR 0012's `stitchQueryOptions` rename **MUST** be
applied to all five TanStack adapters, not react only.

_Violations:_ SSE helper is `streamStitchSse` / `sendStitchSse` / `stitchSse`;
error-options is `StitchErrorHandlerOptions` / `StitchErrorOptions` /
`ToHttpExceptionOptions` (with `body` present in some, absent in others); the hook
result interface is `UseStitchResult` / `UseStitchReturn` / `InjectStitchResult` /
`StitchStore`; `queryOptions` is still bare in vue/solid/svelte/angular.

### P17 · One canonical duration form

Per **D3**, **ms is the single house time unit** and **no duration field carries the
`Ms` suffix** — input or emitted. Every **consumer-authored** duration additionally
**MUST** accept **`number | string`** (raw ms or a token like `'5s'`/`'1m'`), parsed by
one shared `parseDuration`. Every **emitted** duration is a raw-ms `number`; its unit is
stated in its JSDoc, not its name.

_Why:_ every JS-native time API (`Date.now()`, `setTimeout`, `performance.now()`) is
**already ms**, so ms is the unambiguous default and the suffix is redundant noise
everywhere. On inputs, accepting `'5s'` on top is pure ergonomic gain (and a `Ms` name
on a field that takes `'5s'` would be a lie). On outputs, one uniform de-suffixed
vocabulary beats a split convention; the JSDoc carries the unit.

_Violations (inputs — widen + de-suffix):_ `RetryOptions.baseMs`/`maxMs`,
`CircuitOptions.cooldownMs`/`halfOpenAfterMs`, `ReconnectOptions.backoffMs`,
`OAuth2Opts.refreshSkewMs`, `CookieSessionOpts.ttlMs`, store-contract `ttlMs`.
_Violations (emitted — de-suffix):_ `StitchEvent` `waitedMs`→`waited`,
`retryAfterMs`→`retryAfter`, the `done` event's `ms`→`elapsed`; `SseEvent.retry` stays
(already bare; it mirrors the SSE `retry:` wire field); `MockResponse.delayMs`→`delay`.
_Unit hazard (the exception to "all JS time is ms"):_ a few fields are **seconds**
because they mirror a wire format — `MockResponse.retryAfter` and the HTTP
`Retry-After` header (delta-seconds), Cloudflare KV `expirationTtl`. Every
StitchAPI-_authored_ duration stays ms; a field that must speak a foreign unit converts
at the adapter edge and is named with its true unit (`expirationSeconds`,
`retryAfterSeconds`) so the unit is never silent.

### P18 · Adapter mirrors keep upstream spelling; house contracts use house vocabulary

A duck-type that mirrors a foreign SDK **MUST** keep that SDK's spelling (so it
structurally matches). StitchAPI's **own normalized** contracts (`StitchStore`,
`RedisDriver`) **MUST** use one house vocabulary: `ttl` (ms — the house unit, no suffix
per P17; convert foreign units at the edge), `delete` (not `del`),
`close(): Promise<void>` (async, per P11), with one optionality per parameter (`ttl`
MUST NOT be optional on `set` but required on `incr`).

### P19 · No pre-GA hard break

Every rename, narrowing, or removal mandated here **MUST** ship a `@deprecated`
re-export/field alias pinned by an identity test, removed at the **1.0 GA cut**
(extending ADR 0012's precedent from symbols to fields). Widening
(`number → number | string`, P17) is non-breaking and needs no alias.

---

## 6. Migration backlog (proposed renames — confirm during sweep)

Not normative. The rule is the law; these are the proposed target spellings the sweep
will apply under `@deprecated` aliases (P18). Severity = consumer blast radius.

| Sev  | Current                                                               | Proposed                                                       | Rule   |
| ---- | --------------------------------------------------------------------- | -------------------------------------------------------------- | ------ |
| High | `SafeResult.data` ↔ `Inspection.value` ↔ `StitchEvent.result.value` | `data` everywhere                                              | P5     |
| High | `IdempotencyOptions.key`, `CacheConfig.key` (fn)                      | `keyOf`                                                        | P6     |
| High | `ThrottleOptions.scope` (`'stitch'｜'host'`)                          | `pool`                                                         | P2     |
| High | `rateLimit` (separate top-level key) vs `throttle`                    | fold into one `throttle` envelope (`delegate` / `on` as modes) | P2/P14 |
| High | `retry.on` + rate-limit `on` (`number[]`)                             | `number[] ｜ (status)=>boolean`                                | P7     |
| High | `StitchStore`/`StitchLike`/`RequestSeam` cross-pkg clashes            | hoist or qualify                                               | P9     |
| High | `queryOptions` bare in vue/solid/svelte/angular                       | `stitchQueryOptions`                                           | P16    |
| Med  | `CacheConfig` →                                                       | `CacheOptions`                                                 | P3     |
| Med  | `OAuth2Opts`, `CookieSessionOpts`                                     | `OAuth2Options`, `CookieSessionOptions`                        | P3     |
| Med  | `McpServerInfo`, `SignV4Params`                                       | `…Options`                                                     | P3     |
| Med  | `StitchQueryOptions` (a result)                                       | `StitchQueryResult`                                            | P3     |
| Med  | `ReconnectOptions.maxAttempts`                                        | `attempts`                                                     | P4     |
| Med  | `CacheConfig.maxEntries`                                              | `entries`                                                      | P4     |
| Med  | `CircuitOptions.failureThreshold`                                     | `failures`                                                     | P4     |
| Med  | `paginate.max`                                                        | `pages`                                                        | P4     |
| Med  | `*Ms` duration inputs (`cooldownMs`, `backoffMs`, `ttlMs`, …)         | de-suffix + `number｜string`                                   | P17    |
| Med  | `paginate` inline shape                                               | `PaginateOptions`                                              | P14    |
| Med  | SSE helper `sendStitchSse`/`stitchSse`                                | `streamStitchSse`                                              | P16    |
| Med  | error-options `StitchErrorHandlerOptions`/`ToHttpExceptionOptions`    | `StitchErrorOptions` (+ `body`)                                | P16    |
| Low  | `RedisDriver.del`, `…quit`, sync `close`                              | `delete`, async `close`                                        | P18    |
| Low  | `SchemaFingerprint.value`                                             | `token`                                                        | P5     |
| Low  | `bodyKind` (from-curl)                                                | `bodyType`                                                     | P1     |
| Low  | emitted `*Ms` (`waitedMs`, `retryAfterMs`, done `ms`)                 | de-suffix (`waited`, `retryAfter`, `elapsed`); units → JSDoc   | P17    |

New shorthand/toggle slots to **add** (additive, non-breaking): `stream`, `multipart`,
`sse`, `.inspect()` scalars (P12); `idempotency` boolean (P13-toggle);
`throttle` string (P14).

**Shipped (migration in progress)** — all under `@deprecated` aliases read until the GA
cut; the lint skips the deprecated members so each rename ratchets the baseline down:

-   **P2** `ThrottleOptions.scope`→`pool`; runtime prefers `pool ?? scope`.
-   **P6** `IdempotencyOptions.key`/`CacheOptions.key`→`keyOf`; runtime prefers `keyOf ?? key`.
-   **P3** suffix renames (type-only, zero runtime): `CacheConfig`→`CacheOptions`,
    `OAuth2Opts`→`OAuth2Options`, `CookieSessionOpts`→`CookieSessionOptions`,
    `McpServerInfo`→`McpServerOptions`, `LlmConfig`→`LlmOptions`,
    `SignV4Params`→`SignV4Options`, and the read-back `AuthFailureInfo`→`AuthFailureResult`.
    (`OAuth2Opts`/`CookieSessionOpts` are auth-internal — renamed without an alias.)
-   **P4** caps → bare nouns: `ReconnectOptions.maxAttempts`→`attempts`,
    `CacheOptions.maxEntries`→`entries`, `paginate.max`→`pages`; runtime prefers the new
    field. (`CircuitOptions.failureThreshold`→`failures` is deferred to the P17 CircuitOptions
    overhaul, where its required-ness + `cooldownMs`/`halfOpenAfterMs` are handled together.)

---

## 7. Enforcement

[`scripts/check-contract.mjs`](../scripts/check-contract.mjs) is a **ratchet**, run as
`pnpm check:contract` in `lefthook` (pre-push) and `verify.yml` — the same wiring as
`check:exports` / `check:release`.

-   It scans the published packages' public surface and reports contract violations.
-   The current backlog is frozen in
    [`scripts/contract-violations.baseline.json`](../scripts/contract-violations.baseline.json).
    The lint **fails only when a NEW violation appears** (or — once the migration
    starts — when the baseline is not shrunk to match). This mirrors the repo's existing
    ESLint-suppression ratchet: the gate never blocks unrelated work, but the surface can
    only get more consistent, never less.
-   Rules implemented today (high-precision, source-text level): **R1** banned type-name
    suffix (P3), **R2** any `*Ms`-suffixed duration field, input or emitted (P17),
    **R3** function-typed `key` (P6), **R4** `scope: 'stitch'|'host'` overload (P2),
    **R5** same identifier exported by ≥2 published packages (P9).
-   Deferred to a type-aware phase (needs the TS checker, not regex): full
    same-name-different-**shape** detection, duration-type conformance, default-value
    inversion (P8). Tracked as comments in the lint.

---

## 8. References

-   [ADR 0012 — Integration symbol naming](adr/0012-integration-symbol-naming.md) — the
    cross-package symbol rules this contract extends to field/shape level.
-   [ADR 0005 — Surfaces and the authoring model](adr/0005-surfaces-and-the-authoring-model.md)
    — Decision 11, the `__config`-round-trips-as-JSON gate (P0).
-   [ADR 0002 — Seam primitive](adr/0002-seam-primitive-and-principal-scoped-auth.md) —
    the principal boundary and the `SeamConfig = Omit<StitchConfig>` projection (P16).
-   [`packages/core/src/types.ts`](../packages/core/src/types.ts) — the canonical
    `StitchConfig` envelope and result/event shapes.
