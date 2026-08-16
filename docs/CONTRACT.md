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

The rules are **normative** (MUST / SHOULD / MUST NOT). The migration they mandated
is **done**: the 2026-07-08 hard-break sweep
([§6](#6-migration-record-2026-07-08-hard-break-sweep)) applied every rename and
cleared the enforcement baseline, including the one pre-existing match the
same-day P24 addition found and initially baselined rather than fixed — now
converted too (§6, §7). Rule sections keep their worked examples as _Resolved_
history so the reasoning survives the renames.

---

## 0. Resolved decisions

Five forks were decided by the maintainer; the rules below assume them.

| #   | Decision                   | Resolution                                                                                                                                                                                                                                                       | Drives                                                                    |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| D1  | Success-payload field name | **`data`** (align with axios / React Query / SWR / RTK Query, which every hook package wraps; `SafeResult` already uses it). Stream increments keep **`chunk`**; the Standard-Schema validation layer keeps spec-mandated **`value`/`issues`**.                  | [P5](#p5--one-success-field-one-failure-field)                            |
| D2  | Cap-word convention        | **Bare nouns, no `max-` prefix**, for **count** caps (`attempts`, `entries`, `pages`, `failures`, `concurrency`). `max-` is retained only where it bounds a continuous **magnitude** and a bare noun would be ambiguous (a delay ceiling).                       | [P4](#p4--one-cap-vocabulary)                                             |
| D3  | Duration style             | **ms is the one house unit; drop the `Ms` suffix _everywhere_** (input and emitted; the unit lives in JSDoc). Consumer-authored durations additionally accept **`number \| string`** (`'5s'` or raw ms) via one `parseDuration`.                                 | [P17](#p17--one-canonical-duration-form)                                  |
| D4  | Home of the contract       | **This `CONTRACT.md` (living doc) + an enforcement lint** in the verify gate.                                                                                                                                                                                    | [§7](#7-enforcement)                                                      |
| D5  | Pre-GA break policy        | **Alias-free hard breaks are maintainer-sanctioned before 1.0 GA** (exercised once — the 2026-07-08 sweep, few adopters, every prior `@deprecated` shim deleted). From 1.0 GA, every rename/narrowing/removal requires a deprecation cycle and lands in a major. | [P19](#p19--breaking-changes-sanctioned-pre-ga-deprecation-cycle-from-ga) |

---

## 1. The serialization gate (the load-bearing invariant)

**P0 · `__config` round-trips as JSON; sugar is the only non-serializable layer.**

This is the existing contract that everything else hangs off
([`types.ts` `RedactedStitchConfig`](../packages/core/src/types.ts), ADR 0005
Decision 11). It is restated first because every shorthand and envelope rule below
must preserve it.

- The public, redacted `__config` a stitch/seam exposes — read by `diagram`, `mcp`,
  `cli`, `config-summary`, and `export --openapi` — **MUST be plain JSON-serializable
  data**: no functions, no live handles, no sugar forms.
- Every scalar/boolean/string **shorthand MUST be normalized** to its canonical
  envelope field by `compose()` **before it reaches `__config`** (a `retry: 3` is
  `{ attempts: 3 }` on `__config`, never `3`).
- Every **function-valued field is sugar** and lives **off** `__config` (on the
  non-enumerable `__rawConfig`), exactly as `auth` / `store` / `adapter` / the live
  `Surface` already do. This explicitly includes the key-derivation functions
  ([`keyOf`](#p6--key-is-a-string-keyof-is-a-function)) — they are sugar, not a
  blessed `__config` exception.
- **One exemption, and only one:** the schema slots `input` / `output` hold Standard
  Schema validators, whose `validate` sits at depth 2. They are **not** sugar —
  `export --openapi` reads them off `__config` to build its parameter and response
  shapes, and unlike a `retry` envelope a schema is not reconstructible from a
  function-stripped husk. They are therefore kept whole, and a `__config` carrying
  them does **not** survive `JSON.stringify` unchanged; every other slot does. The
  exemption is a named fact (`carriesSchema` in
  [`config-anatomy.ts`](../packages/core/src/config-anatomy.ts)), not a gap, and
  [`contract-p0.spec.ts`](../packages/core/test/contract-p0.spec.ts) pins it in both
  directions: the validators survive, and nothing else does. Widening it means marking
  another slot `carriesSchema` — a deliberate edit, reviewed as a contract change.

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

_Resolved (2026-07 sweep):_ the key-derivation functions in `IdempotencyOptions` /
`CacheOptions` are **`keyOf`** ([P6](#p6--key-is-a-string-keyof-is-a-function)), so
`key` is a string everywhere; the GraphQL document string moved off `query` to
**`document`**, leaving `query` to mean URL params only; `retry.on` and `throttle.on`
share one shape and one meaning — the statuses that trigger that envelope's capability
(`StatusMatch`, [P7](#p7--status-classification-parity)); `bodyKind` is gone — the
2026-08-01 sweep renamed the last holdout, on the CLI-internal `from-curl` parser type
(`ParsedRequest`), so `bodyType` is the one spelling everywhere, published or internal.

### P2 · Don't reuse one word for genuinely different concepts — rename one

When two fields legitimately mean **different** things, they **MUST NOT** share a
name even if each is individually defensible; rename one so a reader never has to know
they differ.

_Canonical case (applied in the 2026-07 sweep):_ `scope` was a **pool** axis
(`'stitch'|'host'`) in `ThrottleOptions` and a **tenancy** axis in the cache and auth
envelopes. Three concepts now carry three words: **`throttle.pool`** (where the
limiter's counter is pooled), **`cache.scope`** (`'principal'|'app'` — whose responses
a cached entry may be served to), and **`tenancy`** on
`OAuth2Options`/`CookieSessionOptions` (whose credential a token/session is). (Renames,
**not** an assertion that they were one concept.)

_Second case:_ `backoff` was a **curve policy** (`'expo'|'expo-jitter'|'fixed'`) in
`RetryOptions` and a flat **duration** (`number | string`) in `ReconnectOptions` — one token,
two value-spaces, and both accept strings, so `backoff: 'expo'` and `backoff: '1s'` were
indistinguishable by shape. → **`reconnect.backoff` is renamed to `delay`**, leaving `backoff`
to mean "the curve policy" everywhere.

### P3 · One suffix system

A type's role **MUST** be predictable from its suffix:

| Role                        | Suffix            | MUST NOT use                              |
| --------------------------- | ----------------- | ----------------------------------------- |
| Consumer-input envelope     | `*Options`        | `*Config`, `*Opts`, `*Info`, `*Params`    |
| Produced / read-back shape  | `*Result`         | `*Return`, `*Response`, `*State`, `*Info` |
| Duck-typed foreign contract | `*Like` (or none) | —                                         |

`*Options` **MUST NOT** appear on a returned value.
_Resolved (2026-07 sweep):_ `CacheConfig`→`CacheOptions`, `OAuth2Opts`→`OAuth2Options`,
`CookieSessionOpts`→`CookieSessionOptions`, `McpServerInfo`→`McpServerOptions`,
`LlmConfig`→`LlmOptions`, `SignV4Params`→`SignV4Options`,
`AuthFailureInfo`→`AuthFailureResult`, `StitchQueryState`→`StitchQueryResult`,
`UseStitchReturn`→`UseStitchResult`.
_Carve-outs:_ `StitchConfig`/`SeamConfig`/`RedactedStitchConfig` keep `*Config` as the
one well-known top-level authoring type family (the thing you literally call
`stitch(config)` with) — the ban targets the **sibling capability bags**. `OpenApiInfo`
mirrors the OpenAPI spec's `InfoObject` (P18). **`StitchQueryOptions`** keeps its name
**and** its flat `queryKey`/`queryFn` fields as a deliberate
[P22](#p22--a-standards-interop-contract-uses-the-standards-field-names)-style mirror
of TanStack's own `queryOptions()` vocabulary — it is the object you hand `useQuery`,
so it speaks TanStack, not house (hoisted into `query-core`, re-exported by all five
bindings).

### P4 · One cap vocabulary

Per **D2**, a **count** upper-bound is a **bare plural noun** — `attempts`, `entries`,
`pages`, `failures`, `concurrency` — never `max`-prefixed, never `*Threshold`, never a
bare `max`. A **magnitude** ceiling (a delay) MAY keep `max` when a bare noun would be
ambiguous. Plural **`attempts`** = a running total; singular **`attempt`** = the
current index.

_Resolved (2026-07 sweep):_ the caps this rule called out are bare plural nouns —
`ReconnectOptions.maxAttempts`→`attempts`, `CacheOptions.maxEntries`→`entries`,
`CircuitOptions.failureThreshold`→`failures` (landed with the P17 `CircuitOptions`
overhaul), `paginate.max`→`pages`, `deno-kv maxIncrRetries`→`retry.attempts`
(see [§6](#6-migration-record-2026-07-08-hard-break-sweep)).

The 2026-07-31 audit found one more the sweep had missed and it is now fixed too:
`LlmOptions.maxTokens` / `LlmRequest.maxTokens` (the `stitchapi/llm` subpath)
→ **`tokens`**. It was **not** sheltered by
[P22](#p22--a-standards-interop-contract-uses-the-standards-field-names), which is where
the first reading of it went wrong: `LlmRequest` is the house-**normalised** shape, and
each provider's `buildBody` emits the vendor's `max_tokens` separately, at the wire. A
standard's field name is owed to the standard's own message, not to the house type that
feeds it.

A `max*` spelling survives legitimately only on **resolved internals** — the reconnect
policy in `engine.ts`, the local `maxEntries` in `cache.ts`, the `failureThreshold` local
in `resilience.ts` — which name a computed value, never a field a consumer writes. That
split is the rule's boundary: P4 governs the **authoring** surface.

Enforced by lint **R10** (§7), and that same split is what makes the check high-precision
without type info: it scans the consumer-input envelope family only (`*Options` plus the
blessed `*Config` types — R6's filter), so the blessed resolved internals sit outside it **by
name** rather than on a hand-kept skip list. `*Threshold` is flagged outright, having no
carve-out to check against. A `max` cap — bare or prefixed, since the sweep record above fixed
both — is flagged unless it is on the rule's allow-list of **verified magnitude ceilings**,
which is three entries today: `BackoffOptions.max` (a delay), `ServeBodyOptions.max` and
`ShellBufferOptions.max` (byte caps). Each carries its one-line reason, so a new `max` forces a
written magnitude-or-count judgement rather than passing by resemblance to those three.

Note what the allow-list does **not** contain: the `chars` caps. A count of UTF-16 code units
is a **count**, so `trace.body.chars` and `stream.buffer.chars` are bare nouns and never a
`max` — the same reading that makes them the marked, string-free side of
[P25](#p25--one-canonical-size-form). Only the **byte** caps are magnitudes.

---

## 3. Typing — predictable and consistent

### P5 · One success field, one failure field

Per **D1**, every StitchAPI **runtime** result/event envelope **MUST** expose its
success payload as **`data`** and its failure payload as **`error`**.

- Streaming increments keep **`chunk`** (`StitchEvent.delta.chunk`) — `data` is the
  terminal/aggregated payload, `chunk` is an increment.
- The **Standard-Schema validation layer** (`ValidationResult` / `StandardResult`)
  keeps **`value`** / **`issues`** — that is the external Standard-Schema spec, not
  ours to rename.
- `value` **MUST NOT** be overloaded for non-payload tokens (this is why
  `SchemaFingerprint.value` became `token`).

_Resolved (2026-07 sweep):_ success is `data` on every runtime envelope that had
drifted to `value` — `Inspection`, `StitchEvent.result`, `SurfaceOutcome`, `CacheHit`;
`SchemaFingerprint.value`→`token`. _(2026-08-01:)_ `ApiKeyOptions.value`→**`secret`** —
the credential field rode the reserved word too (the shape is inlined into `apiKey`'s
emitted `.d.ts`, so it is published surface; OpenAPI's `apiKey` scheme carries no
credential field, so no mirror was owed).

### P6 · `key` is a string; `keyOf` is a function

A field named **`key` MUST be a string** identifier/namespace. A key-**derivation**
function **MUST** be named **`keyOf`** (a `(input) => string`) and **MUST NOT** be
called `key`.

_Resolved (2026-07 sweep):_ the two derivation functions are `keyOf` —
`IdempotencyOptions.keyOf` and `CacheOptions.keyOf`, both `(input) => string`. The only
surviving `key` on the surface is `CircuitOptions.key?: string` (a store namespace), which
is what this rule mandates; `StitchStore.get/set/increment(key)` are likewise correct.

### P7 · Status-classification parity

Any field that answers "does this HTTP status match?" **MUST** share one shape — the
exported **`StatusMatch`** (`number | number[] | ((status: number) => boolean)`). Any
list-shaped field whose single-value case is common **MUST** accept **`T | T[]`** and
normalize internally.

_Resolved (2026-07 sweep):_ `verdict.accept`, `retry.on`, `throttle.on`, and auth
`refreshOn` all take `StatusMatch` (so `verdict: { accept: 404 }` is legal); `DriftOptions.ignore`
and `cache.vary` accept `string | string[]`, matching `DriftOptions.severity`'s
existing `'warn' ≡ ['warn']` widening.

### P8 · Same concept → same default across packages

A field reused across packages **MUST** carry the same default, or the divergence
**MUST** be reconciled deliberately and documented — never left as a silent inversion.

_Documented divergences (deliberate, per this rule's own clause):_ `lifecycle`
defaults **`true`** in `@stitchapi/pino` (log lines are cheap and level-filtered) but
**`false`** in `@stitchapi/sentry` (breadcrumbs/events cost quota); `tenancy` defaults
**`'app'`** in `OAuth2Options` (a client-credentials token belongs to the application)
but **`'principal'`** in `CookieSessionOptions` (sessions are per-user; fails closed);
`keyPrefix` defaults **`'stitch:'`** in `@stitchapi/react-native` (AsyncStorage is
app-shared, the prefix namespaces it) but empty in the dedicated-namespace KV stores.
Each divergence is stated in the field's JSDoc with a cross-link to its counterpart.

### P9 · Unique-by-shape exported types

An exported type identifier **MUST** denote one structural contract across all
packages. A genuinely per-framework shape **MUST** be framework-qualified
(`SolidStitchStore` vs `SvelteStitchStore`, ADR 0012 rule 6); a shared shape **MUST**
be hoisted into `query-core`/`core` and re-exported.

_Resolved (2026-07 sweep):_ the per-framework query stores are framework-qualified
(`SolidStitchStore` nests `.state`, `SvelteStitchStore` is a `Readable` — genuinely
incompatible); the per-request host seam is ecosystem-qualified (`ExpressRequestSeam` /
`ElysiaRequestSeam` / `FastifyRequestSeam` / `NestRequestSeam`, extending hono's
`HonoRequestSeam`); the host adapters' error duck-type is `StitchErrorLike`
(`Error & { status? }`), one structural contract across all six hosts, so bare
`StitchError` is core's class only.

_Blessed tiers and identities (P9-clean by design):_ `StitchLike` is two deliberate,
**compatible** tiers, not a clash — the RICH canonical
`(input?) => StitchCallResult<T>` (awaitable + streamable) lives in
`@stitchapi/query-core` and is re-exported by the five TanStack-family bindings; the
stream-less adapters (swr / rtk-query / vercel-ai) use an intentional MINIMAL
await-only `(input?) => PromiseLike<T>` — they never call `.stream()`. A real stitch
satisfies both tiers. `StreamableStitchLike` is rtk-query's streaming tier of the same
family; swr's `QueryOutput`/`QueryInput` inference helpers are also surfaced by
vercel-ai. `StreamStitchSseOptions` / `StitchErrorOptions` are intentionally **identical** per host
adapter — and `StreamStitchSseOptions` is identical _by construction_: all six hosts now
derive it from core's one `SseEmitOptions` (five `extends` it, nest aliases it), rather
than each declaring a shape that merely happens to match. Nest was the exception until it
was folded in; its two extras (a frame `index` on `delta.data`, a function form of
`delta.event`) were lifted INTO the shared envelope so every host gained them;
`StitchEventSource` is core-owned and re-exported verbatim.

### P10 · Error-class taxonomy parity

Every thrown error type (`StitchError`, `RateLimitError`, and per-package re-exports)
**MUST** guarantee the same field set (`status?`, `attempts`, `body?`, `url?`, and a
stable discriminator) so a consumer can branch on any thrown error uniformly.

Parity is achieved by **inheritance, not duplication**: `StitchError` is the root, and
every other thrown class **MUST** extend it rather than re-declare its fields. A new
class adds only what is genuinely its own (`RateLimitError` adds `retryAfter` and
`response`) and **MUST** keep `name` as its own discriminator — that is what the
serialising hosts branch on once the instance is gone (rtk-query stores a plain object).

Two consequences the surface **MUST** hold to:

- `SafeResult.error` is typed `StitchError`, so `.safe()` **MUST NOT** downgrade a
  subclass to the base. `await` and `.safe()` hand back the _same_ instance; no field is
  reachable only through `.cause`.
- Because the arms overlap, any `instanceof` chain — in this repo or in a doc example —
  **MUST** test the subclass first. `engine.ts`'s `errEvt` and the delegate-backoff docs
  are the reference spellings.

_History:_ `RateLimitError` was a sibling of `StitchError` until rc.8, with the field set
copied by hand. `.safe()` downgraded it (dropping `body`, burying the instance on
`.cause`) and every dispatch site carried a two-arm `instanceof` check; both went away
with the subclass.

### P11 · Async/sync signature parity

The same verb **MUST** keep the same sync/async shape across every surface and adapter.
A `close()` is `() => Promise<void>` everywhere; a verb is not sync in one driver and
async in another.

_Resolved (2026-07 sweep):_ `DenoKvLike.close` keeps Deno's synchronous spelling (it
is a P18 mirror); the house store `denoKvStore()` wraps it, so `StitchStore.close()`
is `() => Promise<void>` everywhere.

---

## 4. Shorthands & envelopes (the preferred authoring model)

> The maintainer's model: **every capability is a config object (an envelope), and an
> envelope with one dominant field also accepts that field's scalar as shorthand.** > `retry`/`timeout`/`cache` proved it; since the 2026-07 sweep the whole surface
> follows. Every shorthand normalizes to the canonical field per **P0**.

### P12 · Envelope + scalar shorthand

Every capability **MUST** be expressible as a config object. An envelope whose
meaningful surface is a **single dominant field MUST** also accept that field's scalar
at its `StitchConfig` slot. All slots below are shipped — the 2026-07 sweep added the
last four scalars and the `AtLeastOne<…>` object forms
([P20](#p20--no-empty-object-config-enable-with-defaults-is-a-scalar)):

| Slot         | Envelope           | Scalar accepted               | Shorthand              |
| ------------ | ------------------ | ----------------------------- | ---------------------- |
| `retry`      | `RetryOptions`     | `number` (attempts)           | `retry: 3`             |
| `timeout`    | `TimeoutOptions`   | `number \| string` (duration) | `timeout: '5s'`        |
| `cache`      | `CacheOptions`     | `number \| string` (ttl)      | `cache: '1m'`          |
| `stream`     | `StreamOptions`    | `StreamDecode`                | `stream: 'ndjson'`     |
| `multipart`  | `MultipartOptions` | `MultipartNesting`            | `multipart: 'dot'`     |
| `sse`        | `SseOptions`       | `boolean`                     | `sse: true`            |
| `.inspect()` | `InspectOptions`   | `boolean`                     | `inspect(input, true)` |

### P13 · Boolean toggle means enable-with-defaults

A capability whose primary act is an on-switch **MUST** accept **`boolean | Options`**,
where `true` = enable-with-documented-defaults; it **MUST NOT** require an object
literal merely to switch on.

_Applied:_ `idempotency?: boolean | AtLeastOne<IdempotencyOptions>` and
`inspect(input, true)`; `sse.reconnect: true` set the precedent. (Rate-limit
delegation is a `throttle` mode since the P14 fold, not its own toggle.)

### P14 · Multi-field envelopes are named, exported, and MAY shorthand their dominant field

A config sub-object with more than one field **MUST** be a named, exported `*Options`
interface (never an anonymous inline shape), so it can be imported, extended, and
referenced. A multi-field envelope **MAY** still offer a scalar shorthand for an
**unambiguously dominant** field (this is **not** the single-field collapse of P12).

_Resolved (2026-07 sweep):_ the anonymous `paginate` shape is the named, exported
`PaginateOptions`. The anonymous `rateLimit` — a near-synonym of `throttle` — was
**folded into the `throttle` envelope** (`delegate` / `on` are throttle modes) and the
top-level key removed, collapsing two keys into one and turning the buried "delegate
makes throttle inert" interaction into a within-envelope rule.
_Allowed example:_ `throttle?: string | AtLeastOne<ThrottleOptions>` where
`'2/s' ≡ { rate: '2/s' }` — `rate` dominates although `concurrency` also exists (so
this is a P14 dominant-field shorthand, not a P12 collapse).

### P15 · Required fields are deliberate and get a named/positional shorthand — not silent defaults

An `*Options` envelope **SHOULD** be `{}`-constructible (every field optional with a
documented default). Where a field is **required by design** because a silent default
is a footgun, it **MUST** stay required and the envelope **MUST** offer a scalar/
positional shorthand naming the required value(s).

- `CircuitOptions.failures`/`cooldown` **stay required** (a breaker with invisible
  thresholds fails open/closed silently) — the positional shorthand is the tuple
  `circuit: [5, '30s']` ≡ `circuit: { failures: 5, cooldown: '30s' }`.
- `CacheOptions.ttl` **stays required** — its shorthand `cache: '1m'` already names it.

> This corrects the audit draft, which tried to defend `ttl`-required while attacking
> `circuit`-required. Required-with-a-named-shorthand is the **one** acceptable form of
> a non-`{}` envelope.

---

## 5. Cross-cutting

### P16 · Cross-surface & cross-package parity

A concept **MUST** use the same field name, shorthand, and envelope on every surface
(`stitch` / `seam` / `pipe`) and every framework package, varying only the
framework-idiomatic verb (`use` / `create` / `inject` — and svelte's `stitchStore*`
family: `use:` is Svelte **directive syntax**, so a `useStitch` there would collide
with the language, not echo it). New config fields are added to `StitchConfig` and
**projected** (`SeamConfig = Omit<StitchConfig, …>` is the model), never re-declared
per surface. ADR 0012's `stitchQueryOptions` spelling applies to all five TanStack
adapters, not react only.

_Resolved (2026-07 sweep):_ the SSE helper is `streamStitchSse` on every host (was
also `sendStitchSse` / `stitchSse`); error-options is one `StitchErrorOptions` shape
(with `body`) everywhere (was `StitchErrorHandlerOptions` / `ToHttpExceptionOptions`);
the hook result is `UseStitchResult` (react) / `VueUseStitchResult` /
`InjectStitchResult` (angular) over query-core's shared `StitchQueryResult` — the vue one
is framework-qualified because wrapping each field in a `ComputedRef` makes it
unassignable to react's raw shape in either direction, the `SolidStitchStore` /
`SvelteStitchStore` case; `stitchQueryOptions` replaced the bare `queryOptions` in
vue/solid/svelte/angular.

_Where parity stops:_ a slot that mirrors a **framework hook** is named for that
framework, not unified across hosts — `errorHandler` on fastify (`setErrorHandler`) vs
`onError` on elysia (`.onError`). See
[P18](#p18--adapter-mirrors-keep-upstream-spelling-house-contracts-use-house-vocabulary).
Parity binds the **shape** behind such a slot, which is identical
(`boolean | AtLeastOne<StitchErrorOptions>`), not the word in front of it.

_Settled:_ the SSE frame options are **`delta`** and **`error`** on every SSE-capable
host (`express` / `fastify` / `hono` / `next` / `elysia`) — symmetric envelopes, each a
`{ data, event, … }` config that also accepts a **bare shaper function as shorthand for
`{ data }`** (`delta: (c) => c.text`, `error: (e) => e.message`). `delta` carries
`{ data, event, id }`; `error` carries `{ data, event, observe }` (`observe` sees the
real server-side failure while the client still gets the generic `data: error` token).
Do **not** reintroduce the flat `data` / `event` / `id` / `errorData` / `onError`
spellings (nor the interim `payload` name).

### P17 · One canonical duration form

Per **D3**, **ms is the single house time unit** and **no duration field carries the
`Ms` suffix** — input or emitted. Every **consumer-authored** duration additionally
**MUST** accept **`number | string`** (raw ms or a token like `'5s'`/`'1m'`), parsed by
one shared `parseDuration`. Every **emitted** duration is a raw-ms `number`; its unit is
stated in its JSDoc, not its name.

**The test is the value, not the slot.** Read the widening forwards, as the one question
to ask of any position: **if it accepts a duration at all, it MUST also accept a
`string`.** A bare `number` is a violation wherever a consumer can choose the value —
there is no duration on the authoring surface that takes ms and _only_ ms.
"Consumer-authored" names **who supplies the value**, not what kind of position holds it,
so the rule reaches all four:

- a **field** on an `*Options` envelope (`timeout.total`, `cache.ttl`);
- a **positional/tuple element** of a P15 shorthand (`circuit: [5, '30s']`);
- a **parameter** of an exported function or a conformance kit's knob;
- a **value returned by a hook the consumer implements** on an extension seam
  ([P21](#p21--every-contract-has-an-extension-seam)) — a `Surface`'s `resumeRetry`, or the
  `after` on the `SurfaceOutcome` its `interpret` returns. The seam's _author_ is a consumer
  of core even though the shape is core's.

The complement pins the other half, and is just as normative: a duration **core
produces** — an emitted `StitchEvent` field, a read-back `*Result`, a resolved internal,
a value core passes _into_ a contract the consumer implements (`StitchStore.set`'s `ttl`)
— is a raw-ms `number` and **MUST NOT** grow a string arm. Nobody authors it, so a token
there would be a shape the reader must handle and the writer can never send.

**A widened type is only half the rule; the parse is the other half.** The value **MUST**
reach `parseDuration` before any arithmetic or sleep site. Widening a type without
widening its read site is _worse_ than not widening it: the token then arrives where a
number is assumed, and JS coerces rather than throws — `remaining <= '700ms'` is `false`
and `setTimeout('700ms')` fires immediately, so the wait silently collapses to ~0 with no
error anyone can see. That is the failure `SurfaceOutcome.after` shipped with until #609,
and the reason this clause names the parser rather than only the type.

_Why:_ every JS-native time API (`Date.now()`, `setTimeout`, `performance.now()`) is
**already ms**, so ms is the unambiguous default and the suffix is redundant noise
everywhere. On inputs, accepting `'5s'` on top is pure ergonomic gain (and a `Ms` name
on a field that takes `'5s'` would be a lie). On outputs, one uniform de-suffixed
vocabulary beats a split convention; the JSDoc carries the unit.

_Resolved (2026-07 sweep, inputs — widened + de-suffixed):_ `RetryOptions.baseDelay`/
`maxDelay` (were `baseMs`/`maxMs`, since folded into `backoff.base`/`backoff.max` by the
P24 envelope), `CircuitOptions.cooldown` (its `halfOpenAfter` sibling was widened here
too, then **removed** in the 2026-08-04 P1 fix below — the two named one instant),
`ReconnectOptions.delay` (was `backoffMs`, de-suffixed to `backoff` and later renamed
under P2), `OAuth2Options.refreshSkew` (now `refresh.skew`), `CookieSessionOptions.ttl`,
and `verifyStoreContract`'s `ttl` knob — all `number | string` via the one shared
`parseDuration`.
_Resolved (seam-authored, 2026-08):_ the two positions where a **`Surface`** supplies a
duration — `SurfaceOutcome.after` (#609) and `Surface.resumeRetry`'s return — take
`number | string` and are parsed at the engine's sleep site. Both were missed by the
2026-07 sweep because its checklist was end-user config, which is the scope error the
"test is the value, not the slot" clause above exists to close.
_Not widened, deliberately:_ `StitchStore.set`/`increment`'s `ttl` **parameter** stays a
raw-ms `number` — **core** calls those verbs with an already-resolved value, so it is the
complement case, not an oversight. The consumer-authored knob of the same name on
`verifyStoreContract` is widened, which is the pair that shows the rule turns on who
supplies the value.
_Resolved (2026-07 sweep, emitted — de-suffixed):_ `StitchEvent` `waited`,
`retryAfter`, the `done` event's `elapsed` (was `ms`), `MockResponse.delay`;
`SseEvent.retry` stays (already bare; it mirrors the SSE `retry:` wire field).
_Enforced by lint **R9** (§7)_ — see [P25](#p25--one-canonical-size-form), which the same
rule and the same gate cover for the byte dimension.
_Unit hazard (the exception to "all JS time is ms"):_ a few fields are **seconds**
because they mirror a wire format — the HTTP `Retry-After` header (delta-seconds),
Cloudflare KV `expirationTtl`. Every StitchAPI-_authored_ duration stays ms; a field
that must speak a foreign unit converts at the adapter edge and is named with its true
unit (`MockResponse.retryAfterSeconds` — it sets the wire header) so the unit is never
silent.

### P18 · Adapter mirrors keep upstream spelling; house contracts use house vocabulary

A duck-type that mirrors a foreign SDK **MUST** keep that SDK's spelling (so it
structurally matches). StitchAPI's **own normalized** contracts (`StitchStore`,
`RedisDriver`) **MUST** use one house vocabulary: `ttl` (ms — the house unit, no suffix
per P17; convert foreign units at the edge), **whole words — never a wire
abbreviation** (`delete` not `del`, `increment` not `incr`),
`close(): Promise<void>` (async, per P11), with one optionality per parameter (`ttl`
MUST NOT be optional on `set` but required on `increment`).

_Why whole words:_ the house verbs are the vocabulary a **consumer** implements against,
not the bytes a server parses. `DEL`/`INCR` are terse because they cross a socket
millions of times a second; a TypeScript method name is read, not transmitted. The rule
is all-or-nothing by construction — a contract that spells `delete` but keeps `incr`
teaches neither convention, and the reader has to memorize which verbs got the
abbreviation. The Redis **command** names stay verbatim wherever the code speaks Redis
(the Lua `INCR`, the `IoredisLike`/`NodeRedisLike`/`UpstashLike` mirrors' `del`) — that
is the first half of this rule doing its job, not an exception to the second.

_Extends to host-adapter hook slots._ A host adapter's option for a **framework hook**
takes **that framework's word for it**, so the option reads as the framework its user
already knows: `@stitchapi/fastify` registers via `setErrorHandler`, so its plugin option
is **`errorHandler`**; `@stitchapi/elysia` registers via `.onError`, so its option is
**`onError`**. One concept, two spellings, **deliberately** — this is the mirror clause,
not a [P16](#p16--cross-surface--cross-package-parity) parity break, and a sweep that
unifies them has removed information rather than added consistency. The _shape_ behind
both stays identical (`boolean | AtLeastOne<StitchErrorOptions>`), which is where parity
actually binds. Only these two hosts have the slot at all — express/hono/nest/next expose
standalone helpers with no options object — and each of those helpers is likewise named
for its own framework (`stitchErrorHandler` on express/fastify, `stitchOnError` on
hono/elysia, `StitchExceptionFilter` on nest).

### P19 · The alias obligation is scoped to the GA channel

The `@deprecated`-alias requirement binds the **general-availability** channel. On a
pre-release channel (`rc`, `beta`, `canary` — anything published under a prerelease tag),
a rename, narrowing, or removal mandated here **MAY** ship as a **hard break**: no alias,
declared under **BREAKING CHANGE** with a one-line migration in `CHANGELOG.md`. Once
**1.0 GA** ships, the obligation is in force — every such change **MUST** carry a
`@deprecated` re-export/field alias pinned by an identity test (extending ADR 0012's
precedent from symbols to fields), retired only on the next major. Widening
(`number → number | string`, P17) is non-breaking and needs no alias in either channel.

_Why the channel, not the change:_ a prerelease is the window the semver contract sets
aside for exactly this. Paying alias tax during it buys back-compat for a population that
has accepted breakage by installing an `rc`, and the aliases accumulate into a second
vocabulary the GA cut then has to delete — every one a field a reader must learn is dead.
The clean surface at 1.0 is worth more than continuity between two release candidates.

_Aliases already shipped stay._ Relaxing the rule forward does not retroactively demand
their removal — but the rule currently guards an empty set. The 2026-07 sweep
([§6](#6-migration-record-2026-07-08-hard-break-sweep)) applied every rename as a hard
break, so **no `@deprecated` member survives anywhere in `packages/*/src`**, and the only
`*Ms` names left on the surface are OTLP's `*UnixMs` instants, which P17 carves out as
timestamps rather than durations. (`keyOf` and `StatusMatch` are the canonical spellings,
not aliases.) The rule stands for the next alias that ships.

_Corollary — some contracts cannot alias at all._ Where the consumer **implements** an
interface and core **calls** it (`StitchStore`, `RedisDriver`, `Adapter`, `TraceSink`,
`AuthStrategy`), there is no `new ?? old` to read: an "alias" means typing **both**
spellings optional forever and dispatching on whichever is present, which erases the
contract the rename exists to state and lets an implementation satisfy the type while
providing neither. For these, a rename is a hard break in **any** channel — post-GA it is
a major-version change, not an aliasable one.

### P20 · No empty-object config; enable-with-defaults is a scalar

The empty object `{}` **MUST NOT** be a valid value at a config slot. Where `{}` would
carry meaning — "enable this capability with all defaults" — the capability **MUST**
express that case as a **scalar** (`true` for a toggle; the dominant field's value for a
single-field envelope, per P12) and **MUST** type its object form so the empty object is
a **compile error**: `boolean | AtLeastOne<Options>` (a toggle) or
`Scalar | AtLeastOne<Options>`. The object form is then reserved for real customization
(≥1 field); the all-defaults case is the scalar.

_Why:_ `idempotency: {}` reads as a no-op but silently **enables** idempotency with
defaults — a meaningful value hidden behind the most opaque possible spelling. `true`
says what `{}` means; rejecting `{}` removes the trap. This is the enforcement teeth for
[P13](#p13--boolean-toggle-means-enable-with-defaults) (which _offers_ `true`) — P20
also _forbids_ `{}`. It refines [P15](#p15--required-fields-are-deliberate-and-get-a-namedpositional-shorthand--not-silent-defaults):
an all-optional envelope is still internally `{}`-constructible, but at the **slot** the
all-defaults case is the scalar, not `{}`.

_Helper:_ `AtLeastOne<T>` = a value with at least one property of `T` set (`{}` matches
none of its per-key-required variants, so it is rejected).

_Resolved (2026-07 sweep):_ every capability slot is `Scalar | AtLeastOne<Options>`
(or `boolean | AtLeastOne<…>`): `stream`, `multipart`, `sse`, `throttle`,
`idempotency`, `hooks`, `input`, `retry`, `timeout`, and `circuit` (whose scalar is
the `[failures, cooldown]` tuple, P15). `{}` is a compile error at each of them; lint
**R6** keeps it that way.

### P21 · Every contract has an extension seam

No consumer-facing contract may be a closed dead end. Every capability **MUST** be
extensible **without forking core** — through a plugin interface (`Surface`, `Adapter`,
`StitchStore`, `TraceSink`, `AuthStrategy`, `Validator`/`SchemaLike`), config composition
(`extends` fragments), or a documented escape hatch. A new behaviour is added as a
**pluggable seam**, never a hard-coded branch a host cannot reach. When P20 tightens an
envelope, this rule guarantees the door stays open: there is always a way to extend.

_Why:_ strictness without an escape hatch paints consumers into a corner. The two rules
are a pair — P20 says "the envelope is exact," P21 says "but the system is open." A
capability that can only be configured the one way core shipped, with no seam to extend
it, is a contract bug.

_Existing seams (the bar a new capability must clear):_ surfaces are `Surface` plugins
(HTTP/GraphQL/SSE/shell/LLM are all the same seam); transport is a swappable `Adapter`;
state is a pluggable `StitchStore`; observability is any `TraceSink`; auth is any
`AuthStrategy`; validation is any Standard-Schema `Validator`; and every stitch composes
via `extends` fragments. A new capability that exposes none of these is the violation.

### P22 · A standards-interop contract uses the standard's field names

When one of StitchAPI's **own** contracts exists to interoperate with an external standard
— it round-trips to that standard's wire format or object model — its fields **MUST** use
that standard's names, not a house alias, even though [P18](#p18--adapter-mirrors-keep-upstream-spelling-house-contracts-use-house-vocabulary)
would otherwise let a normalized house contract pick its own vocabulary. P18's "house
vocabulary" exists for one consistent _internal_ language; it does **not** license renaming
a field whose entire job is to carry that standard's value. Match the standard's token
(house casing per our convention) so the export is an **identity mapping** with no
translation seam. As with P18, follow the standard that governs **each** layer and convert
at the edge — never blend two standards' vocabularies in one place.

_Why:_ a private alias on an interop field is paid for twice — a translation step at the
boundary where it meets the standard, and a lookup for every reader who knows the standard
but not our word for it. P18 keeps duck-type mirrors **structurally** matching; P22 keeps
value-level interop contracts **nominally** matching, for the same reason.

_Canonical case:_ `RunContext` is StitchAPI's run identity, exported verbatim as
OpenTelemetry spans (ADR 0007). Its fields were `runId`/`parentId` (house aliases) →
renamed to **`spanId`/`parentSpanId`** (`traceId` already matched), so the `otlp.ts`
mapping is an identity and `parentId`'s collision with W3C's directional `parent-id` header
field is gone. The **wire** side still follows its own standard — W3C Trace Context
(`trace-id`/`parent-id`/`trace-flags`) — translated at the boundary, never blended. See
[ADR 0017 Decision 7](adr/0017-outbound-trace-context-propagation.md) and the
`concepts/run-identity` page.

_Also:_ `apiKey`'s options mirror OpenAPI's `apiKey` security scheme: the key is labelled with
**`name`** and located with **`in: 'header' | 'query' | 'cookie'`** — the same two fields in every
arm. So `stitch gen openapi` (import) and `stitch export --openapi` (export) are identity mappings
with no translation seam, and the three locations are symmetric
([P16](#p16--cross-surface--cross-package-parity)). The pre-GA sweep removed the header-only
`header` alias: **`name` is the only spelling — `apiKey({ header })` is forbidden.**

### P23 · One schema intake; foreign formats enter through one adapter

Every place that consumes a validation schema — a stitch's `input`/`output`, and the
standalone `validate`/`compile` — **MUST** accept the same `SchemaLike` union and yield the
same `ValidationResult` shape. Standalone validation is the check a stitch runs internally,
exposed — never a second, differently-shaped path (reaching into a schema's `['~standard']`
namespace is a protocol detail, not a consumer API). A format that is not already a Standard
Schema — a JSON Schema obtained at runtime — enters through **one** adapter that mints a
`SchemaLike` (`JsonSchema.adapt`); no consumer accepts a foreign format directly, and no
consumer grows a bespoke intake of its own.

_Why:_ [P21](#p21--every-contract-has-an-extension-seam) keeps the validation seam **open**
(any Standard Schema is accepted); P23 keeps it **uniform** — one intake type and one result
shape across every consumer, so what a stitch can validate and what you can validate standalone
are the same set, learned once. A per-consumer intake, or a raw foreign-format path bolted onto
a single consumer, splits that knowledge and re-introduces the casts the boundary exists to kill.
The lone adapter is the only ceremony the format genuinely needs — a JSON Schema requires a
validation engine and core ships none, so the engine is caller-supplied at `adapt` — so that step
stays visible while everything downstream of it is uniform.

_Canonical case:_ `stitch({ input, output })`, `validate(schema, value)`, and `compile(schema)`
all take `SchemaLike` and return `ValidationResult`; `JsonSchema.adapt(json, { ajv })` is the sole
bridge from JSON Schema, producing a `SchemaLike` those consumers treat identically. The standalone
`validate`/`compile` verbs replaced app-level `schema['~standard'].validate(…)`.

### P24 · A shared field-name prefix in a house contract is an envelope

**≥2 public flat fields sharing a leading-word prefix in a house-owned contract MUST** fold into
**one** envelope: a named, exported `*Options` interface (P14), typed so `{}` is a compile error
(P20), with a scalar shorthand for the dominant field where one field dominates (P12).

_Carve-outs:_

- **(a) Foreign mirrors keep the foreign shape.** A contract that exists to structurally or
  nominally match a foreign SDK, standard, or wire format (P18/P22) keeps **every** field of the
  pair — it is not house vocabulary to fold. This covers TanStack's `queryKey`/`queryFn`, RFC
  6749's `clientId`/`clientSecret`/`clientAuth`, the XHR `responseType`/`responseText` pair (and
  its React Native mirror), RTK Query's lifecycle names (`cacheDataLoaded`/`cacheEntryRemoved`),
  and Orama's own index-document schema (`DocSearchHit.pageUrl`/`pageTitle`) — all exempt.

    **The exemption binds the layer that meets the standard, not every layer above it**
    ([P22](#p22--a-standards-interop-contract-uses-the-standards-field-names): follow the standard
    that governs **each** layer, and convert at the edge). Where a mirror field also appears on an
    authoring surface, only the boundary contract is pinned; the authoring surface is house
    vocabulary and **MAY** fold, provided the engine converts before the value reaches the
    boundary.

    _Applied (2026-08-03):_ `AdapterRequest.responseType` is the XHR/fetch-facing contract and
    keeps the XHR spelling permanently — an `xhr` adapter assigns it straight through. The
    authoring slot folded into the `wire` envelope as **`wire.response`**, and the engine maps it
    onto `AdapterRequest.responseType` when it builds the request. Note the protected **pair** is
    XHR's `responseType`/`responseText`: StitchAPI has no `responseText`, so the fold this
    carve-out guards against (`response: { type, text }`) was never live here. What the carve-out
    still forbids is renaming the **transport** field, which this change does not do.

- **(b) A single-field group collapses per P12 instead of nesting.** When only **one** member of
  the pair is a genuine option and the other is a discriminator/tag describing it (not an
  independent knob), the pair **stays flat** — nesting would turn a scalar-plus-tag into a
  needless envelope for zero added configurability. **A flat pair kept under (b) MUST make the
  dead combinations unrepresentable**, via the mutual-exclusion shape R8 already recognises
  (`X?: never`, or a `ConfigError<…>` brand where a bare `never` would collapse the whole config
  and report every unrelated field). Staying flat is a licence to skip the envelope, never a
  licence to let a tag/option pairing typecheck when the option is inert.
- **(c) Conventional prefixes are not groups:** `on*` handlers, `is*` guards, and a percentile
  family (`p50`/`p95`/`p99`) share a prefix by naming convention, not by being facets of one
  capability.

_Canonical case for (b) (2026-08-03):_ `WireOptions.body` + `multipart`. The three body encodings
are **not symmetric**, so no per-encoding sub-envelope is licensed inside `wire`: `json` has no
options at all, `multipart`'s `nesting` is genuinely private to it, and `form` has none of its own
— array serialisation is `wire.array`, **shared with the query string**, because both emit
`application/x-www-form-urlencoded` and run one walker. A three-arm union under `wire.body` would
therefore carry two empty arms and duplicate a query-string concern. The pair stays flat _within_
the envelope, and `MultipartOnlyOnMultipartBody` makes `wire.multipart` unsatisfiable unless
`wire.body` is `'multipart'` — so `wire: { body: 'json', multipart: 'dot' }` is a compile error
rather than silently inert config.

_Second case for (b) (2026-08-16):_ the **endpoint slot** — `url` vs `baseUrl` + `path`. It stays
flat because its members do not share a level (`SeamConfig` omits `url`/`path`, so `baseUrl` is
seam vocabulary and the other two are per-endpoint) and because a dominant-field shorthand would
mean two different things on the two surfaces, a P2 collision. `OneEndpointSpelling` supplies the
(b) obligation the slot was missing: `baseUrl`/`path` beside a `url` in the SAME literal is a
compile error, while across `extends` fragments the spellings stay a legal last-writer-wins
override. See the migration record for the silent case that motivated it.

Applied on every surface that authors a stitch (`stitch`, `graphql`, `Seam.stitch`,
`Seam.graphql` — both the inferring and the fallback overload, or a rejected config falls through
to the loose one and typechecks after all). **`seam()` itself is exempt and stays non-generic:**
capturing its argument type would suppress excess-property checking, which is the only thing
keeping `input`/`output` off a seam fragment (`SeamConfig` Omits both). That structural guarantee
outranks catching an inert `multipart` on the fragment, which every member surface still catches.

_Why `wire` is an envelope and `request`/`response` would not be_ ([P25](#p25--one-canonical-size-form)'s
"an envelope is licensed where it names an unambiguous subject"): `wire` groups by **category** —
every member is a wire-format choice — so the name is exhaustive over its contents. A phase
envelope would not be: `request` would hold two of the ~15 request-shaping slots while `headers`,
`method`, `body`, and `params` stayed outside, so the name would promise more than it holds.
Grouping by category also gives `wire.array` a truthful home, which no body-scoped container
could: it governs the query string and the form body alike.

_Canonical case (converted 2026-07-08):_ `OAuth2Options.refresh` and
`CookieSessionOptions.refresh` fold what were `refreshOn`+`refreshSkew` and `refreshOn`+
`refreshWhen` into `refresh?: StatusMatch | AtLeastOne<…RefreshOptions>` (a bare `StatusMatch` is
the P12 shorthand for `{ on: … }`); `SentrySinkOptions.capture` folds `captureErrors`+
`captureDrift` into `capture?: boolean | AtLeastOne<SentryCaptureOptions>`. All three landed as
hard breaks, no aliases (P19).

_Named exemptions verified against this rule_ (carve-out (a); named explicitly because each is the
literal shape this rule would otherwise flag): **`StitchQueryOptions.queryKey`/`queryFn`** (the
TanStack mirror, P3 — note this rule's own motivating example is itself exempt);
**`OAuth2Options.clientId`/`clientSecret`/`clientAuth`** (RFC 6749); **`DocSearchHit.pageUrl`/
`pageTitle`** (mirrors the persisted Orama index document schema; maintainer-exempted 2026-07-08).

Enforced by lint **R8** (§7); its allow-list carries the one-line rationale for every verified
exemption beyond this rule's named list — a discriminated-union pair (mutually exclusive by
`X?: never`), a derived/internal read-view that is not itself an authored config, or a
plugin-extension-hook bag, are all real shapes this rule does not reach.

### P25 · One canonical size form

**Bytes are the house size unit.** Every **consumer-authored** byte cap **MUST** accept
**`number | string`** — a raw byte count or a token like `'64kb'`/`'1mb'` — parsed by one
shared `parseBytes`, whose units are **powers of 1024** (`'1mb'` = 1_048_576). Every
**emitted** size is a raw-byte `number`.

**Same test as [P17](#p17--one-canonical-duration-form), same four positions: if a
position accepts a size in bytes at all, it MUST also accept a `string`.** The two rules
are one rule over two dimensions, so read this section and P17's widening clause together
— the position may be a field, a tuple element, a parameter, or a seam hook's return; the
question is only whether a consumer can choose the value. The complement holds too: a
size **core produces** (`AdapterProgress.total`, a resolved internal like `execFile`'s
`maxBuffer`) is a raw-byte `number` and takes no string arm. And the widening is only
real once the value passes through `parseBytes` — an unparsed `'1mb'` compared against a
byte count is the size analogue of P17's silently-collapsing sleep.

**The one place the two dimensions diverge is the counterpoint that proves the rule:** a
**`chars`** cap counts UTF-16 code units, not bytes, so it is **not** a size in this
rule's sense and **MUST NOT** accept a string — see the `max`/`chars` split below. "Takes
a duration or a byte size ⇒ takes a string" and "counts something ⇒ stays a bare
`number`" are the same distinction P4 draws between a magnitude and a count; `chars`,
`attempts`, `entries`, `pages`, and `tokens` all sit on the count side.

**A size cap never rides a flat, suffixed top-level field — it lives inside the envelope
that names its subject** (P12/P14/P24: `serve`'s `body`, trace's `body`, `stream`'s and
shell's `buffer`). Inside the envelope the subject is named once, so the ceiling field
carries only the **dimension**:

- a **byte** ceiling is the bare **`max`** — the unmarked default does the work (bytes are
  the house size unit, so an unsuffixed size ceiling **IS** bytes), `max` bounds a
  **magnitude** (the case [P4](#p4--one-cap-vocabulary) leaves it, the size analogue of
  `BackoffOptions.max`), and it accepts `number | string`;
- a **character-count** ceiling is **`chars`** — a bare plural count noun (P4's own
  `tokens` case: UTF-16 code units of decoded text are countable units) — and it **MUST
  NOT** accept a byte token, so its type is `number` with **no string arm**. A `'64kb'`
  on decoded text is a category error, and the grammar makes it a **compile** error.

The Bytes/Chars contrast is load-bearing per
[P1](#p1--one-word-one-concept-one-value-space) — a byte cap and a code-unit cap are
different value-spaces — and this rule carries it **twice**: in the inner field name
(`max` vs `chars`) and in the type (`number | string` vs `number`). Both marks survive
every fold; neither depends on a suffix a rename could shed.

_History:_ until 2026-08-01 this section mandated the opposite for top-level fields —
keep the `Bytes`/`Chars` suffix — defending the flat `ServeOptions.maxBodyBytes` /
`TraceOptions.maxBodyChars` pair on the grounds that the suffix was the only thing
telling the two dimensions apart. The amendment folded all three flat caps into
envelopes ([§6](#6-migration-record-2026-07-08-hard-break-sweep)): `serve`'s
`body: '2mb'` ≡ `{ max: '2mb' }`, trace's `body: 2048` ≡ `{ chars: 2048 }`, and
`stream`'s `buffer: 4_000_000` ≡ `{ chars: 4_000_000 }`. The contrast the old clause
protected did not dissolve — it moved into names and types, where the compiler holds it.

_Why:_ every JS-native size API (`byteLength`, `Buffer.length`, `execFile`'s `maxBuffer`)
is already bytes, so a bare number needs no unit; and 1024-based `kb`/`mb` is what the
Node ecosystem's de-facto parser already means by those tokens
([P22](#p22--a-standards-interop-contract-uses-the-standards-field-names)), matching the
base the house defaults are written in (`10 * 1024 * 1024`). An unparseable token resolves
to `undefined` and lands on the field's default — a typo can never widen a cap to
"unbounded".

_Canonical case:_ the two **byte** envelopes — `serve`'s `body`
(`ServeBodyOptions.max`, shorthand `body: '2mb'`) and `@stitchapi/shell`'s `buffer`
(`ShellBufferOptions.max`, shorthand `buffer: '2mb'`) — each take `2 * 1024 * 1024` or
`'2mb'`; the two **chars** envelopes — trace's `body` (`TraceBodyOptions.chars`,
shorthand `body: 2048`) and `stream`'s `buffer` (`StreamBufferOptions.chars`, shorthand
`buffer: 4_000_000`) — take a bare count, never a token. `parseBytes` is exported from
`stitchapi` so a peer package parses the grammar instead of mirroring it.

Enforced by lint **R9** (§7), together with P17 — one rule, one gate, both directions: a
`max` that takes only `number` and a `chars` that took a `string` are the same finding
seen from either end. R9 pins the **type**; the other half of the rule — that the value
reaches `parseBytes`/`parseDuration` before it is compared or slept on — is dataflow, and
is pinned by test instead.

---

## 6. Migration record (2026-07-08 hard-break sweep)

Not normative. The rule is the law; this records what the sweep applied and what is left.
While the line is pre-GA, a rename may land as a hard break or under a `@deprecated` alias
— [P19](#p19--the-alias-obligation-is-scoped-to-the-ga-channel) scopes the obligation to
the GA channel. Severity = consumer blast radius.

**The open set is empty.** A follow-up audit (2026-07-31) swept every principle against
the published surface and found violations no rule in [§7](#7-enforcement) was tracking —
a green baseline meant "nothing the rules can see", not "nothing there" — so the rules
were widened first, and each finding was fixed against a gate that holds it. A second
exhaustive pass (2026-08-01) then verified every multi-word field name on the published
surface — 249 of them — against P1/P4/P17/P18/P22/P24/P25 and closed what it found.
A third pass (2026-08-04) added the widening clause to
[P17](#p17--one-canonical-duration-form)/[P25](#p25--one-canonical-size-form) and the
**R9** gate under it, and swept every duration- and size-valued position on the surface
against both — the findings sit at the end of the list:

- **P20** — four slots typed `Fn | Options` or `Options | false`, where `{}` still
  compiled. **Fixed** (`AtLeastOne`, and `errorHandler` gained the `true` spelling).
- **P9** — `UseStitchResult` declared incompatibly by react and vue. **Fixed** (the vue
  side is framework-qualified `VueUseStitchResult`).
- **P4** — `maxTokens` on the `stitchapi/llm` types. **Fixed**
  ([P4](#p4--one-cap-vocabulary) → `tokens`; the wire keeps `max_tokens`).
- **P16** — nest's SSE options carried the flat spellings the _Settled_ clause above
  forbids. **Fixed** (PR #574: all six hosts derive from core's one `SseEmitOptions`;
  nest's extras were lifted into the shared envelope). Solid and svelte accepted a
  `streaming` they hard-set and ignored. **Fixed** (PR #573: the flag is
  `Omit`-ted from their option types, matching react/vue/angular).
- **P14** — an anonymous inline shape on `SecurityScheme`'s oauth2 arm. **Fixed**
  (2026-08-01: the flow shape is the named, exported `OAuth2ClientCredentialsFlow`;
  every field keeps the OpenAPI/RFC spelling per P22 — the shape mirrors the standard,
  the name is ours).
- **P5 + P15** — `apiKey`'s credential field was `value`, the one word P5 reserves for
  the Standard-Schema success payload (the `SchemaFingerprint.value`→`token` precedent;
  the shape is inlined into `apiKey`'s emitted `.d.ts`, so it is published surface).
  **Fixed** (2026-08-01: `apiKey({ secret })` — OpenAPI's `apiKey` scheme carries no
  credential field, so there was no upstream spelling to mirror; and per P15 the one
  required field names its scalar shorthand, `apiKey(env('X'))` ≡
  `apiKey({ secret: env('X') })`, matching `bearer`'s positional secret).
- **P1** — the CLI-internal `from-curl` parser's `bodyKind`. **Fixed** (2026-08-01:
  `bodyType`, the one spelling every published field already used; CLI-internal, no
  consumer impact).
- **P1 (two names, one instant)** — `CircuitOptions.halfOpenAfter` was a second name for
  `cooldown`. The audits above swept for one word meaning two concepts; this is the
  converse — one concept wearing two words — and no rule in [§7](#7-enforcement) can see
  it, because both spellings are individually fine. `createCircuit` resolved
  `halfOpenAfter ?? cooldown` into a single local and `phase()` — the **only** place the
  open/half-open boundary is decided — compared against that one value, so `cooldown` had
  no effect of its own once `halfOpenAfter` was set. **Fixed** (2026-08-04:
  `halfOpenAfter` removed; `cooldown` is the one boundary. Hard break, no alias
  ([P19](#p19--the-alias-obligation-is-scoped-to-the-ga-channel), `rc` channel).)
  `cooldown` is the survivor on three counts: it is the one-word token P1 prefers, it is
  the spelling [P15](#p15--required-fields-are-deliberate-and-get-a-namedpositional-shorthand--not-silent-defaults)
  names as required-by-design, and it is the second slot of the `[failures, cooldown]`
  tuple ([P20](#p20--no-empty-object-config-enable-with-defaults-is-a-scalar)).
  _They could not have been made independent instead:_ a call is either rejected or
  admitted, so a phase between "fast-failing" and "probing" would have to behave exactly
  like `open` or exactly like `closed`. The decoupling the docs advertised had nowhere to
  live. _Why it survived the sweeps:_ nothing tested the transition — `halfOpenAfter`
  appeared in no test in `packages/core/test`, so no assertion ever depended on which
  field moved the boundary. The gap is closed by a millisecond-exact `manualClock` test in
  `circuit-breaker.spec.ts`. _Not statically enforceable at the slot — at the time:_
  `NoUnknownKeys` guarded top-level `StitchConfig` keys only, and a nested envelope inside
  an inferred `const C` got no excess-property check either, so a stale `halfOpenAfter`
  typechecked clean and would silently take the `cooldown` boundary instead — a real timing
  change. A construction-time nudge in `makeStitch` was the only signal. **That gap is since
  closed** — the `NoUnknownNestedKeys` entry below descends into the house envelopes, so
  `circuit: { …, halfOpenAfter }` is a compile error naming the key, and the nudge is now a
  second line of defence for JS callers rather than the only one. It stays runtime-only (no
  `@deprecated` tag, so **R7** stays clean) and is deleted at 1.0 GA.
- **P1 + P4 (a scope wearing the name of what it counts)** — `TimeoutOptions.perAttempt`.
  `timeout` already names the subject, so by
  [P24](#p24--a-shared-field-name-prefix-in-a-house-contract-is-an-envelope)/[P25](#p25--one-canonical-size-form)
  ("inside the envelope the subject is named once") the member owes only its **scope** —
  and `total`'s opposite number is a scope, not an attempt counter. The obvious
  de-prefixing was blocked: [P4](#p4--one-cap-vocabulary) reserves singular `attempt` for
  the current index (the engine emits it on every `progress` event) and plural `attempts`
  for the running count, so `timeout.attempt` would have made one word mean both an index
  and a duration — the [P1](#p1--one-word-one-concept-one-value-space)/[P2](#p2--dont-reuse-one-word-for-genuinely-different-concepts--rename-one)
  collision the rename was meant to avoid. **Fixed** (2026-08-04: **`each`** — the
  one-word token P1 prefers, free across the surface, and the natural pair for `total`:
  `timeout: { total: '10s', each: '3s' }`. Hard break, no alias
  ([P19](#p19--the-alias-obligation-is-scoped-to-the-ga-channel), `rc` channel); a stale
  `timeout: { perAttempt }` is a compile error naming the key via `NoUnknownNestedKeys`.)
  _Why it survived the 2026-08-01 multi-word pass:_ that pass verified 249 multi-word
  names and `perAttempt` reads as an accurate description of what it does — the defect is
  not that it is wrong but that it is not the _shortest_ true token, which is the half of
  P1 a name can fail while still describing its value correctly. No rule in
  [§7](#7-enforcement) reaches it either: **R8** needs a shared leading-word prefix and
  `total`/`perAttempt` share none, and **R9** pins the _type_ of a duration member, never
  its spelling. Same blind spot as the `halfOpenAfter` entry above — a naming rule whose
  violations are individually well-formed.
- **P25** — the flat, suffix-carrying size caps (`ServeOptions.maxBodyBytes`,
  `TraceOptions.maxBodyChars`, `StreamOptions.maxBufferChars`). **Fixed** (2026-08-01:
  folded into subject-named envelopes — `serve`'s `body` (`{ max }`), trace's `body`
  (`{ chars }`), `stream`'s `buffer` (`{ chars }`) — under the amended
  [P25](#p25--one-canonical-size-form), which now carries the Bytes/Chars contrast in
  the inner field name and the type grammar instead of a top-level suffix. The trace
  fold also closed a latent trap: full capture was the too-easy `maxBodyChars: false`;
  it is now the deliberate `body: { chars: false }`, while `body: false` means the
  intuitive "never persist a payload".)
- **P17 (the widening clause + R9, 2026-08-04)** — the rule already said every
  consumer-authored duration takes `number | string`, but said it as a property of
  end-user **config**, and nothing enforced it. #609 had just shown what that scope
  reading costs: `SurfaceOutcome.after` was authored by a `Surface` rather than an
  end user, so the 2026-07 sweep skipped it and it shipped taking raw ms — silently
  collapsing a `'700ms'` to a ~0 wait. The clause is now stated over the **value**, not
  the slot, naming all four authoring positions; **R9** gates it. Sweeping the surface
  under the new gate found exactly one live match, the sibling of #609's:
  **`Surface.resumeRetry`** (the server-suggested reconnect backoff a surface reads off
  a `delta`, feeding the identical `sleepWithin` call). **Fixed** — widened to
  `number | string | undefined` and parsed at the engine, verified by reverting the parse
  with the test in place (elapsed 6ms against a 110ms floor). A widening, so non-breaking
  and alias-free in either channel ([P19](#p19--the-alias-obligation-is-scoped-to-the-ga-channel)).
  Everything else the sweep touched was already conformant, and the R9 baseline is
  **zero** — the one match was fixed at the source rather than baselined, the same call
  the P24/R8 addition made.

Everything else this section once listed has **shipped** and moved to the record below —
the cross-package `StitchStore`/`StitchLike`/`RequestSeam` clashes (qualified per-framework
and per-ecosystem), `queryOptions`→`stitchQueryOptions`, `OAuth2Opts`/`CookieSessionOpts`,
the anonymous `paginate` shape, the SSE helper, the error-options types, and
`RedisDriver`'s async `close` (`quit` survives only on the upstream client duck-types,
which [P18](#p18--adapter-mirrors-keep-upstream-spelling-house-contracts-use-house-vocabulary)
keeps at their upstream spelling). A backlog that still advertises finished work reads as a
rule nobody enforces.

The shorthand/toggle slots this section once listed as still-to-add have all shipped:
`.inspect(…, opts?: boolean | AtLeastOne<InspectOptions>)` (P12), `idempotency?: boolean |
AtLeastOne<IdempotencyOptions>` (P13-toggle), and `throttle: '2/s'` folding to
`{ rate: '2/s' }` (P14).

**Shipped** — a historical record. Each bullet describes what its rename did **at the
time**, including any `@deprecated` alias it shipped behind. Those aliases are all gone:
the 2026-07-08 hard-break sweep deleted every prior shim ([D5](#0-resolved-decisions)),
and **R7** now flags a `@deprecated` tag reaching a published surface — which is why the
ratchet's baseline is empty rather than full of them. So where a bullet below says an
alias "stays", or that the runtime "prefers `new ?? old`", read it as that migration's
shape, not as today's surface: nothing on the surface carries an alias.

- **P6** `IdempotencyOptions.key`/`CacheOptions.key`→`keyOf`; runtime prefers `keyOf ?? key`.
- **P3** suffix renames (type-only, zero runtime): `CacheConfig`→`CacheOptions`,
  `OAuth2Opts`→`OAuth2Options`, `CookieSessionOpts`→`CookieSessionOptions`,
  `McpServerInfo`→`McpServerOptions`, `LlmConfig`→`LlmOptions`,
  `SignV4Params`→`SignV4Options`, and the read-back `AuthFailureInfo`→`AuthFailureResult`.
  (`OAuth2Opts`/`CookieSessionOpts` are auth-internal — renamed without an alias.)
- **P4** caps → bare nouns: `ReconnectOptions.maxAttempts`→`attempts`,
  `CacheOptions.maxEntries`→`entries`, `paginate.max`→`pages`; runtime prefers the new
  field. (`CircuitOptions.failureThreshold`→`failures` is deferred to the P17 CircuitOptions
  overhaul, where its required-ness + `cooldownMs`/`halfOpenAfterMs` are handled together.)
- **P7** the exported `StatusMatch` (`number | number[] | (status) => boolean`) is the one shape
  for every status-classification slot: `RetryOptions.on`, `throttle.on`, `VerdictOptions.accept`,
  and the auth strategies' `refreshOn` (oauth2 + cookieSession). A bare status is shorthand for its
  one-element list (`404` ≡ `[404]`); additive widening, no alias. Every reader normalizes through the
  shared `acceptsStatus` matcher, hoisted from the engine into `resilience.ts` so `auth` shares it. The
  `T | T[]` list-widening is uniform too — `DriftOptions.ignore` and `CacheOptions.vary` now accept a
  bare string (`'x'` ≡ `['x']`), matching `DriftOptions.severity`; each consumer normalizes to the array.
- **P14** `rateLimit` folded into `throttle` (`throttle.delegate` / `throttle.on`); the top-level
  `rateLimit` is `@deprecated` (runtime prefers `throttle.* ?? rateLimit.*`). `PaginateOptions`
  extracted from the inline `paginate` shape (named + exported). `throttle: { rate, delegate }` is
  the unified envelope — delegate makes the rate inert, now legible within one object.
- **P17 (inputs)** consumer-authored durations de-suffixed and widened to `number | string` (parsed
  by `parseDuration`): `RetryOptions.baseMs`→`baseDelay`, `maxMs`→`maxDelay`;
  `ReconnectOptions.backoffMs`→`backoff`; `OAuth2Options.refreshSkewMs`→`refreshSkew`;
  `CookieSessionOptions.ttlMs`→`ttl`. Each keeps a `@deprecated` `*Ms` alias (runtime prefers
  `new ?? old`). House store contracts use the bare `ttl` param (ms, no suffix): `StitchStore` /
  `RedisDriver` `set`/`increment` and the redis/deno-kv/cloudflare-kv drivers; `verifyStoreContract`'s
  knob is `ttl` (deprecated `ttlMs` alias).
- **P17 (circuit) + P4** `CircuitOptions` overhaul: `failureThreshold`→`failures` (P4),
  `cooldownMs`→`cooldown`, `halfOpenAfterMs`→`halfOpenAfter` (P17, widened to `number | string`).
  `failures`/`cooldown` become type-optional so the `@deprecated` aliases can stand in;
  `createCircuit` throws if neither spelling is set (required-by-design, P15). The
  `StitchConfig.circuit` slot is `AtLeastOne<CircuitOptions>`, so the empty object is rejected (P20)
  while the breaker stays required-by-design.
- **P17 (emitted: waited/elapsed)** `StitchEvent` `progress.waitedMs`→`waited` and `done.ms`→`elapsed`;
  `Throttle.acquire` now returns `{ waited }`. The engine **co-emits** the `@deprecated` aliases for
  back-compat (the type carries both): `done.ms` as a plain literal, `progress.waitedMs` by assignment
  (a helper, so the literal-`*Ms:` lint R2 stays clean). Every first-party sink (core trace/cli/otlp,
  `@stitchapi/pino`/`sentry`/`fastify`/`nest`) reads the canonical field. Parity tested in
  `contract-event-aliases.spec.ts`.
- **P17 (emitted: retryAfter)** `retryAfterMs`→`retryAfter` on the three read-back surfaces that carry
  a parsed `Retry-After`: `RateLimitError`, `StitchEvent.error`, and `AuthFailureResult`. Each co-sets
  the `@deprecated` alias for back-compat (by assignment, R2-clean); the engine/auth set both. Docs and
  the delegate-backoff / cookie-session tests move to the canonical name (alias parity asserted).
- **P17 (mock fixtures)** `MockResponse.delayMs`→`delay` (widened to `number | string`) and the
  adapter-conformance `FixtureResponse.delayMs`→`delay`; both keep the `@deprecated` `delayMs` alias.
  **Unit hazard:** `MockResponse.retryAfter` is **seconds** (it sets the `Retry-After` wire header), so
  it is renamed to `retryAfterSeconds` (deprecated `retryAfter` alias) — the unit is in the name, per
  P17.
- **P17 (internal `*Ms`)** the remaining internal duration fields are de-suffixed (no public alias —
  none are consumer-authored): the `Throttle.acquire` result `{ waited }`, `TotalBudget.total`,
  `parseRate`'s `{ count, per }`, `StitchStats.avg` (the `stitch summary` mean). `Surface.resumeRetryMs`
  →`resumeRetry` keeps a `@deprecated` alias (a `Surface` is the public extension seam). This completes
  the R2 (`*Ms`) clearance; the remaining baseline is R5 (P9/P16) + R6's P20 slots.
- **P5 (success payload `data`)** `value`→`data` on the runtime result envelopes: `StitchEvent.result`
  and `Inspection`. Both co-set the `@deprecated` `value` alias for back-compat (the engine /
  `makeInspection` set both; the trace JSONL caps both keys so the body never leaks uncapped). Stream
  increments keep `chunk`; the Standard-Schema layer keeps spec `value`/`issues`. Every sink/adapter
  (core trace/cli/serve, `@stitchapi/query-core`, all five TanStack/RTK/SWR readers) and the docs read
  the canonical `data`. (Also folds the cross-package done-event `ms`→`elapsed` fixtures missed when
  P17(c) only typechecked core + four sinks.)
- **P5 (`SchemaFingerprint.value`→`token`)** the fingerprint token is renamed off the overloaded
  `value` (P5 reserves `value` for the success payload); all five vendor fingerprint-\* packages co-set
  the `@deprecated` `value` alias, and both the cache-generation deriver and the `verifyFingerprintContract`
  kit read `token` (normalizing either spelling, preserving the `null` ABSTAIN sentinel via a presence
  check, not `??`).
- **P9 (`StitchStore`) + P16 (`queryOptions`)** — first R5 pair. The per-framework query store is
  framework-qualified (ADR 0012 rule 6): `@stitchapi/solid`'s `StitchStore`→`SolidStitchStore`,
  `@stitchapi/svelte`'s →`SvelteStitchStore` (genuinely incompatible — Solid nests `.state`, Svelte is
  a `Readable` — and both collided with core's state-store `StitchStore`). The ADR 0012
  `stitchQueryOptions` rename now covers vue/solid/svelte/angular (was react-only); the bare
  `queryOptions` survives as a uniform `@deprecated` alias (identity-tested) and is **de-listed from the
  R5 watch-list** since it is no longer a competing canonical.
- **P9 (`StitchError` / `StitchErrorLike`)** — second R5 pair. The host adapters
  (express/fastify/nest/next) mis-named their error **duck-type** `StitchError`, shadowing core's real
  `StitchError` **class**. Renamed to `StitchErrorLike` (`Error & { status? }`), matching elysia/hono —
  so bare `StitchError` is now core-only (R5 clears, watch-list unchanged), and `StitchErrorLike` is one
  structural contract across all six host adapters (de-listed from R5, the `isStitchError` guard stays).
- **P9/P16 (per-request seam)** — third R5 pair. The per-request seam handle is ecosystem-qualified
  per ADR 0012 (extending hono's `HonoRequestSeam`): express `RequestSeam`→`ExpressRequestSeam`, elysia
  →`ElysiaRequestSeam`, fastify `StitchHost`→`FastifyRequestSeam`, nest `StitchHost`→`NestRequestSeam`.
  Each keeps the bare name as a `@deprecated` alias (re-exported with a leading comment in the index
  block, the codebase's established way to keep an alias off R5's name count). Bare `RequestSeam` /
  `StitchHost` are no longer a canonical export anywhere, so both R5 findings clear (watch-list unchanged).
- **P9 (`StitchLike`)** — final R5. It is two deliberate, compatible tiers, not a clash: the canonical
  RICH `(input?) => StitchCallResult<T>` (awaitable + streamable) in `@stitchapi/query-core`, re-exported
  by the five TanStack-family bindings; and an intentional MINIMAL await-only `(input?) => PromiseLike<T>`
  in the three stream-less adapters (swr/rtk-query/vercel-ai), which never call `.stream()`. query-core's
  rich shape is assignable to the minimal one (a real stitch satisfies both), so it is **de-listed**.
  With this, **R5 is fully cleared** — the baseline is now 6, exactly R6's P20 backlog
  (multipart/stream/sse/throttle/hooks/input → `Scalar | AtLeastOne`).
- **P18 (store verbs) + P17 (`ttl`)** the house store contracts speak whole words:
  `RedisDriver.del`→`delete` and `StitchStore`/`RedisDriver` `incr`→**`increment`**, across
  core `memoryStore`/`vaultView`, `@stitchapi/redis` (all three adapters), `@stitchapi/deno-kv`,
  `@stitchapi/cloudflare-kv`, `@stitchapi/react-native` (and `@stitchapi/expo`, which reuses it),
  the `nestBorrowStore` bridge, and `verifyStoreContract`. `ttl` (ms) is now optional on
  **both** verbs — absent means no expiry / no window — so the parameter's optionality no
  longer differs between `set` and `increment`. The upstream mirrors (`IoredisLike`,
  `NodeRedisLike`, `UpstashLike`) keep `del`, and the Lua keeps `INCR`, per P18's first half.
  **No `@deprecated` aliases** — a deliberate hard break on the `rc` channel, where
  [P19](#p19--the-alias-obligation-is-scoped-to-the-ga-channel) does not impose one; and
  both are consumer-implemented contracts, which could not have carried an alias in any
  case. (`deno-kv`'s `maxIncrRetries` is untouched here; it is a P4 `max`-prefix
  violation and renames in that slice.)
- **P4 + P12/P14/P20 (`deno-kv` CAS retries)** `maxIncrRetries` — the last `max`-prefixed
  count cap — becomes `retry?: number | AtLeastOne<DenoKvRetryOptions>`, reusing core's
  `retry` vocabulary for the same concept instead of a second private spelling:
  `attempts` (P4 bare noun, total incl. the first), plus a `backoff` envelope for a curve
  the loop never had (folded to `{ curve, base, max }` in the same sweep as core's). A bare number is the P12 dominant-field shorthand
  (`retry: 20` ≡ `{ attempts: 20 }`), and the object form is `AtLeastOne`, so `{}` is a
  compile error (P20). No `on`: a CAS loop retries exactly one condition. Durations parse
  through core's `parseDuration`, now **exported** so a peer package satisfies P17's "one
  shared parser" instead of mirroring the grammar. Backoff stays **off by default** — the
  hot re-read is today's behaviour and flipping it is a separate call.
- **P24 (backoff envelope) + P2 (`backoff` disambiguated)** `RetryOptions`'
  `backoff`/`baseDelay`/`maxDelay` — three flat members configuring one concept, two of them
  sharing a `Delay` suffix — fold into `backoff?: BackoffCurve | AtLeastOne<BackoffOptions>`
  (`{ curve, base, max }`). A bare curve is the P12 dominant-field shorthand
  (`backoff: 'fixed'` ≡ `{ curve: 'fixed' }`), folded by a **nested** `envelope()` call in
  `expandShorthand` so the string never reaches `__config` (P0); `{}` is a compile error (P20).
  Inside the envelope the bounds need no suffix (P1), and `max` bounds a **magnitude**, the case
  P4 leaves it. In the same pass `ReconnectOptions.backoff` — a flat duration, not a curve —
  becomes **`delay`**, so `backoff` names one concept with one value-space across the surface.
  Genuine breaking flat→envelope, no alias (P19, `rc` channel).
- **P24 (refresh envelope)** the auth strategies' `refresh`-prefixed flat members fold into one
  envelope (genuine breaking flat→envelope, no alias): `OAuth2Options.refreshOn`/`refreshSkew` →
  `refresh?: StatusMatch | AtLeastOne<OAuth2RefreshOptions>` (`{ on, skew }`), and
  `CookieSessionOptions.refreshOn`/`refreshWhen` → `refresh?: StatusMatch | AtLeastOne<CookieSessionRefreshOptions>`
  (`{ on, when }`). A bare `StatusMatch` is the P12 dominant-field shorthand for `{ on }`
  (`refresh: 401` ≡ `refresh: { on: [401] }`); a shared `normalizeRefresh` collapses the union to
  the envelope once at construction, and every internal read goes through `refresh.on` (via the
  shared `acceptsStatus` matcher) / `refresh.skew` / `refresh.when`.
- **P24 (Sentry capture)** `@stitchapi/sentry`'s `SentrySinkOptions.captureErrors`+`captureDrift`
  (shared `capture` prefix) fold into `capture?: boolean | AtLeastOne<SentryCaptureOptions>` —
  `capture: true`/omitted keeps the defaults (errors on, drift off), `false` disables both, and the
  `{ errors, drift }` envelope sets them independently. Genuine breaking flat→envelope, no alias.
- **P24 (nest seam)** `@stitchapi/nest`'s `StitchFeatureOptions` feature-seam facets (the `seam`
  config slot + `seamToken`, sharing the "seam" prefix) fold into
  `seam?: AtLeastOne<NestFeatureSeamOptions>` (`{ config?: AtLeastOne<SeamConfig>, token? }`).
  `forFeature`/`forFeatureScoped` read `seam.config` / `seam.token`. Genuine breaking
  flat→envelope, no alias.
- **P24 (cache transform, 2026-08-04)** `CacheOptions.transformVersion`+`trustTransform` — the two
  ways an opaque `transform` clears [ADR 0004](adr/0004-standard-schema-fingerprint-for-cache-invalidation.md)'s
  rung 2 — fold into `transform?: string | number | AtLeastOne<CacheTransformOptions>`
  (`{ version?, trust? }`). A bare tag is the P12 dominant-field shorthand
  (`transform: 3` ≡ `{ version: 3 }`), folded by `expandShorthand` like the other nested scalars, so
  `__config` only ever carries the object form (P0). The precedence that lived only in the resolver
  — `version` wins, and `trust` is then inert — is now a within-envelope rule. The version tag stays
  under `cache` rather than moving beside the closure it versions because it must round-trip as JSON
  (§1) while `transform` itself is function sugar on `__rawConfig`. Genuine breaking flat→envelope,
  no alias. **R8 never flagged this pair** — see its leading-word gap in §7.
- **P25 envelope test (cache fingerprint, 2026-08-04)** in the same sweep, the **whole ADR 0004
  ladder** moves under one `cache.fingerprint` envelope: `version` (rung 1), the `transform` fold
  above (rung 2), and `onUnfingerprintable` → **`fallback`** (rung 5), typed
  `fingerprint?: string | number | AtLeastOne<CacheFingerprintOptions>`. The licence is P25's — an
  envelope is licensed where it **names an unambiguous subject** — and this passes the same test
  `wire` does: every member is a staleness-detection choice, so the name is exhaustive over its
  contents, while `ttl`/`tenancy`/`vary`/`methods`/`entries`/`coalesce`/`keyOf` answer a different
  question (what the key is, how long an entry lives) and stay outside. It is **not** a P24 fold —
  the four fields never shared a prefix, which is why nothing flagged them.

    `fallback` rather than `onUnfingerprintable`: inside the envelope the subject is named once, so
    the member carries only the dimension (P25's `max`/`chars` idiom), and `on*` is the handler
    convention (carve-out (c)) — a policy string wearing it reads as a callback slot. A bare tag is
    the P12 shorthand at **both** depths (`fingerprint: 3` ≡ `{ version: 3 }`;
    `fingerprint: { transform: 3 }` ≡ `{ transform: { version: 3 } }`) — the only two-level fold on
    the surface, and `NestedEnvelopes` carries it to that depth so a misspelling inside either
    envelope is a compile error. Genuine breaking flat→envelope, no alias.

- **P24 carve-out (b) (endpoint slot, 2026-08-16)** the endpoint spellings — `url` vs
  `baseUrl` + `path` — are one capability wearing two spellings, and they **stay flat**, because
  they do not share a level: `SeamConfig` is `Omit<StitchConfig, 'path' | 'url' | …>`, so `baseUrl`
  is cross-cutting seam vocabulary while `url`/`path` are per-endpoint, and that boundary is a
  declarative one-line `Omit` an envelope would turn into a hand-written nested override on both
  types. A P12 shorthand would also read as two different things
  (`endpoint: 'https://api.example.com'` = the whole URL on a stitch, the base on a seam) — the
  [P2](#p2--dont-reuse-one-word-for-genuinely-different-concepts--rename-one) collision an envelope
  is supposed to avoid, not create. What was **missing** is (b)'s own obligation: the dead
  combinations were representable. `stitch({ url: 'https://a.test/x', baseUrl: 'https://b.test' })`
  typechecked and silently dropped the base — the engine's diagnostic fires only when the JOINED
  result is not absolute, so the absolute-`url` case (a fetchable URL aimed at the wrong host)
  passed with nothing said anywhere. **Fixed** — `OneEndpointSpelling<C>` brands `baseUrl`/`path`
  with a `ConfigError` when `url` sits beside them in the same literal, the mutual-exclusion shape
  R8 already recognises, applied on every surface that authors a stitch (`stitch`, `graphql`,
  `download` and their `Seam` members, both overloads). Additive: no rename, no runtime bytes, and a
  repo-wide sweep found zero existing sites to fix.

    Deliberately **literal-only**, unlike its `AnyLayer`/`Layers` siblings: across fragments the two
    spellings are a supported last-writer-wins override (`stitch.ts`'s endpoint-slot reconcile), and
    a seam supplying `baseUrl` while one member supplies an absolute `url` is the ordinary way to
    point a single endpoint off-origin — a composed read would reject it. **R8 never flagged this
    group**: `url`/`baseUrl`/`path` share no leading-word prefix, the same gap recorded above for
    `total`/`perAttempt` and the cache-transform pair. One consequence is recorded with it:
    `PathVarsOf`'s `path`-wins-over-`url` tie-break reads the literal `C`, so the pairing it
    arbitrates is no longer reachable through any authoring surface — it survives for configs
    arriving by cast or widened fragment, and its assertion moved onto `InputOf` directly
    (`path-vars.test-d.ts` case 8).

- **P20/P12/P13 (empty-object rejection)** the five bare all-optional `StitchConfig` slots R6 flagged
  now type their object form so `{}` is a **compile error**: `hooks?: AtLeastOne<Hooks>` and
  `input?: AtLeastOne<InputSchemas>` (no scalar); `multipart?: MultipartNesting | AtLeastOne<MultipartOptions>`
  and `stream?: StreamDecode | AtLeastOne<StreamOptions>` (P12 dominant-field scalar); and
  `sse?: boolean | AtLeastOne<SseOptions>` (P13 toggle). `expandShorthand` folds each scalar into its
  envelope at compose time (`multipart: 'dot'` → `{ nesting }`, `stream: 'ndjson'` → `{ decode }`,
  `sse: true` → `{ reconnect: true }`; `sse: false` clears the slot), so the engine and `__config`
  only ever see the object form. **R6 clears** — the baseline is now **0**.

## 7. Enforcement

[`scripts/check-contract.mjs`](../scripts/check-contract.mjs) is a **ratchet**, run as
`pnpm check:contract` in `lefthook` (pre-push) and `verify.yml` — the same wiring as
`check:exports` / `check:release`.

- It scans the published packages' public surface and reports contract violations.
- The baseline
  ([`scripts/contract-violations.baseline.json`](../scripts/contract-violations.baseline.json))
  was **zero from the 2026-07-08 sweep**; the same-day P24 addition
  ([§6](#6-migration-record-2026-07-08-hard-break-sweep)) briefly carried one
  pre-existing real match it had not yet fixed, since converted; the 2026-08-04 **R9**
  addition found one more (`Surface.resumeRetry`) and fixed it at the source rather than
  baselining it — the baseline is **zero again**, and the lint fails on **any** new
  violation. Two of the first three rule additions turned up a pre-existing match, which is
  the argument for writing the gate with the rule rather than after it; the third,
  **R10** (2026-08-06), landed **green** — the P4 sweep it gates had already been done by
  hand, so it is a regression guard, not a fix. The ratchet mechanics
  stay (mirroring the repo's ESLint-suppression ratchet) purely as the shrink-only
  guarantee: the surface can only get more consistent, never less.
- Rules implemented (high-precision, source-text level): **R1** banned type-name
  suffix (P3) — input-side `*Opts`/`*Info`/`*Params`/`*Config` **and** produced-side
  `*Return`/`*State`; **R2** any `*Ms`-suffixed duration field, input or emitted
  (P17); **R3** function-typed `key` (P6); **R4** a `scope: 'stitch'|'host'` pool
  overload (P2); **R5** the same identifier exported by ≥2 published packages
  (P9/P16), against an allow-list of the blessed one-declaration-site re-exports and
  identical-by-design host envelopes; **R6** a consumer-input slot — top-level, nested,
  or **inherited** — with an all-optional bag in **any arm** of its union, so `{}`
  type-checks (P20); the bag is resolved across files within a package and against
  core's, through `extends` including a non-exported base, and through **one level** of
  `type` alias (`type X = A | Bag` makes `X` admit `{}`) — one level and against
  interfaces only, so an alias naming another alias does not chain. What it still cannot
  see is a bag reached through an alias in a container **outside** the `*Options` +
  blessed `*Config` family: `MockRoute.respond: MockResponder` resolves the alias now but
  `MockRoute` is not an `*Options`, so it stays under-flagged (#564) — widening that
  filter is the 23-findings/20-noise experiment the family exists to prevent;
  **R7** a `@deprecated` JSDoc **tag** on a published surface (at tag position inside
  a block comment — prose that merely names the marker is documentation, not a shim) —
  the surface is shim-free since the sweep, so a post-GA deprecation alias (mandated by
  P19) enters the baseline **deliberately** for its cycle and is flagged until the
  major removes it;
  **R8** a shared leading-word prefix across ≥2 flat members of the same exported
  interface, not on the curated allow-list of verified foreign-mirror,
  discriminated-union, and P12 dominant-field pairs (P24) — high-precision by
  construction: the conventional `on*`/`is*`/percentile prefixes are structurally
  excluded before grouping, and every remaining match is either fixed at the source
  or gets a one-line-rationale allow-list entry, never silently dropped;
  **R9** a consumer-authored duration or byte size typed `number` with no `string` arm
  (P17/P25), plus the reverse — a `chars` code-unit cap that grew one. Type info is not
  needed because two source-text signals carry it: a **closed, curated member
  vocabulary** (`ttl`, `timeout`, `total`, `each`, `delay`, `cooldown`, `skew`,
  `after`, `base`, `max`, `since`, `interval`, `resumeRetry`)
  and P3's own `*Options` = consumer-input signal, which excludes every produced shape
  **by name** so the emitted complement can never be flagged. A vocabulary rather than a
  name pattern because the one thing that must not be caught is a **count**, and P4
  already guarantees the two never collide: a count is a bare plural, and `max` is
  reserved for a magnitude. The scan additionally covers the consumer-implemented seams
  (`Surface`, `Adapter`, `TraceSink`, `AuthStrategy`), where the authored value is a
  **return** rather than a field — the position the 2026-07 sweep's end-user-config
  checklist missed. Adding a name to the vocabulary is a contract decision; the added
  entry is reviewed like an allow-list entry, in the other direction.
  **R10** the cap vocabulary (P4/D2) — a `max` cap, bare or prefixed, on a consumer-input
  envelope, unless it is on a curated allow-list of **verified magnitude ceilings**
  (`BackoffOptions.max`, `ServeBodyOptions.max`, `ShellBufferOptions.max`, one reason each);
  plus any `*Threshold`, which P4 grants no carve-out. It reuses R6's container filter — the
  same `*Options` + blessed `*Config` family, `*Like` excluded — and that reuse **is** the
  precision guarantee rather than a convenience: P4 itself blesses `max*` on the resolved
  internals, and those sit outside the envelope family by name. Inherited members are scanned
  like R6's, reported once at the declaration site. This is the rule the 2026-07-31 sweep
  wanted and did by hand; measured against history it reproduces that sweep's own list
  (`CacheOptions.maxEntries`, `ReconnectOptions.maxAttempts`, `CircuitOptions.failureThreshold`,
  `DenoKvStoreOptions.maxIncrRetries`, `RetryOptions.maxMs`/`maxDelay`) on the trees that
  carried them, and finds nothing on today's surface.
- Deferred to a type-aware phase (needs the TS checker, not regex): full
  same-name-different-**shape** detection, default-value inversion (P8), and the
  **parse half** of P17/P25 — R9 pins the type, but whether the widened value actually
  reaches `parseDuration`/`parseBytes` before a sleep or comparison is dataflow, and a
  widened type over an unparsed read site is the silent-collapse bug (#609); the parse
  is pinned behaviourally by test instead. Tracked as comments in the lint. R8, R9 and R10
  are also source-text-only in a second sense — they scan exported `interface` bodies,
  not `type`-literal object shapes or class fields, which is why `SurfaceOutcome.after`
  (a union member) sits outside R9's reach; no R8 group was found in either at the
  2026-07-08 audit, but a future one wouldn't be caught until it grows an `interface`.
- **R10 would not have caught its own motivating case, and that is worth writing down.**
  The 2026-07-31 sweep found `LlmOptions.maxTokens` / `LlmRequest.maxTokens` by hand; replayed
  against the trees that carried them, R10 reports neither, for two separate reasons already
  listed above. `LlmOptions` was `type LlmOptions = Partial<Omit<StitchConfig,'kind'>> & { … }`
  — a **`type`-literal**, not an `interface`, so no member rule sees it. `LlmRequest` **is** an
  exported interface but is not `*Options`, so the container filter rejects the container —
  the same blind spot as `MockRoute.respond` (#564 item 2). R10 is therefore a real guard over
  the `interface`-shaped `*Options` surface, which is where P4's whole resolved list lived, and
  **not** a claim that the 2026-07-31 class is now mechanically covered. Closing either half
  is the same decision deferred elsewhere on this page, not an R10 tweak.
- **R8's known gap: the shared subject must lead.** R8 buckets by **leading** word, so a pair that
  names its subject in the **trailing** position never groups. `CacheOptions.transformVersion` +
  `trustTransform` — one capability by any reading, folded 2026-08-04 (§6) — bucketed under
  "transform" and "trust" and survived every audit clean. Grouping by trailing word instead would
  collapse unrelated members (`clientId`/`stitchId`, every `*Options` field) and is exactly the
  guess this ratchet refuses, so the rule stays leading-word and this class is found by **reading**,
  not by lint. When you find one, the fix is the same fold and a §6 entry saying R8 could not see it.

### The unknown-key ratchet

[`scripts/check-unknown-keys.mjs`](../scripts/check-unknown-keys.mjs) is a **second
ratchet** with the same wiring — `pnpm check:unknown-keys`, in `lefthook` (pre-push) and
`verify.yml` — guarding a different failure mode: not what the surface is _named_, but
whether the compiler can see a **misspelling** of it.

An authoring surface that infers `const C` from its option-bag argument gets no
excess-property checking, because the literal is compared against a `C` just inferred from
it — nothing is ever "excess" — and the `C extends …Options` constraint is then verified by
ordinary assignability, which ignores freshness. So `stitch({ path: '/x', timeut: 500 })`
type-checks and the value is silently dropped. That is what makes any slot **rename or
removal** unsafe: every call site still authoring the old spelling keeps compiling. The fix
is to intersect the parameter with `NoUnknownKeys<C, Allowed, What>`, which maps
`Exclude<keyof C, keyof Allowed>` onto a `ConfigError` brand naming the key.

- Every generic-inferred option bag must **either** carry the guard **or** be listed in
  [`scripts/unknown-keys.baseline.json`](../scripts/unknown-keys.baseline.json) with a
  **reason** — a bare `TODO` fails the gate. A new unguarded surface therefore forces a
  deliberate decision rather than passing by omission.
- High-precision, like the rules above: it matches a type-parameter constraint naming a
  `…Config`/`…Options` type or a `Partial<…>` of one, which is what every authored option
  bag here looks like. A generic bound to a _stitch argument_ (`S extends StitchLike<…>`,
  the framework hooks) or to an index-signature bag (`all()`'s named form) is a different
  shape and is not flagged — those hooks' options are separate non-generic parameters and
  keep ordinary excess-property checking.
- One baselined entry is a real instance that **cannot** take the guard: `Stitch.with` is
  the only signature whose return type reads `keyof P`, and intersecting its parameter
  degrades the published `Stitch` type. The reasoning is recorded on the signature and in
  the baseline.
- `test/` and `test-d/` are skipped — they author bad configs on purpose.

**Rule 2 — nested envelopes.** The suppression is **depth-independent**: `const C` is
inferred from the whole config object, so `wire` / `retry` / `circuit` are no more fresh
literals than the root is, and `stitch({ circuit: { failures: 1, cooldown: '30s',
totalNonsense: 1 } })` type-checked silently. This was long believed covered — the type test
pinning it carried **no valid sibling**, so weak-type detection rejected it and the
rejection was misattributed to excess-property checking. `NoUnknownNestedKeys` closes it,
and the second rule keeps its table honest.

- The table (`NestedEnvelopes`, in [`types.ts`](../packages/core/src/types.ts)) is
  **explicit, not derived** — and that is a correctness requirement, not a cost tweak. A
  walk derived from `StitchConfig[K]` would descend into `output`, whose `SchemaLike` Zod
  arm is the phantom `{ _output: unknown }`; a real `z.object(…)` carries dozens of keys
  beyond it, so every schema in every config would fail with `safeParse` reported as a
  misspelling. The same holds for each pluggable seam ([P21](#p21--every-contract-has-an-extension-seam))
  — `adapter` / `store` / `clock` / `trace` / `kind` / `auth` — where an unknown key is the
  extension point. Unknown-key rejection is correct **only** for closed house vocabularies.
- Because a hand-maintained table goes stale by omission, the rule walks **every root bag
  rule 1 found** — `StitchConfig` plus the four that intersect it (`LlmOptions`,
  `RequestOptions`, `EmitOptions`, `EventsOptions`, each of which adds its own fields) — and
  every interface the table already covers, then fails on any field naming a `…Options` /
  `…Schemas` bag (plus `Hooks`) that has no entry, at **any** depth. It currently covers 17
  slots: 13 envelopes plus `wire.multipart`, `retry.backoff`, `stream.buffer`,
  `sse.reconnect`. That second level is not hypothetical: `retry.backoff`'s `baseMs`→`base`
  / `maxMs`→`max` renames in [§6](#6-migration-record-2026-07-08-hard-break-sweep) happened
  there.
- **The class is confined to those root bags, and that was swept rather than assumed.** Every
  other envelope-consuming surface in the repo takes its bag as a _direct annotation_, which
  keeps ordinary excess-property checking at every depth. Verified by probe with a valid
  sibling present (so each rejection is attributable to EPC, not to weak-type detection) on
  `seam`, `serve`, `createTrace`, `mockAdapter`, `oauth2`, `serveStdio`, `deltaFrame`, and —
  outside core — `@stitchapi/shell`'s nested `buffer` envelope. All reject.
- **Measured cost**, on `packages/core`'s 625-call-site typecheck project: +7% types
  (73.5k→78.6k), +12% instantiations (241k→270k), and **no measurable check-time change**
  (~1.1s either way). The docs' twoslash build and every downstream package typecheck
  unchanged; the runtime bundle is untouched. The guard maps over the table's **fixed** key
  set rather than
  `keyof C & keyof NestedEnvelopes`; keying it on `keyof C` makes the parameter type depend
  on the type being inferred, which costs contextual typing for callback slots (`adapter`,
  `transform`) and produces spurious `implicitly has an 'any' type` errors.
- Still **fail-open** for `extends` fragments, at every depth — that is the cross-layer
  (`Layers`) axis, and closing it needs the walk the guard deliberately declines. A
  fragment's own declaration site is where its spelling is checked. The `NoUnknownKeys`
  JSDoc used to claim an _inline_ fragment was covered by excess-property checking; it is
  not, for the same reason the root is not, and that residual limit is now recorded honestly
  there and pinned in `unknown-config-keys.test-d.ts`.

---

## 8. References

- [ADR 0012 — Integration symbol naming](adr/0012-integration-symbol-naming.md) — the
  cross-package symbol rules this contract extends to field/shape level.
- [ADR 0005 — Surfaces and the authoring model](adr/0005-surfaces-and-the-authoring-model.md)
  — Decision 11, the `__config`-round-trips-as-JSON gate (P0).
- [ADR 0002 — Seam primitive](adr/0002-seam-primitive-and-principal-scoped-auth.md) —
  the principal boundary and the `SeamConfig = Omit<StitchConfig>` projection (P16).
- [`packages/core/src/types.ts`](../packages/core/src/types.ts) — the canonical
  `StitchConfig` envelope and result/event shapes.
