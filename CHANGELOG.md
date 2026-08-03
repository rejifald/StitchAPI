# Changelog

All notable changes to the `stitchapi` core library (and the in-repo peer-dep
packages) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Dates are ISO-8601 and derived from the git history; entries without a published
npm release are grouped under the in-development version that introduced them.

## [Unreleased]

### Changed

- **`document` and `operationName` now require the graphql surface at compile time.** Both are
  read only by the graphql surface's `buildRequest`, so authoring either on any other surface
  was silently dead config — the document was dropped and a plain request went out with none of
  it:

    ```ts
    // before: typechecked, and quietly sent {"hello":"world"} with no GraphQL at all
    stitch({
        method: 'POST',
        baseUrl,
        path: '/probe',
        document: 'query Me { me { id } }',
    });
    ```

    It is now a type error naming the offending field. `graphql()` and `Seam.graphql()` are
    unaffected — they select the surface themselves and require `document`. The generic spelling
    still works with the surface named: `stitch({ kind: graphqlSurface, document })`.

    This is CONTRACT.md P24 carve-out (b) applied — a flat group must make its dead combinations
    unrepresentable — using the same `ConfigError` brand as the `wire.multipart` guard, so the
    error names the field instead of collapsing the config to `never`.

    **Known limit,** shared with the `wire.multipart` guard: the check reads the config literal,
    not the composed result, so a surface inherited through `extends` is invisible to it.
    `stitch({ extends: [gqlBase], document })` is rejected even though `gqlBase` supplies `kind`
    — spell the surface on the layer carrying the document, or use `graphql()`. Pinned as a tsd
    expectation so it is a decision on record, not a surprise.

    `graphqlSurface`'s exported type pins `id` to its `'graphql'` literal rather than widening to
    `Surface`'s `string`, which is what makes the surface visible to the guard.

- **BREAKING — every wire-format field moves into one `wire` envelope.** `bodyType`,
  `responseType`, `arrayFormat`, and `multipart` were four flat top-level slots describing one
  category, so they fold into a named envelope (CONTRACT.md P24):

    ```ts
    // before                          // after
    bodyType: 'form',                  wire: { body: 'form' },
    responseType: 'blob',              wire: { response: 'blob' },
    arrayFormat: 'repeat',             wire: { array: 'repeat' },
    bodyType: 'multipart',             wire: { body: 'multipart', multipart: 'dot' },
    multipart: 'dot',
    ```

    The envelope groups by **category**, not by request/response phase — every member is a
    wire-format choice, so the name is exhaustive over its contents. A `request`/`response`
    split could not be: `request` would hold two of the ~15 request-shaping slots while
    `headers`, `method`, and `body` stayed outside. Category grouping is also what lets
    `wire.array` sit truthfully in one place, since it governs the query string **and** a form
    body alike, and no body-scoped container could say that.

    No field dominates, so there is no scalar shorthand — `wire` is always the object form,
    like `input` (P14), and the opaque `wire: {}` is rejected (P20). `wire.multipart` keeps its
    own scalar shorthand one level down: `multipart: 'dot'` ≡ `{ nesting: 'dot' }` (P12).

    `AdapterRequest` is **unchanged** — it keeps flat `bodyType` / `responseType` /
    `arrayFormat` / `multipart`, and the engine converts when it builds the request. That is
    deliberate: `responseType` is the XHR/fetch spelling at the transport boundary, and P22
    says to follow the standard that governs each layer and convert at the edge. Custom
    adapters need no changes.

    **Migration gotcha:** a stale `bodyType:` at a call site does **not** produce a compile
    error — `stitch`'s `const C extends Partial<StitchConfig>` generic captures the argument
    type, which suppresses excess-property checking, so the field is silently ignored and the
    body falls back to JSON. Grep for `bodyType:`, `responseType:`, and `arrayFormat:` rather
    than relying on the typechecker.

- **`wire.multipart` now requires `wire.body: 'multipart'` at compile time.** The slot is read
  only on a multipart body, so pairing it with `'json'`/`'form'` — or with no body encoding at
  all — was silently inert config that typechecked. It is now a type error naming the offending
  field, on `stitch`, `graphql`, `Seam.stitch`, and `Seam.graphql`.

### Fixed

- **A `wire: { body: 'form' }` body no longer mangles nested objects and arrays.** ADR 0005
  Decision 6 named this bug — a nested value becoming `[object Object]` — and fixed it for
  `multipart` via `multipart.nesting`, but the urlencoded `form` arm was left on the broken
  path with no escape hatch: it flattened top-level keys with `String(v)`, so
  `{ page: { size: 10 } }` went on the wire as `page=%5Bobject+Object%5D` and
  `{ ids: [1, 2] }` was comma-joined regardless of the array format.

    Both `application/x-www-form-urlencoded` surfaces — the query string and a form body —
    now run **one** walker, so a single `wire.array` governs both and nesting expands
    `qs`-style on each:

    ```ts
    const search = stitch({
        method: 'POST',
        baseUrl,
        path: '/search',
        wire: { body: 'form' },
    });
    await search({ body: { ids: [1, 2], page: { size: 10 } } });
    // before → ids=1%2C2&page=%5Bobject+Object%5D
    // after  → ids%5B0%5D=1&ids%5B1%5D=2&page%5Bsize%5D=10
    ```

    **Wire-visible for form bodies carrying arrays.** They now default to `'indices'`,
    matching the query string, where previously they were comma-joined. The old behaviour was
    undocumented and untested; set `wire.array` explicitly to pick a different shape. Nested
    objects have no migration concern — `[object Object]` was never usable. A space in a form
    body is still `+`-encoded, and the query string still uses `%20`, exactly as before.

## [1.0.0-rc.7] — 2026-08-01

### Added

- **`parseDuration` is now exported from `stitchapi`.** The one shared duration parser
  (`5_000`, `'5s'`, `'1m'` → ms) that CONTRACT.md P17 requires every consumer-authored
  duration to go through. It was already the parser core used internally; exporting it
  lets a peer package accept `number | string` without mirroring the grammar and drifting
  from it. Additive — nothing else changes.

- **`parseBytes` is exported from `stitchapi`, and byte caps now take a size token.** The size
  analogue of `parseDuration` (CONTRACT.md **P25**): `4096`, `'64kb'`, `'1mb'` → bytes, in
  **powers of 1024** (`'1mb'` = 1_048_576 — the npm-`bytes` convention, and the base the house
  defaults are already written in). `'kib'`/`'mib'`/`'gib'` are accepted spellings of the same
  values; parsing is case-insensitive.

    ```ts
    serve(registry, { body: 4 * 1024 * 1024 }); // a raw byte count
    serve(registry, { body: '4mb' }); // equivalent
    ```

    Every byte cap accepts `number | string`. An unparseable token resolves to `undefined`
    and lands on the field's default cap, so a typo can never widen the bound to "unbounded".

    It does **not** apply to the char-count caps (`stream.buffer.chars`,
    `trace.body.chars`): those count UTF-16 code units of decoded text, where a byte token
    would be a category error — which is why their type has no string arm at all (see the
    size-envelope entry below).

- **`apiKey` takes its secret positionally — `apiKey(env('API_KEY'))`.** Per CONTRACT.md
  P15 the envelope's one required field names its own scalar shorthand, matching
  `bearer`'s positional secret: `apiKey(env('X'))` ≡ `apiKey({ secret: env('X') })`. The
  envelope form remains for `in` / `name` customization.

- **`SecurityScheme`'s oauth2 flow shape is named: `OAuth2ClientCredentialsFlow`** (P14).
  A type-only extraction of the previously anonymous `flows.clientCredentials` object —
  structurally identical, so nothing breaks; the fields keep the OpenAPI/RFC spellings
  (`tokenUrl` / `scopes` / `refreshUrl`, P22). The shape is now importable and extendable.

### Changed

- **BREAKING — the flat size caps are envelopes: `serve`'s `body`, trace's `body`, and
  `stream`'s `buffer`** (CONTRACT.md **P25**, amended). Each names its subject once and
  takes its dominant field's scalar as shorthand (P12):

    ```ts
    // before                                      // after
    serve(registry, { maxBodyBytes: '4mb' });      serve(registry, { body: '4mb' });
    trace: fileSink(path, { maxBodyChars: 4096 })  trace: fileSink(path, { body: 4096 })
    stream: { maxBufferChars: 8_000_000 }          stream: { buffer: 8_000_000 }
    ```

    Byte ceilings are a bare `max` inside their envelope and accept `number | string` size
    tokens; char-count ceilings are `chars` and accept `number` only — the `Bytes`/`Chars`
    distinction the old suffixes spelled is now carried by the field names and enforced by
    the type grammar. The envelope word `buffer` matches `@stitchapi/shell`'s existing
    `buffer` slot (P16). New exported envelopes: `ServeBodyOptions`, `TraceBodyOptions`,
    `StreamBufferOptions`.

    **Watch the trace `false`.** Full capture (no truncation) was the one-word
    `maxBodyChars: false`; it is now the deliberate long spelling
    `body: { chars: false }`. The bare `body: false` means the opposite — never persist a
    payload, keep only the `{ truncated, chars, preview }` marker. The
    `STITCH_TRACE_MAX_BODY` env variable's semantics are unchanged (`full` still means
    full capture). No `@deprecated` aliases (P19, `rc` channel).

- **BREAKING — `apiKey`'s credential field is `secret`, not `value`** (P5). `value` is
  reserved surface-wide for the Standard-Schema success payload — the same overload that
  renamed `SchemaFingerprint.value` to `token` — and `ApiKeyOptions` is inlined into
  `apiKey`'s emitted `.d.ts`, so the field is published surface. OpenAPI's `apiKey`
  security scheme carries no credential field, so no upstream spelling was owed (P22
  covers only `name` / `in`):

    ```ts
    // before
    auth: apiKey({ in: 'query', name: 'api_key', value: env('API_KEY') });
    // after
    auth: apiKey({ in: 'query', name: 'api_key', secret: env('API_KEY') });
    // header default, with the new positional shorthand:
    auth: apiKey(env('API_KEY'));
    ```

    The `stitch gen openapi` and from-curl scaffolders emit the new spelling. No
    `@deprecated` alias (P19, `rc` channel).

- **BREAKING — `stream.maxBufferBytes` never counted bytes; the cap is now the `buffer`
  envelope's `chars`.** Every guard it feeds compares `.length` on a string the `TextDecoder`
  has already produced (`line-reader.ts`, `json-stream.ts`, `sse.ts`), so it measures
  characters of the decoded text — UTF-16 code units — not bytes off the socket:

    ```ts
    // before
    stream: { decode: 'json', maxBufferBytes: 8 * 1024 * 1024 }
    // after
    stream: { decode: 'json', buffer: { chars: 8 * 1024 * 1024 } }
    // or the scalar shorthand for the dominant field:
    stream: { decode: 'json', buffer: 8 * 1024 * 1024 }
    ```

    Default and behaviour are unchanged; the name, its JSDoc, and the thrown error text
    (`… exceeded the stream.buffer.chars cap (…)`) are all that move. The old name mattered
    because it understated the guard it exists to be: 8M code units of CJK is ~24 MB of UTF-8
    on the wire and ~16 MB of string memory, so an OOM bound that read as "8 MB" was 2–3×
    looser than it looked. Per P1, `Bytes` denotes bytes elsewhere on the surface and cannot
    also denote code units — and the new type (`number`, no string arm) makes a `'8mb'` token
    on decoded text a compile error. See the size-envelope entry below for the envelope shape
    shared with `serve` and `trace`.

    No `@deprecated` alias: P19 scopes that obligation to the GA channel and this lands on `rc`.

- **BREAKING — `retry`'s backoff fields fold into one `backoff` envelope.**
  `RetryOptions.backoff` / `baseDelay` / `maxDelay` were three flat members configuring a
  single concept, two of them sharing a `Delay` suffix. They are now one envelope:

    ```ts
    // before
    retry: { attempts: 3, backoff: 'expo', baseDelay: 200, maxDelay: '10s' }
    // after
    retry: { attempts: 3, backoff: { curve: 'expo', base: 200, max: '10s' } }
    ```

    `backoff: 'expo-jitter'` still works — a bare curve is the shorthand for `{ curve }`, so
    the common case is unchanged. Only configs that set `baseDelay` or `maxDelay` need editing:
    move them under `backoff` as `base` / `max`. Inside the envelope the `Delay` suffix is
    redundant — there is only one thing there to measure. `backoff: {}` is a compile error;
    pass a curve, or set at least one bound.

    `@stitchapi/deno-kv`'s `retry.backoff` folds identically in the same release, so the
    store's compare-and-set policy and a stitch's retry policy keep spelling the same
    concept the same way.

- **BREAKING — `sse.reconnect.backoff` is renamed to `delay`.** It is a flat fallback
  duration, while `retry.backoff` is a curve policy — one token meaning two things, and since
  both accept strings, `backoff: 'expo'` and `backoff: '1s'` were indistinguishable by shape.
  `backoff` now means "the curve policy" everywhere; the reconnect fallback is a `delay`:

    ```ts
    sse: { reconnect: { attempts: 5, delay: '1s' } }
    ```

    Behaviour is unchanged — a server-sent `retry:` still wins, and with no `delay` the stitch's
    `retry.backoff` still supplies the wait.

    Neither carries a `@deprecated` alias: P19 scopes that obligation to the GA channel and this
    lands on `rc`.

- **BREAKING — `@stitchapi/deno-kv`'s `maxIncrRetries` becomes `retry`.** The
  compare-and-set budget for `increment` is now `retry?: number | AtLeastOne<DenoKvRetryOptions>`,
  speaking core's `retry` vocabulary rather than a second private spelling. A bare number
  is the attempts shorthand; the envelope adds a backoff curve the loop never had:

    ```ts
    denoKvStore(kv, { retry: 20 }); // ≡ { attempts: 20 }
    denoKvStore(kv, { retry: { attempts: 20, backoff: 'expo-jitter' } });
    ```

    Two things to know when migrating, beyond the rename:

    - **`attempts` counts total attempts, not retries.** `maxIncrRetries: 3` allowed four
      reads (the first plus three retries); `retry: 3` allows three. Add one to preserve the
      old budget exactly. The default moves from `100` retries to `100` attempts — one fewer
      read in the worst case, which no realistic contention notices.
    - **`{}` is a compile error.** The object form is `AtLeastOne<DenoKvRetryOptions>` per
      P20, so `retry: {}` (which reads as a no-op but would silently mean "defaults") is
      rejected; write `retry: 100` for the all-defaults case.

    `backoff` is **off by default**, preserving today's behaviour — the loop re-reads
    immediately on a lost race. Set `'expo'`, `'expo-jitter'` or `'fixed'` — or the
    `{ curve, base, max }` envelope, `base` 5ms and `max` 250ms — when many isolates contend
    on one key. No `@deprecated` alias:
    P19 scopes that obligation to the GA channel and this lands on `rc`.

- **BREAKING — the store contract speaks whole words: `incr` is now `increment`, and
  `RedisDriver.del` is now `delete`.** `StitchStore` — the interface every store
  implements — renames its atomic counter to `increment(key, ttl?)`, and
  `@stitchapi/redis`'s `RedisDriver` follows for both verbs. The house contracts are
  the vocabulary a consumer implements against, not bytes on a socket, so they use
  whole words (CONTRACT.md P18); the Redis **commands** are untouched — the Lua still
  calls `INCR`, and the `IoredisLike`/`NodeRedisLike`/`UpstashLike` mirrors still
  expose `del`, because a mirror keeps its SDK's spelling. Shipped **without
  `@deprecated` aliases** — CONTRACT.md P19 scopes the alias obligation to the GA
  channel, and this lands on `rc`. (They could not have carried one anyway: on an
  interface the consumer implements and core calls, an alias means typing both
  spellings optional forever and letting a store satisfy the type while implementing
  neither verb.)

    _Migration:_ rename the method on any custom store or driver — `incr` → `increment`,
    and on a `RedisDriver`, `del` → `delete`. The bundled stores (`memoryStore`,
    `@stitchapi/redis`, `@stitchapi/deno-kv`, `@stitchapi/cloudflare-kv`,
    `@stitchapi/react-native`, `@stitchapi/expo`) are already updated, so you only act
    if you hand-rolled one. TypeScript names every site.

- **BREAKING — `ttl` is now optional on `increment`.** `StitchStore.increment(key, ttl?)`
  and `RedisDriver.increment(key, ttl?)` match `set`: an absent `ttl` means **no
  window**, so the counter accumulates and never expires. Previously `ttl` was
  required on the counter but optional on `set` — the same parameter with two
  optionalities. Widening, so existing call sites are unaffected; an implementor whose
  signature typed `ttl` as required should relax it and handle the absent case.

- **Docs — every example points at `api.example.com`.** The README, the npm landing page
  and the docs site advertised `demo.stitchapi.dev` as a **live** API across 153
  references. It was not one: DNS resolved to Vercel with no deployment attached, and TLS
  aborted before any response, so every copy-paste quickstart failed with an SSL error.

    Samples now use `api.example.com` — which this repo already used 511 times as its
    illustrative host, so this collapses two hosts into one rather than inventing a third.
    The playground's simulator follows the rename, so the samples stay runnable there;
    point them at your own API to run them anywhere else. No API change.

- **BREAKING — the auth surface moved to the `stitchapi/auth` subpath** (ADR 0021). The
  strategies (`bearer`, `apiKey`, `basic`, `oauth2`, `cookieSession`, …) and their option
  types are no longer on the root barrel, so a project that never authenticates does not
  pay for them in its bundle.

    ```diff
    - import { stitch, bearer } from 'stitchapi';
    + import { stitch } from 'stitchapi';
    + import { bearer } from 'stitchapi/auth';
    ```

- **BREAKING — one word, one concept: five renames** (CONTRACT.md P1/P2). Each token
  denoted two concepts or two value-spaces; the pre-GA window is the only place these are
  free, so they land now rather than costing a deprecation cycle after 1.0.

    ```diff
    - cache: { ttl: '60s', scope: 'app' }          // vs OAuth2Options.scope, the permission string
    + cache: { ttl: '60s', tenancy: 'app' }        // matches OAuth2/CookieSession's tenancy axis

    - validator.source                             // vs Inspection.source, which is provenance
    + validator.schema

    - fingerprinter.supports = '^4'                // vs AdapterCapabilities.supports, a LIST
    + fingerprinter.range = '^4'

    - onProgress: (p) => p.phase === 'upload'      // a direction, not a phase
    + onProgress: (p) => p.direction === 'upload'

    - onAuthFailure: (info) => info.phase          // vs ProgressPhase on StitchEvent
    + onAuthFailure: (info) => info.step
    ```

    `event.phase` on a `progress` event is **unchanged** — `ProgressPhase` keeps the word.

    ⚠️ **`scope` → `tenancy` does not fail to compile.** `AtLeastOne<CacheOptions>` is a
    union of intersections, and TypeScript's excess-property check does not fire through
    it, so a leftover `scope: 'app'` is silently ignored and the entry falls back to
    principal-scoped. Grep for it rather than trusting the build.

- **BREAKING — `llm`'s token cap is `tokens`, not `maxTokens`** (P4: a count cap is a bare
  plural noun). The wire is unchanged — each provider's `buildBody` still emits the
  vendor's `max_tokens`; only the house name moved.

    ```diff
    - llm({ provider: openai, model, maxTokens: 512 })
    + llm({ provider: openai, model, tokens: 512 })
    ```

- **BREAKING — vue's hook result is `VueUseStitchResult`** (P9). React and vue each
  declared an exported `UseStitchResult<T>` with mutually unassignable shapes (raw values
  vs `ComputedRef<…>`). The divergent side is framework-qualified, as with
  `SolidStitchStore` / `SvelteStitchStore`; react keeps the bare name.

- **BREAKING — `stitchapi/mcp`'s `StdioOptions` uses `stdin` / `stdout`** (P2). `input` and
  `output` are the request **schema** slots everywhere else on the surface; here they are
  Node streams. Node and the MCP SDK spell them `stdin`/`stdout`.

    ```diff
    - serveStdio(registry, { input: myReadable, output: myWritable })
    + serveStdio(registry, { stdin: myReadable, stdout: myWritable })
    ```

- **BREAKING — `mockAdapter`'s `respond: {}` is now a compile error** (P20). The opaque
  empty bag silently meant "default 200"; say so instead. A per-call **sequence** entry is
  unaffected — inside an explicit list, a default slot is a positional statement.

    ```diff
    - mockAdapter({ respond: {} })
    + mockAdapter({ respond: { status: 200 } })
    ```

- **BREAKING — solid and svelte no longer accept `streaming`** (P16). Both hard-set it, so
  passing it did nothing; react/vue/angular already `Omit` it. Type-only — the value was
  already ignored at runtime.

- **Fixed — `AtLeastOne<T>` no longer leaks `| undefined`.** The mapped type was
  homomorphic (`[P in K]` over `keyof T`), so it preserved the optionality of every source
  property — and since the envelopes it wraps are all-optional by construction, indexing
  `[K]` yielded `… | undefined`. `{}` was always correctly rejected, so P20 held, but the
  stray `undefined` leaked into every consumer that narrowed one of these unions. Fixed
  with `-?`, at the source, for every slot.

- **BREAKING — `@stitchapi/shell`: positional command, `decode`, and a `buffer` envelope.**
  The one required address goes first, as with `stitch(url)`; the byte cap is an envelope
  with a scalar shorthand taking a raw count or a size token.

    ```diff
    - shell({ command: 'git', env: { PATH } })
    + shell('git', { env: { PATH } })

    - shell(NODE, { decode: 'json', maxBuffer: 4096 })
    + shell(NODE, { decode: 'json', buffer: '4kb' })   // ≡ { buffer: { max: '4kb' } }
    ```

- **BREAKING — the `@deprecated` aliases from the rename waves are gone.** The pre-GA
  window is for alias-free breaks (D5), and every shim shipped during the P3/P4/P17 sweeps
  has been deleted. `R7` now fails the build if a `@deprecated` tag reaches a published
  surface, so the surface stays shim-free.

    ```diff
    - retry: { baseMs: 100, maxMs: 10_000 }       // P17: ms is the house unit
    + retry: { backoff: { base: 100, max: '10s' } }

    - cookieSession({ ttlMs: 60_000 })
    + cookieSession({ ttl: '1m' })

    - circuit: { failureThreshold: 5, cooldownMs: 30_000 }
    + circuit: { failures: 5, cooldown: '30s' }

    - import type { CacheConfig, OAuth2Opts, SignV4Params } from 'stitchapi';
    + import type { CacheOptions, OAuth2Options, SignV4Options } from 'stitchapi';

    - cache: { maxEntries: 500 }                  // P4: a count cap is a bare plural noun
    + cache: { entries: 500 }
    ```

- **BREAKING — top-level `rateLimit` is removed; it is a `throttle` mode.** `delegate` and
  `on` became fields of the one envelope, so "delegate makes the rate inert" is legible
  within a single object instead of a cross-key interaction (P14).

    ```diff
    - rateLimit: { delegate: true, on: [429] }
    + throttle: { delegate: true, on: [429] }
    ```

- **BREAKING — the OTLP trace sink is `otlpSink`, not `otlpTrace`** (P16: every sink is
  `*Sink`).

    ```diff
    - import { otlpTrace } from 'stitchapi';
    + import { otlpSink } from 'stitchapi';
    ```

- **BREAKING — the bare `RequestSeam` alias is gone; the per-request seam is
  ecosystem-qualified** (P9). Six hosts exported one name for six different shapes.

    ```diff
    - import type { RequestSeam } from '@stitchapi/express';
    + import type { ExpressRequestSeam } from '@stitchapi/express';
    ```

    Likewise `ElysiaRequestSeam`, `FastifyRequestSeam`, `NestRequestSeam` — all extending
    hono's `HonoRequestSeam`.

- **BREAKING — `@stitchapi/sentry` folds `captureErrors`/`captureDrift` into one `capture`
  envelope** (P24).

    ```diff
    - sentrySink({ captureErrors: true, captureDrift: false })
    + sentrySink({ capture: { errors: true, drift: false } })
    ```

- **BREAKING — `@stitchapi/elysia`'s plugin option is `onError`, not `errorHandler`.** A
  host adapter's slot for a framework hook takes that framework's word for it (P18):
  Elysia registers via `.onError`, so the option matches. `@stitchapi/fastify` keeps
  `errorHandler` because that is _its_ hook (`setErrorHandler`) — the two differ on
  purpose, and the shape behind both is identical.

    ```diff
    - stitch({ seam, errorHandler: { status: (e) => e.status ?? 502 } })
    + stitch({ seam, onError: { status: (e) => e.status ?? 502 } })
    ```

## [1.0.0-rc.6] — 2026-07-23

### Changed

- **BREAKING — the `unwrap` config key is renamed to `pick`.** The response-shaping
  key that pulls a nested payload out of an envelope (`{ data: … }` → the value it
  wraps) is now spelled `pick`, the verb the guides already used for it, leaving
  `unwrap` to mean only the throwing call twin (`stitch.unwrap()`). Rename
  `unwrap: '<path>'` to `pick: '<path>'` in every stitch config — there is no
  deprecated alias. (#481)

- **BREAKING — `@stitchapi/next`'s `stitchErrorResponse` now returns
  `Response | undefined`.** It returns `undefined` for anything that is not a
  `StitchError` (previously it always produced a `Response`), so it composes inside
  a `catch` that must also rethrow non-stitch failures untouched:

    ```ts
    const mapped = stitchErrorResponse(err); // default status 502
    if (mapped) return mapped; // undefined → not a StitchError
    throw err;
    ```

    Callers that assumed a non-null `Response` must handle the `undefined` branch. (#475)

### Added

- **`throttle` string shorthand.** `throttle: '1/s'` is now accepted as shorthand for
  `throttle: { rate: '1/s' }`, matching the ergonomics of the other rate-shaped
  options. The object form is unchanged and is still required when you also set a
  `pool` (or any other throttle field). (#480)

## [1.0.0-rc.5] — 2026-07-08

### Changed

- **BREAKING — run-identity fields renamed to the OpenTelemetry names.** The
  `RunContext` struct and the `start` event now carry **`spanId`** and
  **`parentSpanId`** instead of `runId` and `parentId` (`traceId` is unchanged).
  The names now match what the OTLP exporter already emits, so the mapping is an
  identity and there is no translation seam. Custom trace sinks reading
  `ctx.runId` / `ctx.parentId` (or `event.runId` / `event.parentId`) must read
  `ctx.spanId` / `ctx.parentSpanId`. The `@stitchapi/sentry` integration now
  reports the failing run's id under a `spanId` tag. See
  [ADR 0017 Decision 7](docs/adr/0017-outbound-trace-context-propagation.md) and
  the new `concepts/run-identity` page.

### Added

- **Idempotency misuse nudges.** A stitch now logs a one-time construction
  warning when `idempotency` is set on a read (the key is sent on writes only —
  almost always a missing `method: 'POST'`) or with the random default key and no
  `retry` (it only dedupes the call's own retries). Both are respectful hints with
  an out — set `idempotency: { warn: false }` to silence them — and fire only on
  the default HTTP surface. New `IdempotencyOptions.warn` field.

- **`@stitchapi/docs-mcp` — local/offline docs search over MCP stdio.** The
  offline counterpart to the hosted `stitchapi.dev/api/mcp` server: the same
  `search_docs`/`get_doc` tools, with the docs corpus and embedding index bundled
  at build time so there is no per-query network call. For air-gapped or
  strict-egress environments.

## [1.0.0-rc.4] — 2026-06-29

### Added

- **GraphQL `operationName`.** The `graphql` surface now sends `operationName`
  alongside `{ query, variables }`, derived from the first named operation in
  the document (anonymous documents omit it, matching `graphql-request`). A new
  `operationName` config key overrides the derived value for multi-operation
  documents, or suppresses the field entirely with `''`. This restores parity
  with conventional GraphQL clients so servers, logs, APM, and request mocks
  that key on the operation name see it again.

## [1.0.0-rc.3] — 2026-06-21

### Added — the integration ecosystem

The first wave of `@stitchapi/*` ecosystem adapters — a stitch now drops into the
framework, runtime, and store you already use, each a thin typed seam over the
same core runtime (no new concepts; streaming-first where it applies):

- **Server frameworks:** `@stitchapi/elysia`, `@stitchapi/express`,
  `@stitchapi/fastify`, `@stitchapi/hono`, and `@stitchapi/next` — a
  request-scoped seam on the context/`req`, an SSE bridge for a streaming
  stitch, and `StitchError`→HTTP mapping. The Fetch-only adapters (`hono`,
  `elysia`, `next`) stay edge/multi-runtime safe.
- **Client & UI bindings:** `@stitchapi/react`, `@stitchapi/vue`,
  `@stitchapi/svelte`, `@stitchapi/solid`, and `@stitchapi/angular` —
  tearing-free `useStitch`/`useStitchStream` (and the framework-native
  equivalents) that re-render as `delta` chunks arrive, over the new shared
  `@stitchapi/query-core` reactive store, plus an optional TanStack Query
  `queryOptions` helper. `@stitchapi/react-native` adds the streaming XHR
  transport bare RN lacks and an AsyncStorage `StitchStore`, and
  `@stitchapi/expo` layers `expo/fetch` streaming and a secure-store token
  store on top.
- **Data-fetching libraries:** `@stitchapi/swr` (`useStitchSWR`) and
  `@stitchapi/rtk-query` (`stitchQueryFn` + `stitchStreamUpdater`) hand
  caching/revalidation to the host library while the stitch stays typed,
  validated, and traced.
- **State stores:** `@stitchapi/cloudflare-kv` (Workers KV) and
  `@stitchapi/deno-kv` (atomic `incr` for distributed throttle) join
  `@stitchapi/redis` as edge-/runtime-native `StitchStore` backends.
- **Auth:** `@stitchapi/aws-sigv4` — an `AuthStrategy` that signs each request
  with AWS SigV4 over edge-safe Web Crypto (AWS APIs, S3-compatible stores, any
  SigV4-protected endpoint).
- **Observability:** `@stitchapi/pino` and `@stitchapi/sentry` `TraceSink`s map
  the stitch event stream to structured logs and breadcrumbs/error capture —
  metadata-only, safe on a secret-bearing seam.
- **AI:** `@stitchapi/vercel-ai` exposes a stitch as a Vercel AI SDK `tool()`
  the model can call — it gets validated data, never the credential.

Each ships `publishConfig.access: public`, a README, and a LICENSE. A new package's
first publish is a one-time bootstrap (OIDC cannot publish a brand-new name); it
rides the OIDC publish workflow thereafter — see [`docs/RELEASING.md`](docs/RELEASING.md).

### Added — a published testing story

- **Mocking kit on `stitchapi/testing`:** helpers for testing your own stitches
  and the code that calls them, alongside the existing vendor conformance kit.
  `mockAdapter(routes)` injects a fake transport — status sequences (retry),
  abortable latency (timeouts), function responders (pagination), streaming
  bodies, and a request spy (`calls`/`callCount`/`lastRequest`) — so the real
  runtime runs against canned responses with no global-`fetch` monkeypatching.
  `stubStitch` / `failStitch` stand in for a real stitch when unit-testing
  calling code (a conformant `Stitch` with a call spy; pairs with a Nest
  `overrideProvider`). `streamOf` / `sseStream` / `streamThenError` /
  `gatedStream` / `streamAdapter` build streaming bodies, and
  `collectStitchEvents` drains a `.stream()` into its parts. Browser-safe.
  (GAP-AUDIT §2.9)
- **Injectable `Clock` (ADR 0010):** a stitch/seam `clock` makes retry backoff,
  throttle pacing, the per-attempt timeout, and circuit cooldown deterministic.
  Defaults to `systemClock` (no behaviour change); inject `manualClock()` from
  `stitchapi/testing` and drive time with `advance(ms)` — no real waiting, no
  fake-timer library. `Clock` + `systemClock` are exported from the main entry.
  (`timeout.total` and event timestamps stay on wall-clock.)

## [1.0.0-rc.2] — 2026-06-18

A pipeline release — **no library changes**. `1.0.0-rc.1` was bootstrapped with a
hand-run publish; `rc.2` is the first version published automatically through the
**OIDC trusted-publishing** workflow, so every tarball now carries a signed npm
**build-provenance** attestation. The library code is identical to `rc.1`.

## [1.0.0-rc.1] — 2026-06-18

The first **v1.0 release candidate** — the library, the interactive playground, and
the docs site as one public moment. It bundles the whole post-`0.7.0` cycle (the
former in-development `0.8.0` work plus the playground and docs reconciliation) into
the first published `1.0` line, and ships the `@stitchapi/*` companions (`nest`,
`redis`, `shell`, `fingerprint-*`) for the first time. Published under the `rc`
dist-tag — `latest` stays on `0.7.0` until `1.0.0` is promoted. See
[`docs/RELEASE.md`](docs/RELEASE.md) for the checklist.

### Added — agent adoption, streaming completion & release tooling

- **Agent-recommendation surfaces:** a `describe_stitch` MCP teaching tool,
  teaching-grade validation errors, an npm discovery signal, zod-default docs, an
  `llms.txt`, and **`stitch init`** (alias `stitch rules`) — which writes the
  canonical consumer rule ("declare a typed stitch, don't hand-roll `fetch`/`axios`")
  into the files an AI coding agent reads (`--format agents|cursor|claude|all`,
  default `all`: `AGENTS.md`, a Cursor `.cursor/rules/stitchapi.mdc`, and a marked,
  idempotent `## Using StitchAPI` section in `CLAUDE.md`; `--force` rewrites). (#175)
- **Resumable SSE:** an `sse()` stitch reconnects on `Last-Event-ID`, honoring the
  server's `retry:` backoff hint. (#180)
- **Structural streaming-JSON decoder (`decode: 'json'`):** decode an unframed JSON
  stream into typed `delta`s without SSE framing. (#179)
- **Compile-time typed `delta`:** the streamed `delta` element type is inferred from
  the `output` schema. (#178, #115)
- **Bundle-size budget gate:** a tree-shaken min+gzip budget enforced in CI
  (`pnpm size` / `check:size`), with the zero-deps/size numbers advertised across the
  READMEs and docs. (#170, #176)

### Security

- Eliminated 6 polynomial-ReDoS ("super-linear runtime") code-scanning alerts by
  rewriting the affected parsers to linear-time matching. (#177)

### CI / release hardening

- The npm publish workflow now waits on the real-browser Playwright e2e suite (sandbox
  CSP + Worker egress + trace→DAG) before publishing. (#171)
- Unbroke the frozen-lockfile install (an `esbuild` override floor drifted the
  lockfile) and added a lockfile-drift gate. (#172)
- A hermetic MCP-subprocess e2e exercises `run_stitch` round-trips over stdio. (#174)
- `check:release` now also asserts every publishable package ships a `LICENSE` and a
  `README.md`.

### Added — playground & release hygiene

- Playground: the trace DAG is back, rendered as a Mermaid SVG wired to real
  ADR 0007/0008 causality (dependency edges from `dependsOn`/`parentId`, retry and
  page annotations, shell `$ command` labels).
- `CHANGELOG.md` and a runnable, offline `examples/` demo (a typed `stitch` with an
  `output` schema, run against an injected mock adapter).
- `@stitchapi/sandbox-sim` now has a `test` script, so `pnpm -r test` covers its
  simulator suites.
- Release guardrails (`pnpm check:release`): version lockstep across the publishable
  packages, prerelease-aware peer-range checks, scoped `publishConfig.access`,
  dist-tag safety (a prerelease never lands on `latest`), and a CHANGELOG entry —
  enforced in the verify + publish workflows and each package's `prepublishOnly`.

### Changed

- Documentation reconciled with the shipped reality (READMEs and the docs
  banner flipped to an honest release-candidate (`1.0.0-rc.1`) framing —
  feature-complete and in real use, candid that stable 1.0 isn't stamped yet;
  ADRs 0002 / 0005 / 0006 / 0007 promoted from
  _Proposed_ to _Accepted_; OVERVIEW and RELEASE counts and status refreshed). (#173)

### Notes

- Deferred to v1.1 (non-blocking): pagination presets (`cursor()` / `offset()` /
  `linkHeader()`) with async iterators, and a published record/replay mock adapter.

### Added — library (the former in-development `0.8.0`)

The non-HTTP surfaces, composition causality, and the OpenAPI export, on top of the
surfaces and authoring model that landed earlier in the cycle:

- **Non-HTTP surfaces (ADR 0008):** `llm` and `shell` as symmetric kinds, plus the
  `pipe()` primitive to compose heterogeneous stitches into one chain. A shell
  stitch maps a non-zero exit to `status >= 400`; an `llm` stitch carries a chat
  request. `pipe()`'s trace is a step→step chain under one run identity. (#165)
- **Composition causality (ADR 0007):** a run-identity OTLP span tree
  (`runId` / `traceId` / `parentId`). A retry attempt and a page are each child
  spans with their own start/end/latency/outcome; a coalescing follower is neither;
  streaming `delta`s are values within the run span. (#163)
- **Response streaming surfaces (ADR 0005, stages 5–7):** `sse()` and `stream()`
  surfaces with per-`delta` `output` validation; the fetch adapter hands back the
  live `ReadableStream`; the engine emits a `delta` per chunk; `stitch serve`
  forwards deltas over SSE. The `xhr` and `axios` adapters reject streaming by
  design. A buffered binary `download` surface returns `{ blob, filename }`.
  Every surface and the `xhr` adapter became a subpath export. (#99, #100, #101, #118)
- **`stitch export --openapi`:** emit an OpenAPI 3.1 spec from the registry
  (paths/methods, RFC 6570 path & query params, body/response presence), with real
  body schemas via a bring-your-own `toJsonSchema` converter (`--schema-module`). (#126)
- **`stitch diagram`:** render a Mermaid flowchart of a stitch's pipeline. (#128)
- **`stitch drift generate`:** write snapshot baselines deliberately; drift
  `readonly` mode detects without writing. (#132, #140, #160)
- **Auth:** OAuth2 `client_credentials` (token endpoint, cached access token,
  single-flight refresh, opt-in per-principal tenancy); `apiKey({ in: 'query' })`
  placement; `cookieSession` lifecycle hooks (`onAuthFailure` / `onRefresh`);
  optional credentials via `bearer(optionalEnv())` with info events; a
  `secretFrom()` resolver, and `env()` now rejects empty values. (#129, #139, #151, #153)
- **Engine / adapter:** `acceptStatus` (treat non-2xx as a result) and a richer
  `StitchError` carrying `{ body, url }`; `safe()` / `unwrap()` call variants;
  a delegate-backoff rate-limit mode that surfaces `429` / `Retry-After` instead of
  retrying internally; per-stitch undici dispatcher/`Agent` passthrough in the
  fetch adapter. (#144, #150, #154, #158)
- **Type inference:** call-argument types now infer across `extends` fragments,
  from RFC 6570 path-template vars, and from a GraphQL `input.variables` schema. (#114, #117, #122)
- **`@stitchapi/redis`:** a Redis-backed `StitchStore` (`get`/`set`/`incr`/`close`)
  with `fromIoredis` + `fromNodeRedis` driver adapters and even-spaced distributed
  throttling, passing the store conformance kit. (#119)
- **`@stitchapi/nest`:** first-class NestJS integration (ADR 0006) — `seam` as a DI
  primitive, a logger sink bridged to Nest's `Logger`, optional injection tokens,
  an exception filter, SSE, and multi-tenant scoping. (#103, #130)
- **Logger-agnostic `loggerSink(logger, opts?)`** with per-instance `level` and
  `format` hooks. (#143)

### Changed — library

- `StitchResult` exposes `.catch` / `.finally` and runs exactly once. (#141)
- The call argument accepts `params` / `query` when a sibling slot is declared. (#142)

### Removed / Breaking

- **`seam` is the multi-endpoint primitive (ADR 0002):** `defineStitch`, `preset`,
  and `keychain` were removed in favor of `seam` + principal-scoped auth; the
  principal boundary was hardened and `SeamConfig` narrowed. (#66, #92)
- The fluent `Builder` was removed; authoring standardizes on the config-object
  model. (#90)

## [0.7.0] and earlier

Foundational work that established the runtime before the 0.8.0 surface and
causality push:

- **Surfaces & authoring model (ADR 0005, stages 0–4):** a pluggable Surface plugin
  model replacing the closed `kind` union; nested multipart; the streaming-body +
  `onProgress` adapter contract; GraphQL reimplemented as a surface. (#89, #93, #96, #97, #98)
- **Response cache (ADR 0003) + Standard-Schema fingerprint (ADR 0004):** a
  derived-key response cache with in-process request coalescing, with the schema
  fingerprint folded into the cache generation for zero-revalidation. (#74, #80, #81, #85)
- **End-to-end type inference:** `Stitch<T>` from the `output` schema and
  call-argument types from `config.input`. (#72, #77)
- **No side effects by default:** tracing (console / JSONL / OTLP) is off until
  opted in, with safe-by-default sink hardening (header denylist, URL credential
  scrub, body/result truncation). (#58)
- **Engine foundations:** RFC 6570 Level-4 templates, nested query encoding,
  pluggable HTTP adapters, and `url` as an atomic alternative to `baseUrl`/`path`. (#35, #46)
- **Conformance kit:** store / adapter / sink conformance contracts under
  `stitchapi/testing`. (#50, #59)
- **Playground:** the browser Worker runner, handler registration, incremental
  streaming, and the trace → Mermaid DAG wiring.

[Unreleased]: https://github.com/rejifald/StitchAPI/compare/v1.0.0-rc.7...HEAD
[1.0.0-rc.7]: https://github.com/rejifald/StitchAPI/compare/v1.0.0-rc.6...v1.0.0-rc.7
[1.0.0-rc.6]: https://github.com/rejifald/StitchAPI/compare/v1.0.0-rc.5...v1.0.0-rc.6
[1.0.0-rc.5]: https://github.com/rejifald/StitchAPI/compare/v1.0.0-rc.4...v1.0.0-rc.5
[1.0.0-rc.4]: https://github.com/rejifald/StitchAPI/compare/v1.0.0-rc.3...v1.0.0-rc.4
[1.0.0-rc.3]: https://github.com/rejifald/StitchAPI/compare/v1.0.0-rc.2...v1.0.0-rc.3
[1.0.0-rc.2]: https://github.com/rejifald/StitchAPI/compare/v1.0.0-rc.1...v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/rejifald/StitchAPI/compare/v0.7.0...v1.0.0-rc.1
