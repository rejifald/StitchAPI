# Changelog

All notable changes to the `stitchapi` core library (and the in-repo peer-dep
packages) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Dates are ISO-8601 and derived from the git history; entries without a published
npm release are grouped under the in-development version that introduced them.

## [Unreleased]

### Added

- **`@stitchapi/download` — a batch downloader over the stitch resilience chain.** `downloadAll`
  for a fire-and-collect batch, `DownloadManager` for a live queue: FIFO admission, a `concurrency`
  ceiling, per-item settling so one failure never sinks the batch, cancel (one / queued / all),
  aggregate progress with an ETA, an `idle` timeout that fails a stalled transfer instead of waiting
  on it, and request dedupe so the same URL in flight twice is fetched once. Zero runtime
  dependencies and its own size gate. Every item is an ordinary stitch, so `retry`, `throttle`,
  `timeout` and tracing apply unchanged.

- **`QUERY` is a first-class method — a read that carries a request body.**
  ([draft-ietf-httpbis-safe-method-w-body](https://datatracker.ietf.org/doc/draft-ietf-httpbis-safe-method-w-body/))
  `method: 'QUERY'` already sent its body and already cached correctly under
  `cache: { methods: 'QUERY' }`, because the cache key folds the body in. What it did **not** have
  was the engine's agreement that it is a read: "safe method" was spelled `=== 'GET' || === 'HEAD'`
  inline, so everything else was a write by default.

    One `isSafeMethod` predicate now answers that question in the two places that ask it — RFC 9110
    §9.2.1's safe set (`GET`, `HEAD`, `OPTIONS`, `TRACE`) plus `QUERY`:

    - **No `Idempotency-Key` on a safe method.** A stitch with `idempotency` configured no longer
      stamps a dedupe token on a `QUERY` — there is no side effect to collapse, and the header would
      have varied the cache key on every send. `OPTIONS`/`TRACE` stop being stamped too; they were
      only ever getting a key because they were not `GET` or `HEAD`.
    - **The construction nudge follows.** Declaring `idempotency` on a `QUERY` now logs the same
      "the key is sent on writes only" hint a `GET` gets, so the drop is never silent. Silenced by
      `idempotency.warn = false` as before.

    **A 301/302 no longer downgrades a `QUERY` to a bodyless `GET`** (default `fetch` transport).
    That downgrade is a historical exception granted to `POST`, and the draft rules it out by name
    for `QUERY`; applying it dropped the body, which silently turned a filtered read into an
    unfiltered one. `303` still redirects to a `GET` — for a `QUERY` that is what it means. `POST`,
    `PUT`, `PATCH` and `DELETE` redirect exactly as before.

    **Three method tests, not one.** `encodeRequestBody` still drops a body on `GET`/`HEAD` **only**
    and is deliberately not routed through the safety predicate: that branch enforces a transport
    constraint (`fetch` throws on a `GET` with a body), and widening it to "safe" would have deleted
    the payload of every `QUERY` — the one thing that already worked. The cacheable-method default
    is likewise untouched at `['GET','HEAD']`; `QUERY` is now documented as a valid `cache.methods`
    entry, opt-in like a GraphQL `POST`.

- **`makeLlmSurface` is exported from `stitchapi/llm`**, with its `LlmDefaults` argument. ([#699](https://github.com/rejifald/StitchAPI/issues/699))
  The exported `llmSurface` is only the `{ id: 'llm' }` identity — nothing to wrap — and the real
  factory, which closes over the provider and defaults, had no `export`, so layering behaviour over
  the llm surface ([P21](docs/CONTRACT.md#p21--every-contract-has-an-extension-seam)) meant forking core.

- **`throttle.concurrency` goes fleet-wide too, by lease.** ([ADR 0025](docs/adr/0025-fleet-wide-concurrency-by-lease.md))
  [ADR 0024](docs/adr/0024-the-fleet-wide-pacing-cell.md) made the rate budget fleet-wide and left
  the concurrency cap per-process, so `concurrency: 10` across eight workers was really a fleet cap
  of eighty — "attach a store to share the policy" was true of one of the two limits. With a store
  that leases, `concurrency: 10` now means ten calls in flight across every worker on it. Nothing
  to configure; the throttle uses the verbs when the store has them.

    **Why a counter could not do it.** A rate is a schedule — a function of time, which is why one
    shared cursor settled it. A concurrency slot is _ownership_: held for an unknown interval, by a
    specific holder, freed by news rather than by a clock. A holder that crashes never decrements, so
    a shared counter decays monotonically toward zero — a limiter that gets stricter every time
    something breaks, silently. A lease returns the slot when its holder stops renewing, alive or not.

    `StitchStore` gains a paired pair of optional verbs, implemented by `memoryStore`,
    `@stitchapi/redis` (a sorted set) and `@stitchapi/deno-kv` (compare-and-set):

    ```ts
    lease ? (key, token, limit, ttl, now) : Promise<boolean>; // take, renew, or refuse
    release ? (key, token) : Promise<void>; // idempotent
    ```

    The caller mints the token, so `lease` doubles as renewal and is idempotent — a retry extends
    a slot rather than silently consuming a second one. **Existing custom stores need no changes**;
    without the pair, `concurrency` stays per-process exactly as before, which is the path an
    eventually-consistent backend (`@stitchapi/cloudflare-kv`) takes, and which stays pinned in the
    test suite against a store with the verbs deliberately withheld.

    **One new knob, `throttle.lease`** (default 30s, `number | string`): how long a slot is held
    before it lapses. Think crash timer, not call timer. Too long strands a dead worker's slots; too
    short and a call still running has already lost its slot, so the fleet briefly exceeds the cap.
    Streaming holds no slot at all ([ADR 0005](docs/adr/0005-surfaces-and-the-authoring-model.md)
    Decision 12), so a `lease` above `timeout.total` cannot be outlived.

    **Two behaviours differ from the in-process limiter, inherently.** A blocked caller **polls**
    with full jitter instead of being handed the slot — no worker can be woken by another worker's
    release — so strict FIFO fairness is gone and contention costs store round-trips. And a release
    is fire-and-forget: a lost one costs the fleet a slot for at most `lease`, the same guarantee
    that already covers a crash, so awaiting it would buy promptness rather than correctness.

- **A fleet sharing a store now paces on ONE schedule, wherever in a window its workers start.**
  ([ADR 0024](docs/adr/0024-the-fleet-wide-pacing-cell.md)) [ADR 0023](docs/adr/0023-a-rate-is-a-minimum-spacing.md)
  fixed the store-backed throttle's cold-start burst with a per-process pacing cursor and recorded
  what that could not buy: a slot already in the past paces nobody, so N workers that all start
  mid-window emit at **N× the declared rate** until the slots catch up with the clock. Two workers
  measured 2×, three measured 3×.

    The reason a counter could never close it is worth stating, because it looks like it should:
    a counter allocates _positions_, and turning a position into a _time_ needs an origin. Every
    origin a caller can compute is either per-process (so each worker paces only itself) or fixed to
    a window (so a worker joining mid-window inherits slots that already elapsed). Both were tried,
    in that order, and each fix exposed the other.

    A **cursor** needs no origin — it is already an instant, it carries continuously, and
    `max(now, cell)` resets it after idle. So `StitchStore` gains one optional verb:

    ```ts
    reserve?(key: string, spacing: number, now: number, ttl?: number): Promise<number>;
    // atomically: at = max(now, cell ?? 0);  cell = at + spacing;  return at
    ```

    Implemented by `memoryStore` (the default), `@stitchapi/redis` (one Lua `EVAL`) and
    `@stitchapi/deno-kv` (its existing compare-and-set loop). **Nothing to configure** — the throttle
    uses the cell when the store has it.

    **Optional on purpose, and the fallback is not deprecated.** `@stitchapi/cloudflare-kv` is
    eventually consistent and has no atomic read-compute-write to build a cell from, so it keeps the
    ADR 0023 path — whose residues stay pinned in the test suite against a store with the verb
    deliberately withheld. `StitchStore` is also a contract _you_ implement, where adding a required
    member is a hard break in any channel
    ([P19](docs/CONTRACT.md#p19--the-alias-obligation-is-scoped-to-the-ga-channel)), so optional is
    the only additive shape. **Existing custom stores need no changes.**

    If you do implement it, `conformance.store` now checks it — but only when present, so
    omitting it is not a contract failure. The rule that matters is the atomicity one: 20 concurrent
    reservations must come back as 20 distinct, evenly spaced instants, because a non-atomic cell
    hands several callers the same instant, which is the exact burst the verb exists to remove.

- **`throttle.rate`'s denominator is now a full duration token — `'1000/h'`, `'100/15m'`,
  `'2/500ms'`.** ([ADR 0023](docs/adr/0023-a-rate-is-a-minimum-spacing.md)
  Decision 3) The grammar is `<count>/<duration>`, where the denominator is parsed by the one
  shared `parseDuration` and a bare unit means one of that unit (`'2/s'` ≡ `'2/1s'`). Every
  existing rate keeps parsing to exactly what it did — the new grammar is a strict superset.

    The old `<count>/<ms|s|m>` was a hand-copied subset of `parseDuration`'s scale table, and the
    truncation left **holes in the value space**: an ordinary 1000/hour quota is a 3600ms spacing,
    and no legal token denoted it (`60000/count = 3600` needs a fractional count, and counts are
    integers). The nearest spellings were `'16/m'` — 960/h, abandoning 4% of the quota — and
    `'17/m'` — 1020/h, i.e. the 429s the throttle was added to prevent. `'100/15m'` was in a hole
    too. You can now transcribe the limit your vendor publishes instead of converting it to a
    number the grammar can hold.

    **Equal ratios are one limiter, and that is the design:** `'2/500ms'`, `'4/s'` and `'240/m'`
    all declare a 250ms gap and behave identically, in-process and store-backed alike. `rate` is a
    pacer, not a token bucket — there is no capacity for a longer window to grant — so the window
    length is a way of spelling the ratio, not a burst allowance. Pinned across three window
    lengths in `store.spec.ts` rather than left as a doc sentence.

    Two values are rejected that the widening would otherwise have admitted, both for the reason
    `'0/s'` was rejected below — each would have meant _no limit at all_: a **non-positive window**
    (`'2/0s'`, `'2/-500'` — `parseDuration` returns those as a real `0` / `-500`, not `undefined`,
    so `spacing` would land at ≤ 0, which both limiters read as "no pacing configured"), and a
    **spacing past the ~24.8-day timer ceiling** (`'1/30d'` — `setTimeout` clamps any delay past
    2³¹−1 to 1ms). The ceiling rejects rather than clamps: clamping would silently pace _faster_
    than asked.

    `ThrottleOptions.rate` also gained TSDoc, so it stops rendering with a blank description on the
    reference page.

- **`parseRate` is exported from `stitchapi`, completing the house token grammars.**
  [P17](docs/CONTRACT.md#p17--one-canonical-duration-form) and
  [P25](docs/CONTRACT.md#p25--one-canonical-size-form) both make "one shared parser" part of the
  rule, and P25 spells out why it is public: so a peer package parses the grammar instead of
  mirroring it and drifting from it. `parseDuration` and `parseBytes` were already exported on that
  argument; `parseRate` — `'2/s'`, `'10/m'` → `{ count, per }` — was the third grammar and was
  module-private, so a peer building a distributed limiter had to re-derive it. All three are now
  pinned by the public-surface test, which held none of them before.

    Its JSDoc now also states the two things about a rate that were previously unwritten. It is a
    **string and only a string** — no `number | string` widening — because a rate is two quantities
    rather than a magnitude over a house unit, so a bare `2` would have to invent a default window to
    denote anything, and that invisible default is what P15/P20 exist to reject. And it **throws** on
    a bad token where the other two fall back to the field's default: for a cap the fallback is the
    safe failure, but `undefined` for a rate means _no limit at all_, so falling back would let a typo
    silently remove the limit rather than narrow it. Same goal as P25's "a typo can never widen a cap
    to unbounded", opposite mechanism, because the two value-spaces fail in opposite directions.

    No behaviour change — the parser, its grammar, and its throw are exactly as they were.

### Changed

- **BREAKING CHANGE: the conformance kit on `stitchapi/testing` is now one `conformance` namespace
  — `verifyStoreContract`, `verifyAdapterContract`, `verifySinkContract`,
  `verifyFingerprintContract`, `assertConformance` and `adapterContractFixture` are replaced by
  `conformance.store`, `.adapter`, `.sink`, `.fingerprint`, `.assert` and `.fixture`.**
  Four identical `verify<Seam>Contract` shapes returning one `ContractReport`, read off one entry to
  make one decision — the shape the token grammars and the secret-redaction trio each moved away
  from. Same reasoning, same fix: one name per dimension, the dimension named at the call site.
  The dimension here is the **seam**, and `ContractReport.seam` was already the discriminator the
  export names refused to be.

    | Was                                       | Now                                     |
    | ----------------------------------------- | --------------------------------------- |
    | `verifyStoreContract(make, opts?)`        | `conformance.store(make, opts?)`        |
    | `verifyAdapterContract(adapter, baseUrl)` | `conformance.adapter(adapter, baseUrl)` |
    | `verifySinkContract(makeSink)`            | `conformance.sink(makeSink)`            |
    | `verifyFingerprintContract(fp, fixtures)` | `conformance.fingerprint(fp, fixtures)` |
    | `assertConformance(report)`               | `conformance.assert(report)`            |
    | `adapterContractFixture(req)`             | `conformance.fixture(req)`              |

    ```ts
    // was
    assertConformance(await verifyStoreContract(() => myStore()));
    // now
    conformance.assert(await conformance.store(() => myStore()));
    ```

    **Behaviour is byte-for-byte what it was** — same rules, same rule names, same independent
    rule-catching so one violation never masks another, same `ContractReport`, same per-run key
    namespacing, same `ttl` duration grammar, same browser-safe no-`node:*` guarantee. Only the
    spelling moved. No aliases: pre-GA, and keeping the old spellings would leave six verbose names
    on the entry beside the namespace, which is the thing being removed.

    **`adapterContractFixture` joins the namespace as `conformance.fixture`** rather than staying
    standalone. It is not a verifier, but it is not an independent capability either: it is the
    SERVER half of the adapter contract — the pure request-in/response-out function
    `conformance.adapter` verifies a transport against — and it cannot be used apart from it. Same
    call the token grammars made putting `format` beside `parse`. Leaving it out would have kept one
    loose `*Contract*`-spelled name beside the namespace that replaced the other five, which is
    precisely the drift the fold removes.

    **Free on the bundle, and structurally so.** `stitchapi/testing` is imported by specs and never
    reaches a production bundle, and the subpath is not size-gated; the gate was run on both sides
    anyway and all three scenarios it does measure are byte-identical (whole entry 24.60 KB gzip,
    `import { stitch }` 21.82 KB, `stitchapi/auth` 5.22 KB). The implementations stay plain module
    functions in `testing.ts` and the namespace is a thin `as const` facade over them.

- **BREAKING CHANGE: the six host adapters' error helpers are now one `stitchError` namespace —
  `isStitchError`, `stitchErrorHandler`, `stitchOnError`, `stitchErrorResponse` and
  `toHttpException` are replaced by `stitchError.is`, `stitchError.map` and
  `stitchError.handler`.** ([ADR 0012](docs/adr/0012-integration-symbol-naming.md),
  [CONTRACT.md §6](docs/CONTRACT.md))
  One concept — "a stitch failed, turn it into HTTP" — carried two or three verb-prefixed
  top-level names in each of `@stitchapi/express`, `/fastify`, `/hono`, `/elysia`, `/next` and
  `/nest`, and the mapper alone had **four spellings**. `hono` and `elysia` were otherwise
  perfectly parallel, down to an identically named `stitchOnError`, and diverged on exactly
  that. It is the defect ADR 0012's own Context section opens with; that sweep fixed the
  logger-sink family and never came back for this one.

    | Package | Was                                                       | Now                                    |
    | ------- | --------------------------------------------------------- | -------------------------------------- |
    | express | `isStitchError` · `stitchErrorHandler`                    | `stitchError.is` · `.handler`          |
    | fastify | `isStitchError` · `stitchErrorHandler`                    | `stitchError.is` · `.handler`          |
    | hono    | `isStitchError` · `stitchError` · `stitchOnError`         | `stitchError.is` · `.map` · `.handler` |
    | elysia  | `isStitchError` · `stitchErrorResponse` · `stitchOnError` | `stitchError.is` · `.map` · `.handler` |
    | next    | `isStitchError` · `stitchErrorResponse`                   | `stitchError.is` · `.map`              |
    | nest    | `isStitchError` · `toHttpException`                       | `stitchError.is` · `.map`              |

    ```ts
    // before
    import { isStitchError, stitchOnError } from '@stitchapi/hono';
    // after
    import { stitchError } from '@stitchapi/hono';

    app.onError(stitchOnError({ status: (e) => e.status ?? 502 }));

    app.onError(stitchError.handler({ status: (e) => e.status ?? 502 }));
    ```

    **Behaviour is byte-for-byte what it was** — same `502`-by-default mapping, same
    generic status-tied body, same `status` / `body` overrides, same pass-through for a
    non-Stitch error. Only the spelling moved. No aliases: pre-GA `rc`, and keeping the old
    spellings would leave the very names being removed on the barrel beside the namespace.

    **Not every host has all three members, and the missing ones stay missing.** A member that
    meant something different per package would re-create the drift this closes. `express` and
    `fastify` have no `.map` — their handler writes onto a mutable `res` / `reply` and returns
    no mapped artifact to hand back. `next` has no `.handler` — a route handler is its own
    `Request` → `Response` function, so there is no central error hook to register one on.

    **`StitchExceptionFilter` is unchanged and stays a top-level class** on `@stitchapi/nest`:
    Nest registers a filter _instance_ through DI (`useGlobalFilters`,
    `{ provide: APP_FILTER, useClass }`), the idiom ADR 0012 rule 1 blesses. It is pinned
    present as a class so a later tidy-up cannot sweep it into the namespace.

    **The plugin option slots are untouched** — `@stitchapi/fastify` still takes `errorHandler`
    (after Fastify's `setErrorHandler`) and `@stitchapi/elysia` still takes `onError`. CONTRACT.md
    P18's mirror clause binds a framework-hook _slot_, where the surrounding option bag supplies
    the framework context; a named import strips exactly that context, which is why it does not
    carry over to the exports.

    **The namespace is a thin facade.** The implementations stay plain module functions and each
    package's own call sites keep importing them directly, so nothing welds all three onto a
    consumer that reaches one. Measured with esbuild from source: importing only `stitch` /
    `streamStitchSse` bundles **none** of the error module, and a guard-only consumer pays
    +174–219 B gzip on express/fastify/hono/elysia (+13 B nest, +0 next) for now shipping the
    siblings. None of these six has a size gate and all are server-side, so the trade is accepted
    rather than budgeted.

    **Why it drifted.** ADR 0012's 2026-06-20 conformance sweep covered ten packages;
    `@stitchapi/express` (#207), `@stitchapi/elysia` (#208) and `@stitchapi/next` (#222) all landed
    2026-06-19, one day earlier, and appear in neither its conformance nor its migration table.
    Those three contributed `stitchErrorResponse` twice and half of both handler spellings. But
    adjudication alone would not have saved them: every one of these names is `Stitch`-branded, so
    all six pass ADR 0012's rules read one symbol at a time — and `toHttpException` proves it from
    the other side, since nest _was_ swept and its one genuinely bare export was missed anyway.
    Recorded as a dated addendum on ADR 0012 (its 2026-06-20 table is left intact) and in
    CONTRACT.md §6.

    Every old spelling is pinned **absent** in all six packages' specs — not only where it lived —
    so "one dimension, one name" is a property of the family, not of each package on its own.

- **BREAKING CHANGE: the query-key trio is now one `stitchKey` namespace — `deriveQueryKey`,
  `nameOf` and `keyInputFor` are replaced by `stitchKey.of`, `stitchKey.name` and
  `stitchKey.input`.** ([ADR 0012](docs/adr/0012-integration-symbol-naming.md))
  Three verb-prefixed names for one two-segment key, re-exported wholesale onto five barrels
  (`@stitchapi/query-core` and the React / Vue / Svelte / Angular bindings). Their own JSDoc
  already described them as parts of one thing — "the first segment of a derived query key",
  "the second segment" — and `deriveQueryKey` wore the exact `parseDuration` shape the house
  convention rejects. Same reasoning as the token grammars and the `secrets` hatch, same fix:
  one name per dimension, the segment named at the call site.

    | Was                             | Now                           |
    | ------------------------------- | ----------------------------- |
    | `deriveQueryKey(stitch, input)` | `stitchKey.of(stitch, input)` |
    | `nameOf(stitch)`                | `stitchKey.name(stitch)`      |
    | `keyInputFor(input)`            | `stitchKey.input(input)`      |

    **Behaviour is byte-for-byte what it was** — the same `[name, sanitised input]` tuple, the same
    `name ?? path ?? url ?? 'stitch'` fallback chain, the same dropped runtime-only
    `signal`/`onProgress`, the same header-value redaction layered over core's `secrets.has`
    denylist. Only the spelling moved. `stitchQueryOptions` is untouched and still keys through
    `stitchKey.of`. No aliases: pre-GA, and keeping the old spellings would leave three verbose
    names beside the namespace on all five barrels, which is the thing being removed.

    **`stitchKey`, not `queryKey`.** TanStack Query owns that word — `queryKey` is the field name
    on the options object this package builds _for_ them — so a bare `queryKey` export would put
    one word on two meanings on a single import path, the exact collision that made the adapter
    `stitchQueryOptions` rather than `queryOptions`
    ([ADR 0012](docs/adr/0012-integration-symbol-naming.md),
    [P22](docs/CONTRACT.md#p22--a-standards-interop-contract-uses-the-standards-field-names)). The
    **absence** of a bare `queryKey` is pinned too, so the shorter spelling cannot be added later
    for symmetry.

    **Measured on the bundle, both sides.** query-core has no size gate; measured anyway, esbuild
    tree-shaken + gzip, the method `packages/core/scripts/bundle-size.mjs` uses. query-core's own
    entry is free — 1598 → 1597 B gzip whole-entry, with the `createStitchQuery`-only and
    `stitchQueryOptions`-only scenarios not moving at all. The React and Vue **hook-only**
    scenarios grow 1876 → 1919 B and 1885 → 1928 B gzip (+43 B each): those two bindings sanitise
    their dep key through the grammar, and a namespace object does not tree-shake, so `of` now
    rides along with `input`/`name` for a consumer who never touches TanStack. `packages/core`'s
    gated budgets do not move at all (24.60 / 21.82 / 5.22 KB gzip, unchanged).

    The implementations stay plain module functions and query-core's own call sites (`of`'s body,
    `stitchQueryOptions`) keep calling them directly, so the namespace is a thin facade rather
    than an object that welds all three onto every consumer's path. `@stitchapi/solid` continues
    to re-export only `stitchQueryOptions` and to point callers at query-core for the key itself;
    that divergence from the other four bindings predates this fold and is left standing.

- **BREAKING CHANGE: the fingerprinter registry is now one `fingerprinters` namespace on
  `stitchapi/fingerprint` — `registerFingerprinter`, `getFingerprinter`, `listFingerprinters` and
  `clearFingerprinters` are replaced by `fingerprinters.register`, `.get`, `.list` and `.clear`.**
  ([ADR 0004](docs/adr/0004-standard-schema-fingerprint-for-cache-invalidation.md))
  Four verb-prefixed names over one `Map`, each repeating a subject the subpath already names —
  the shape `secrets` and the token grammars moved away from. Same reasoning, same fix: one name
  per dimension, the verb at the call site.

    | Was                         | Now                           |
    | --------------------------- | ----------------------------- |
    | `registerFingerprinter(fp)` | `fingerprinters.register(fp)` |
    | `getFingerprinter(vendor)`  | `fingerprinters.get(vendor)`  |
    | `listFingerprinters()`      | `fingerprinters.list()`       |
    | `clearFingerprinters()`     | `fingerprinters.clear()`      |

    **Behaviour is byte-for-byte what it was** — same process-local `Map`, same last-registration-
    wins, same `undefined` on an unregistered vendor, same unordered `list`, same `clear`. Only the
    spelling moved, so the one line each `@stitchapi/fingerprint-*` package's README asks you to
    write becomes `fingerprinters.register(zodFingerprinter)` and nothing else changes. No aliases:
    pre-GA, and `src/fingerprint.ts` **is** the subpath entry, so keeping an old spelling would put
    it straight back on the published surface with no barrel in between.

    **Free on the core gate**, measured both sides: all three budgeted scenarios are unchanged to
    the byte on min+gzip — whole entry 24.60 KB, `import { stitch }` 21.82 KB, `stitchapi/auth`
    5.22 KB, with the same 0.20 / 0.18 / 0.13 KB headroom. No budget raise. Nothing on the core
    path reaches the registry: the root barrel never re-exported it, and `resolveFingerprint` —
    which the cache does reach — still calls the module function directly rather than going through
    the namespace, so `import { resolveFingerprint }` is byte-identical at 2.73 KB min / 1.29 KB
    gzip. The namespace is a thin facade over four plain module functions for exactly that reason.

    **What it does cost** is on the subpath, which the gate does not budget: a consumer importing
    only `registerFingerprinter` (0.10 KB min / 0.11 KB gzip) now imports `fingerprinters` and gets
    all four members (0.23 / 0.18), because esbuild will not split an object literal to drop a dead
    property. That is ~70 B gzip on the one import line a vendor package asks for, and the whole
    subpath entry is slightly _smaller_ than before (2.94 → 2.90 KB min, 1.37 KB gzip either way).

- **BREAKING CHANGE: the OTLP trio is now one `otlp` namespace — `otlpSink`, `otlpHttpExporter`
  and `toOtlpJson` are replaced by `otlp.sink`, `otlp.exporter` and `otlp.json`.**
  ([ADR 0007](docs/adr/0007-composition-causality-and-run-identity.md))
  Three names on the barrel for one export path, each repeating the subject noun and varying only
  the role word — the same shape the token grammars and the redaction trio moved away from. Same
  reasoning, same fix: one name per dimension, the role at the call site.

    | Was                       | Now                    |
    | ------------------------- | ---------------------- |
    | `otlpSink(opts?)`         | `otlp.sink(opts?)`     |
    | `otlpHttpExporter(opts?)` | `otlp.exporter(opts?)` |
    | `toOtlpJson(spans)`       | `otlp.json(spans)`     |

    **The grouping says something the three names hid.** These are not three sibling helpers but
    three LAYERS of one pipeline, each the input to the next: `otlp.json` serializes spans to the
    OTLP/JSON wire shape, `otlp.exporter` POSTs that to a collector, and `otlp.sink` maps a
    stitch's events to spans and hands them to the exporter. `otlp.sink()` alone is still the
    whole common case; the other two are the seams for a second collector and for a transport core
    doesn't ship (gRPC, a queue, a file).

    **Behaviour is byte-for-byte what it was** — same span mapping, same OTel HTTP semantic
    conventions, same `OTEL_EXPORTER_OTLP_ENDPOINT` default, same fire-and-forget export, same
    `url.full` scrubbing. Only the spelling moved. `STITCH_EXPORT=otlp` is unaffected. No aliases:
    pre-GA, and keeping the old spellings would leave three names on the barrel next to the
    namespace, which is the thing being removed.

    **Effectively free on the bundle**, measured both sides: the whole entry is unchanged at
    24.60 KB gzip (minified actually drops, three exported names becoming one) and
    `import { stitch }` moves 21.82 → 21.83 KB (+10 B). No budget raise. The implementations stay
    plain module functions in `otlp.ts` and core's own call site (`stitch.ts`) keeps importing
    `otlpSink` directly, so the namespace is a thin facade rather than an object that welds all
    three onto a consumer's path.

- **BREAKING CHANGE (`@stitchapi/react-native`, `@stitchapi/expo`): the streaming-polyfill pair is
  now one `rnStreamingPolyfills` namespace — `assertStreamingPolyfills` and `hasStreamingPolyfills`
  are replaced by `rnStreamingPolyfills.assert` and `rnStreamingPolyfills.has`.**
  ([ADR 0012](docs/adr/0012-integration-symbol-naming.md))
  Two verb-prefixed names on the barrel for one question — are the three globals Hermes does not
  ship present? — which is the shape core's `secrets` namespace and the token grammars already
  moved away from. Same reasoning, same fix: one name per dimension, the verb at the call site.

    | Was                          | Now                             |
    | ---------------------------- | ------------------------------- |
    | `assertStreamingPolyfills()` | `rnStreamingPolyfills.assert()` |
    | `hasStreamingPolyfills()`    | `rnStreamingPolyfills.has()`    |

    **Behaviour is byte-for-byte what it was** — same three required globals in the same order,
    same `typeof === 'undefined'` test, same error text and install hint, same optional `scope`
    argument defaulting to `globalThis`. Only the spelling moved. No aliases: pre-GA, and keeping
    the old spellings would leave two verbose names on the barrel next to the namespace, which is
    the thing being removed. Both old names are pinned **absent** from the barrel so an alias
    cannot drift back and leave two spellings of one call.

    **The name gained its `rn` qualifier at the same time.** The old pair was bare and non-branded
    in an adapter package, which [ADR 0012](docs/adr/0012-integration-symbol-naming.md) rule 6
    rules out — the packages landed one day before that ADR's conformance sweep and were missed by
    it. `rnStreamingPolyfills` matches `rnStreamAdapter` in the same package, and the qualifier
    earns its keep on the re-export: `@stitchapi/expo` re-exports this barrel verbatim, so the
    namespace is reachable from a package that needs no polyfill at all (`expo/fetch` streams
    natively). A bare `streamingPolyfills` on an Expo import would be answering about a gap Expo
    does not have.

    The implementations stay plain module functions in `polyfills.ts` and `rnStreamAdapter` keeps
    importing `assertStreamingPolyfills` directly, so the namespace is a thin facade rather than an
    object welded onto the adapter's path. Non-streaming stitches still never reach the guard.

- **BREAKING CHANGE: the secret-redaction trio is now one `secrets` namespace — `registerSecretKey`,
  `isSecretKey` and `redactSecretsDeep` are replaced by `secrets.register`, `secrets.has` and
  `secrets.redact`.** ([ADR 0018](docs/adr/0018-inspect-raw-redaction.md))
  Three verb-prefixed names on the barrel for one denylist, which is the shape the token grammars
  had already moved away from one release earlier. Same reasoning, same fix: one name per
  dimension, the verb at the call site.

    | Was                            | Now                         |
    | ------------------------------ | --------------------------- |
    | `registerSecretKey(name)`      | `secrets.register(name)`    |
    | `isSecretKey(name)`            | `secrets.has(name)`         |
    | `redactSecretsDeep(v, extra?)` | `secrets.redact(v, extra?)` |

    **Behaviour is byte-for-byte what it was** — same denylist, same stems, same case-insensitive
    match, same process-wide additive registration, same deep non-mutating clone, same `extra`
    path grammar. Only the spelling moved. `apiKey({ in: 'query', name })` still registers its
    configured name automatically. No aliases: pre-GA, and keeping the old spellings would leave
    three verbose names on the barrel next to the namespace, which is the thing being removed.

    **The header caveat now has one home.** `secrets.has` answers about query params and body keys,
    not headers — `secrets.has('authorization')` is `false` even though every built-in sink redacts
    that header, which you widen with `redactHeaders` at the sink boundary instead. The old
    predicate's name invited that mistake at every call site and needed the warning repeated; it is
    stated once on the namespace's JSDoc and once in the reference page.

    **Effectively free on the bundle**, measured both sides: `import { stitch }` is unchanged at
    21.82 KB gzip and the whole entry moves 24.59 → 24.60 KB (+10 B; minified actually drops, three
    exported names becoming one). No budget raise. The implementations stay plain module functions
    in `util.ts` and core's own call sites keep importing them directly, so the namespace is a thin
    facade rather than an object that welds all three onto a consumer's path.

- **BREAKING CHANGE: the three token parsers are now `parse`/`format` pairs — `parseDuration`,
  `parseBytes` and `parseRate` are replaced by `duration`, `size` and `rate`.**
  ([CONTRACT.md P17](docs/CONTRACT.md#p17--one-canonical-duration-form) /
  [P25](docs/CONTRACT.md#p25--one-canonical-size-form))
  The house grammars only ever decoded. Making them public gave them callers who need the other
  direction too — a CLI printing the cap it enforced, a config round-trip, an error message
  quoting a limit in the grammar its author wrote — and each of those would have hand-rolled an
  encoder, which is the drift the export existed to prevent.

    Each dimension is now one namespace with both directions, following `bytes`'s shape
    (`bytes.parse` / `bytes.format`) rather than adding three more verb-prefixed names:

    | Was                | Now                 | Gained                                           |
    | ------------------ | ------------------- | ------------------------------------------------ |
    | `parseDuration(d)` | `duration.parse(d)` | `duration.format(90_000)` → `'1.5m'`             |
    | `parseBytes(s)`    | `size.parse(s)`     | `size.format(1_048_576)` → `'1mb'`               |
    | `parseRate(r)`     | `rate.parse(r)`     | `rate.format({ count: 2, per: 1000 })` → `'2/s'` |

    Behaviour of the decode direction is byte-for-byte what it was — same grammars, same 1024-based
    size units, same `undefined` fallback for a bad duration or size token, same throw for a bad
    rate. Only the spelling moved. A `Rate` type is now exported for the `{ count, per }` pair.

    **`format` is the exact inverse of `parse`, not a pretty-printer.** `parse(format(v))` returns
    `v` unchanged for every value `parse` can produce, pinned as a property over the whole numeric
    range rather than a table of cases. This is the one place the pair deliberately departs from
    `ms`, whose `ms(90_000)` is `'2m'` and reads back as 120_000: a lossy encode is fine in a log
    line and disqualifying in anything that writes a value back, and P25's "a typo can never widen
    a cap" only holds if the encode direction cannot widen one either. Where no unit divides a
    value cleanly the base unit wins — `90_001` is `'90001ms'`, and `1537` is `'1537b'` rather than
    the exact-but-unreadable `'1.5009765625kb'`.

    **Migration** is a rename at every call site; there is no alias
    ([P19](docs/CONTRACT.md#p19--the-alias-obligation-is-scoped-to-the-ga-channel) scopes the alias
    obligation to the GA channel, and this is `rc`). The old names are pinned **absent** from the
    barrel, so a stale import fails at build rather than resolving to something else:

    ```diff
    - import { parseDuration, parseBytes, parseRate } from 'stitchapi';
    - const ttl = parseDuration(opts.ttl);
    - const cap = parseBytes(opts.max);
    - const { count, per } = parseRate(opts.rate);
    + import { duration, size, rate } from 'stitchapi';
    + const ttl = duration.parse(opts.ttl);
    + const cap = size.parse(opts.max);
    + const { count, per } = rate.parse(opts.rate);
    ```

    One caveat worth naming: `size` no longer spells `Bytes`, so the `Bytes`/`Chars` distinction is
    no longer visible at the call site. `stream.buffer.chars` and `trace.body.chars` count UTF-16
    code units, not bytes, and still reject a token at compile time — but the name no longer warns
    you before the type does.

- **BREAKING CHANGE (types only): a `baseUrl`/`path` beside a `url` in ONE config literal is now a
  compile error.**
  ([CONTRACT.md P24 carve-out (b)](docs/CONTRACT.md#p24--a-shared-field-name-prefix-in-a-house-contract-is-an-envelope))
  The endpoint slot has two spellings — the atomic `url`, and the `baseUrl` + `path` pair — and the
  engine reads exactly one of them: when `url` is set it **is** the whole endpoint, no base is
  joined, and neither sibling is ever read. Pairing them in one literal was dead config that the
  type system nonetheless accepted.

    **The bug this fixes.** `stitch({ url: 'https://a.test/x', baseUrl: 'https://b.test' })`
    typechecked and silently discarded the base — the request went to `a.test`. The engine's own
    diagnostic fires only when the **joined** result is not absolute, so it caught the relative-`url`
    slip (`url: '/users'` alongside a `baseUrl`) and nothing else; the absolute-`url` case resolved to
    a perfectly fetchable URL aimed at the wrong host, with nothing said anywhere. Only the JSDoc
    recorded that `url` wins. `OneEndpointSpelling` now brands the inert sibling with a `ConfigError`
    naming it, on every surface that authors a stitch (`stitch`, `graphql`, `download`, and their
    `Seam` members).

    Migration — the rejected pairing had no working meaning, so there is nothing to preserve. Drop
    the field that was being ignored, or keep it and drop `url`:

    ```ts
    // before: compiled, silently ignored `baseUrl` — the request went to a.test
    stitch({ url: 'https://a.test/users', baseUrl: 'https://b.test' });
    // after: say which one you meant
    stitch({ url: 'https://a.test/users' });
    stitch({ baseUrl: 'https://b.test', path: '/users' });
    ```

    **Composition is unchanged.** The guard reads the config literal only, so across `extends`
    fragments the two spellings remain a last-writer-wins override: a seam's shared `baseUrl` with
    one member's absolute `url` — the ordinary way to point a single endpoint off-origin — still
    compiles and still behaves exactly as before.

- **BREAKING CHANGE: `RateLimitError` now extends `StitchError`.**
  ([CONTRACT.md P10](docs/CONTRACT.md#p10--error-class-taxonomy-parity)) The two classes were
  siblings, and P10 held them in parity by having `RateLimitError` re-declare `status` / `attempts` /
  `body` / `url` by hand — a rule enforcing exactly what `extends` gives for free. They are now one
  taxonomy rooted at `StitchError`.

    **The bug this fixes.** `SafeResult.error` is typed `StitchError`, so `.safe()` had to coerce a
    delegate-backoff `RateLimitError` into a bare one: the instance moved to `.cause`, the
    `instanceof` test stopped working, and **`error.body` came back `undefined`** — dropping the
    payload (`X-RateLimit-*` siblings, a vendor's cost envelope) an outer gate reads to pace itself.
    The mode whose whole point is handing back-pressure outward lost its signal on the path this
    codebase otherwise recommends. `.safe()` now returns the same instance `await` throws.

    Migration — **check the order of your `instanceof` arms**:

    ```ts
    // before: order was free, the classes were disjoint
    // after: a leading StitchError arm SWALLOWS the rate-limit signal
    if (e instanceof RateLimitError) gate.penalize(e.retryAfter ?? 1000);
    else if (e instanceof StitchError) report(e.status);
    ```

    Everything else is additive: `RateLimitError` keeps `name`, `retryAfter` and `response`, gains a
    `cause`, and a generic `catch (e instanceof StitchError)` now sees rate limits like any other
    failure. Serialising hosts (`@stitchapi/rtk-query`) are unaffected — they branch on `name` and
    project own fields, both unchanged.

- **BREAKING CHANGE: `timeout.perAttempt` is renamed to `timeout.each`.**
  ([CONTRACT.md P1](docs/CONTRACT.md#p1--one-word-one-concept-one-value-space) +
  [P4](docs/CONTRACT.md#p4--one-cap-vocabulary)) `timeout` already names the subject, so by
  [P24](docs/CONTRACT.md#p24--a-shared-field-name-prefix-in-a-house-contract-is-an-envelope)/[P25](docs/CONTRACT.md#p25--one-canonical-size-form)
  the member owes only its **scope** — and the opposite number of `total` is a scope, not an
  attempt counter. `each` is the one-word token P1 prefers and the natural pair for `total`.

    Migration — rename the key, nothing else:

    ```ts
    // before
    timeout: { total: '10s', perAttempt: '3s' },
    // after
    timeout: { total: '10s', each: '3s' },
    ```

    **Behaviour is unchanged**, including how the two compose: each attempt is clamped to
    `min(each, remaining total)`, so `total` still bounds the whole call across every retry and its
    backoff waits. `tsc` catches the migration — `NoUnknownNestedKeys` rejects a leftover
    `perAttempt` at the `timeout:` slot by name. Hard break, no alias
    ([P19](docs/CONTRACT.md#p19--the-alias-obligation-is-scoped-to-the-ga-channel), `rc` channel).

    _Why not `timeout.attempt`:_ P4 reserves singular `attempt` for the current attempt index —
    the engine emits it on every `progress` event — and plural `attempts` for the running count.
    Taking it here would have made one word mean both an index and a duration, which is the P1/P2
    collision the rename exists to avoid.

- **BREAKING CHANGE: the four cache fingerprint fields become one `cache.fingerprint` envelope.**
  ([CONTRACT.md P24](docs/CONTRACT.md#p24--a-shared-field-name-prefix-in-a-house-contract-is-an-envelope),
  [P25](docs/CONTRACT.md#p25--one-canonical-size-form)) `version`, `transformVersion`,
  `trustTransform` and `onUnfingerprintable` were four flat fields sitting among the cache's keying
  and lifetime options, but they are one capability: the whole of
  [ADR 0004](docs/adr/0004-standard-schema-fingerprint-for-cache-invalidation.md)'s ladder for
  detecting that a stored value has gone stale against its contract.

    Migration — every field moves into the envelope, and two shed a prefix the envelope now carries:

    ```ts
    // before
    cache: { ttl: '1h', version: 3 },
    cache: { ttl: '1h', transformVersion: 2 },
    cache: { ttl: '1h', trustTransform: true },
    cache: { ttl: '1h', onUnfingerprintable: 'revalidate' },
    // after
    cache: { ttl: '1h', fingerprint: 3 },                              // ≡ { version: 3 }
    cache: { ttl: '1h', fingerprint: { transform: 2 } },               // ≡ { transform: { version: 2 } }
    cache: { ttl: '1h', fingerprint: { transform: { trust: true } } },
    cache: { ttl: '1h', fingerprint: { fallback: 'revalidate' } },
    ```

    Two rules drive it. **P24** for `transformVersion`+`trustTransform`: a shared prefix across two
    flat fields is an envelope, and these were the two arms of one decision (name a version, or
    trust it) whose precedence — `version` wins, `trust` is then inert — lived only in the resolver
    and is now a within-envelope rule. **P25's envelope test** for the grouping: an envelope is
    licensed where it names an unambiguous subject, and every member here is a staleness-detection
    choice, so `fingerprint` is exhaustive over its contents the way `wire` is, while `ttl`,
    `tenancy`, `vary`, `methods`, `entries`, `coalesce` and `keyOf` answer a different question and
    stay outside.

    `onUnfingerprintable` becomes **`fallback`** because inside the envelope the subject is named
    once, and `on*` is this surface's handler convention — a policy string wearing it reads as a
    callback slot. A bare tag is the P12 dominant-field shorthand at **both** depths, so the common
    cases stay one word longer than before at most, and the manual override is now
    `cache: { ttl, fingerprint: 3 }`.

    `tsc` catches the whole migration — `NoUnknownNestedKeys` rejects every old key by name at the
    `cache:` slot, and none had a runtime fallback, so there is no silent path. Behaviour is
    unchanged end to end: the ladder, its rung order, the refuse-by-default for an un-versioned
    transform or an un-fingerprintable schema, and the generation token a given version produces are
    all exactly as they were. The refusal `reason` surfaced on the cache trace names the new
    spellings. `resolveFingerprint`'s read-view stays flat — it is a derived view, not an authored
    config — with `trustTransform` → `transformTrust` and `onUnfingerprintable` → `fallback` so the
    published `stitchapi/fingerprint` surface carries one vocabulary.

- **BREAKING CHANGE: `circuit.halfOpenAfter` is removed — `cooldown` is the one open→half-open
  boundary.** ([CONTRACT.md P1](docs/CONTRACT.md#p1--one-word-one-concept-one-value-space)) The two
  fields named the same instant: `createCircuit` resolved `halfOpenAfter ?? cooldown` into a single
  value, and `phase()` — the only place the open/half-open boundary is decided — compared against
  that one value. So `cooldown` had no effect of its own once `halfOpenAfter` was set, and the
  "probe on a different clock than the fast-fail window" the docs described was never possible: a
  call is either rejected or admitted, so there is no third phase for a second timer to gate.

    Migration — fold the value you cared about into `cooldown`:

    ```ts
    // before
    circuit: { failures: 5, cooldown: '30s', halfOpenAfter: '60s' },
    // after — '60s' was the effective boundary, so it is the cooldown
    circuit: { failures: 5, cooldown: '60s' },
    ```

    **`tsc` catches the migration** — but only as of the nested-key fix released alongside this
    entry. When this change first landed a leftover `halfOpenAfter` still typechecked at the
    `circuit:` slot, and the breaker silently switched to the `cooldown` boundary; `stitch()`
    therefore logs a one-time construction warning naming the stitch and the boundary it actually
    gets. With `NoUnknownNestedKeys` in place the slot rejects the key by name, and that warning is
    now a backstop for JS callers rather than your only signal.

- **`retry.respectRetryAfter` becomes `retry.respect`, and a `Retry-After` header is now honored by
  default.** The flag was opt-in, which meant the default retry behaviour ignored a number the
  server had explicitly provided in favour of a guessed backoff curve — on exactly the statuses the
  header exists for, since `retry.on` already defaults to `[429, 502, 503, 504]`. Every code example
  in this repository turned it on; the delegate-backoff path already parsed the header with no flag
  at all; and the delegate-backoff guide already described honoring it as baseline behaviour. The
  default was the outlier, not the preference.

    ```ts
    // before — every example in the docs looked like this
    retry: { attempts: 4, on: [429, 502, 503], respectRetryAfter: true },
    // after — that is now the default
    retry: { attempts: 4, on: [429, 502, 503] },
    // opt out and force the computed curve
    retry: { attempts: 4, on: [429, 502, 503], respect: false },
    ```

    The name loses its suffix because the envelope already supplies it: inside `retry`, the only
    thing there is to respect is the server's `Retry-After`. It stays a plain boolean, so it can
    never be misread as carrying a duration — and it is spelled differently from
    `RateLimitError.retryAfter` on purpose. That field's job is to **carry** the header's parsed
    value in ms ([P22](docs/CONTRACT.md#p22--a-standards-interop-contract-uses-the-standards-field-names),
    so it keeps the standard's name); this one is a house policy about whether to obey it. One token
    for both would put a magnitude and a boolean in one word — the collision
    [P2](docs/CONTRACT.md#p2--dont-reuse-one-word-for-genuinely-different-concepts--rename-one)
    renamed `reconnect.backoff` to avoid.

    **`tsc` catches the migration**: `NoUnknownConfigKeys` rejects a stale `respectRetryAfter:` by
    name. That is why this ships as a rename rather than a silent default flip — a change to how
    long your process sleeps should fail loudly, not quietly start behaving differently. Per
    [P19](docs/CONTRACT.md#p19--the-alias-obligation-is-scoped-to-the-ga-channel) this is a hard
    break on the `rc` channel, with no `@deprecated` alias.

    **There is deliberately no ceiling on an honored `Retry-After`.** `timeout.total` is already the
    one place a caller declares how long they are willing to wait, and it already bounds every
    backoff sleep in the attempt loop — a second limit inside `retry` would be two patience budgets
    for one question. A long `Retry-After` under a total budget fails with the timeout instead of
    parking the call, and the wait ends early on the request's `AbortSignal`. A stitch with `retry`
    and no `timeout.total` waits as long as the server asks.

- **`SurfaceOutcome`'s retry arm takes the canonical duration form: `after` widens to
  `number | string`.** It was raw ms only, so `after: '5s'` — the spelling every other authored
  duration in the library accepts — did not typecheck, and the value is now run through the shared
  `parseDuration` rather than used raw. `after` is authored by a surface, and `Surface` is a public
  extension seam ([P21](docs/CONTRACT.md)), so
  [P17](docs/CONTRACT.md#p17--one-canonical-duration-form)'s consumer-authored rule applies to it:
  raw ms **or** a token like `'5s'`, through the one shared parser.

    Worth knowing if you had cast around the old type: an unparsed token reached `setTimeout`, which
    coerces it to `NaN` and fires immediately — so the wait collapsed to ~0 instead of failing.
    Covered now by a test that asserts the elapsed floor, which fails at 14ms without the parse.

    Widening only, so per [P19](docs/CONTRACT.md#p19--the-alias-obligation-is-scoped-to-the-ga-channel)
    this is non-breaking and needs no alias — every existing `after: 1_000` keeps working unchanged.

- **`acceptStatus` folds into a `verdict` envelope, and response classification becomes one
  decision.** ([ADR 0022](docs/adr/0022-response-classification-merges-at-interpret.md)) The engine
  used to decide what a response _was_ in two places at two times: a status check inside the attempt
  loop that could retry or throw but never saw the body, and a surface's `interpret` that saw the
  body but ran after the loop had finished — so it could only say ok/not-ok, and never saw a status
  the first phase had already thrown on.

    `interpret` now runs **inside** the attempt loop, as the terminal verdict of each attempt, on
    every response including non-2xx. `httpSurface` gains a real `interpret` (it was the one surface
    with none, which is why its policy had nowhere to live), an omitted `kind` resolves to it, and
    the verdict becomes a named, composable function instead of an engine branch. **`verdictOf`**
    is the one new public export — the whole declarative verdict, what a surface composes in front
    of its own body rules. (It has two internal siblings at narrower and wider scope; the barrel
    deliberately carries one, so there is a single composition point rather than three names for
    one decision.)

    At the authoring site, the flat `acceptStatus` slot becomes `verdict`:

    ```ts
    // before
    acceptStatus: [404],
    // after
    verdict: { accept: [404] },
    ```

    `verdict.flag` is the new second member — a dot-path to a body flag that is explicitly falsy on
    failure, for the `{ ok: false, code }` envelopes older APIs answer `200` with. It is three-state
    and only one state is a verdict: a present-but-falsy value fails the call; `null` and an absent
    path are **silence** (the status verdict stands, plus an `info` drift finding), so an API that
    quietly drops its envelope cannot start failing every call.

    **`tsc` catches the migration.** A stale `acceptStatus:` is a compile error naming the slot —
    on a config literal, on a hoisted `const`, and through an `extends` fragment. That is thanks to
    the `NoUnknownConfigKeys` guard landing alongside this change; it reads `keyof C` rather than
    relying on excess-property checking, which `stitch`'s `const C extends Partial<StitchConfig>`
    generic suppresses. Without it the stale slot would have been silently ignored and the status
    would have quietly started throwing again.

    Also breaking for **surface authors**: an `interpret` hook now runs on responses it was
    previously guaranteed never to see, with no compile-time signal (the signature is unchanged).
    Compose `verdictOf` in front of your own rules, as the built-in `graphql` / `download` / `llm`
    hooks now do, or a `500` will be read as a successful payload. `SurfaceOutcome` also gains a
    retry arm (`{ ok: false, retry: true, message, after? }`), so a surface that has read the body
    can ask for another attempt within the `retry.attempts` budget — closing
    [#529](https://github.com/rejifald/StitchAPI/issues/529).

    Two smaller visible changes: `__config.kind` now reads `'http'` on a plain stitch instead of
    being absent (the default surface is selected, not implied), and the pipeline read-out
    (`stitch diagram`, the MCP teaching list) gains an `interpret` stage for **every** stitch — the
    discoverability gap #529 opened with.

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

    **Migration:** a stale `bodyType:` / `responseType:` / `arrayFormat:` at a call site is a
    compile error naming the key, so `tsc` finds every one. That was not true when this entry
    was first written — `stitch`'s `const C extends Partial<StitchConfig>` generic captures the
    argument type, which suppressed excess-property checking, so the field was silently ignored
    and the body fell back to JSON. The `NoUnknownConfigKeys` guard (see **Fixed**) closed that
    gap; grepping for the old spellings is no longer necessary.

- **`wire.multipart` now requires `wire.body: 'multipart'` at compile time.** The slot is read
  only on a multipart body, so pairing it with `'json'`/`'form'` — or with no body encoding at
  all — was silently inert config that typechecked. It is now a type error naming the offending
  field, on `stitch`, `graphql`, `Seam.stitch`, and `Seam.graphql`.

- **`@stitchapi/shell` omits the whole `wire` envelope from `ShellOptions`.** A subprocess has no
  HTTP wire format: its `body` is argv rather than an encoded payload, and how stdout becomes a
  value is spelled `decode`. The surface already omitted the flat `responseType` for that reason,
  so it omits the envelope that field moved into — dropped whole rather than by its `response`
  member, since filtering one member would leave the other three inherited, typechecking and
  doing nothing. `shell({ wire: … })` is now a type error.

- **BREAKING — `wire.body` on a `graphql` stitch is now a compile error.** The `graphql`
  surface builds its own request body — a JSON `{ query, variables, operationName? }`
  envelope — so a `wire.body` authored alongside it was never read:
  `graphql({ …, wire: { body: 'multipart' } })` typechecked and silently sent JSON. A surface
  owns its shaping (ADR 0005 Decision 1), so the field is not a knob there, and it now says so
  at the authoring site rather than discarding the value:

    ```ts
    graphql({ baseUrl, document, wire: { body: 'multipart' } });
    //                                   ^ the `graphql` surface always sends a JSON
    //                                     `{ query, variables }` body — `wire.body` is ignored
    ```

    The guard binds every surface that authors a graphql stitch — `graphql()`,
    `graphql.bind(seam).stitch`, `seam.graphql()`, and `stitch({ kind: graphqlSurface })`
    (both the inferring and the fallback overload, or a rejected config would fall through
    to the loose one and typecheck after all). It also makes `wire.multipart` unreachable on
    graphql for free: `MultipartOnlyOnMultipartBody` already requires `wire.body: 'multipart'`
    before `wire.multipart` is legal, and that is exactly the spelling this rejects. The
    sibling slots stay legal — `wire.response` and `wire.array` are not body encodings.

    Like the other config guards, it reads the **composed** config (`Layers`), so a surface
    inherited through `extends` counts: `stitch({ extends: [gqlBase], wire: { body: 'form' } })`
    is rejected when `gqlBase` supplies `kind`. Note the polarity, which is the reverse of the
    sibling guards: finding the surface makes a config illegal rather than legal, so the
    existential scan can fail CLOSED here — a config that inherits graphql and then overrides
    `kind` back to a non-graphql surface is rejected despite its `wire.body` being live. That is
    a perverse config with an obvious workaround, and distinguishing it would need the last-wins
    resolution the existential scan exists to avoid; it is pinned as a tsd expectation so the
    tradeoff is on record.

    **Migration:** delete the field — there is no replacement and nothing to preserve, because
    it never did anything. No runtime behaviour changed: the surface sent a JSON body before
    and still does, so only configs that were already inert stop compiling. Breaking solely in
    the sense that a build which previously passed can now fail.

- **BREAKING — `method` / `wire.response` on a `download` stitch, and `method` / `wire.body`
  on an `llm` stitch, are now compile errors.** The same sweep, applied to the other two
  surfaces whose `buildRequest` overwrites a caller-authorable field.
  `downloadSurface.buildRequest` hardcodes `method: 'GET'` and a blob response; the live `llm`
  surface hardcodes `method: 'POST'` and a JSON body. All four were silently discarded:

    ```ts
    download({ url, method: 'POST' });
    //              ^ the `download` surface always issues a GET — `method` is ignored
    llm({ provider, model, wire: { body: 'form' } });
    //                             ^ the `llm` surface always sends a JSON body built by the
    //                               provider — `wire.body` is ignored
    ```

    For `download` the guard binds `download()`, `download.stitch`, `download.bind(…).stitch`,
    and `stitch({ kind: downloadSurface })` on both overloads. For `llm` it binds `llm()`,
    `llm.stitch`, and `llm.bind(…).stitch` — but deliberately **not**
    `stitch({ kind: llmSurface })`: the exported `llmSurface` is only the redaction identity
    and carries no `buildRequest`, so `method` really is honoured on that path.

    Note that these guards read the **authoring** spelling. `AdapterRequest` still carries flat
    `responseType` / `bodyType`, and that is exactly what both `buildRequest` implementations
    set — the guards close the config surface above them, not the transport contract below.

    Like the other config guards, these read the **composed** config (`Layers`), so an `extends`
    fragment that selects the download surface is seen and the same rejections apply through it.
    `RequestShapeFixedByDownload` shares `WireBodyFixedByGraphql`'s inhibitor polarity described
    above, and so its fail-CLOSED case too: inheriting the download surface then overriding `kind`
    away from it still rejects. Same tradeoff, same reasoning, also pinned in tsd.

    **Migration:** delete the field. As with graphql, no runtime behaviour changed — only
    configs that were already inert stop compiling. If you were reaching for
    `download({ method: 'POST' })` to download the result of a POST, that request is a plain
    `stitch({ method: 'POST', wire: { response: 'blob' } })`; the only thing it gives up is the
    `Content-Disposition` filename parsing.

- **BREAKING — `kind` on a `download()` preset stitch is now a compile error.** The last field
  in the same class, and the one the sweep above left behind. Both preset paths build their
  config as `{ ...config, kind: downloadSurface }` — spreading the caller's `kind` in, then
  overwriting it on the next line — so authoring one selected nothing:

    ```ts
    download({ url, kind: graphqlSurface });
    //              ^ the `download` preset always selects the download surface — `kind` is
    //                ignored. Before: compiled, and quietly returned a DOWNLOAD stitch.
    ```

    The guard binds `download()`, `download.stitch`, and `download.bind(…).stitch`, and
    deliberately **not** `stitch({ kind: downloadSurface })` — on the generic path `kind` is not
    dead config, it is the only thing selecting the surface, so guarding it there would reject
    correct code. That is why this is a separate `NoKindOnDownload` rather than a third arm of
    the `method` / `wire.response` guard, which the generic path shares.

    The redundant `kind: downloadSurface` is rejected on the preset too, for the same reason
    `method: 'GET'` is: the slot is never read, and letting through the exact value the preset
    forces would imply that it is.

    This closes on `download` the hole `llm` never had — `LlmOptions` is
    `Partial<Omit<StitchConfig, 'kind'>>`, and that structural spelling works there only because
    `llm()`'s parameter is non-generic, so excess-property checking catches a stray `kind`. The
    preset captures a `const C` to infer its call argument from `config.input`, and a generic
    constraint does no excess-property checking (the same migration gotcha the `wire` envelope
    documents above), so `Omit` would be satisfied by a config carrying the extra key. Hence a
    `ConfigError` guard here and a structural `Omit` there, for one rule.

    Reads the **composed** config like its siblings, and fails **open**: `kind` is the offending
    slot rather than an enabler here, so a layer the flattener cannot see costs a missed
    rejection, never a false one. A `kind` supplied only through an `extends` fragment still
    compiles; the literal spelling errors precisely. Pinned as tsd expectations.

    **Migration:** delete the field. No runtime behaviour changed — the stitch was already a
    download. To actually get another surface, use a plain `stitch({ kind })`.

- **BREAKING CHANGE: a multipart `type` no longer makes a value a file part.**
  ([#701](https://github.com/rejifald/StitchAPI/issues/701)) `isFileWrapper` accepted any object
  carrying a `type` key, so a domain object like `{ value: 100, type: 'refund' }` was encoded as a
  tiny Blob and its **siblings silently dropped** — a `200` with the money fields gone. A wrapper is
  now a file only when `value` is binary (Blob/File/Uint8Array/Buffer/ArrayBuffer) or an explicit
  `filename` names the part; `type` still sets a file part's content type, it just no longer creates
  one. **Migration:** a `{ value, type }` part whose `value` is not one of those binary types needs a
  `filename`, or pass `new Blob([value], { type })`.

### Fixed

- **`@stitchapi/download`'s aggregate ETA tracks recent throughput, not the batch's lifetime
  average.** ([#456](https://github.com/rejifald/StitchAPI/issues/456)) `BatchProgress.ratePerSec`
  was `loaded / (now - firstByte)` — one average over everything the batch had ever done — and
  `eta` divided the remaining bytes by it. That answers "how fast has this batch gone overall?",
  which is not the question an ETA asks. A dead first minute stayed in the denominator forever, so
  the ETA kept reading minutes-too-long while every item was streaming at full speed; a fast first
  second did the same in reverse, holding out a rosy ETA long after the transfer had stalled.

    Each `snapshot()` now takes a reading — bytes delivered since the previous reading, over the
    time between them — and folds it into an exponentially-decayed average with a two-second
    half-life, so the rate forgets the distant past and `eta` becomes a projection of how the batch
    is moving _now_. The decay is a function of elapsed time rather than of how many readings were
    taken, which means an extra `snapshot()` call cannot skew the number and a burst of small
    chunks weighs exactly what the interval it covers is worth. Dropping an item still discards its
    partial bytes from `loaded`, and the rate baseline drops with them, so a cancelled sibling's
    byte cliff is never mistaken for the healthy siblings going backwards.

    No new option: the half-life is an internal constant. Time still comes from the injected
    `clock`, so the whole thing is driven by `manualClock()` with zero wall-clock. The aggregate
    `total` under-counting while items are still queued (sizes are unknown until an item starts) is
    a separate matter, tracked in
    [#461](https://github.com/rejifald/StitchAPI/issues/461).

- **A transport failure reaches the caller as a `StitchError` carrying the original on `.cause`.**
  ([#450](https://github.com/rejifald/StitchAPI/issues/450)) A socket reset, a DNS failure or an
  abort surfaced as whatever the transport happened to throw, so the awaited and `.safe()` paths
  handed back an error whose shape the engine never promised — and the undici `code` that says
  _which_ failure it was (`UND_ERR_SOCKET`, `ECONNRESET`, …) came with it or not depending on the
  adapter. Both paths now return a `StitchError` whose `cause` is the live transport error, so
  `err.cause` (and its `.code`) tells a socket reset from a generic "fetch failed". `cause` is
  non-enumerable, so it never serialises into a trace sink. An error the engine minted itself is
  still re-surfaced unchanged.

- **`stitchapi/download` refuses a partial or unresolved response instead of handing back a
  truncated file.** A buffered download resolves to a whole Blob, but only `200` and `204`
  definitionally carry a whole entity. A `206 Partial Content` — which `download` never asks for,
  since it sends no `Range` header — was accepted and returned as if it were the complete file, so
  a range-serving proxy or a resumed-and-mismatched cache silently truncated the download. A `3xx`
  the adapter could not resolve (hop cap reached, or no `Location`) became an empty Blob. Both now
  fail with the status in the message; `verdict.accept` is the documented way back in for a caller
  who genuinely wants one.

- **A cancelled call surfaces the caller's own abort reason, and is never reported as a retry.**
  ([#705](https://github.com/rejifald/StitchAPI/issues/705)) With a `retry` block configured, an
  abort that landed while the call was parked in a backoff sleep came back as a generic
  `Error('aborted')`: the same stitch, cancelled the same way, answered `user navigated away`
  without `retry` and `aborted` with it. The backoff `sleep` minted its own error rather than
  preferring the signal's `reason`.

    The same cancellation also read as a **retry**. The attempt-loop catch emitted a
    `progress: 'retry'` event and fired the `onRetry` hook before dying in the backoff — a phantom
    attempt, reported to every trace consumer, for a call the user deliberately cancelled. The catch
    now rethrows as soon as the caller's signal is aborted: no `retry` event, no `onRetry`, no
    backoff. `onError` still fires, because that attempt did end.

    "Which error does an abort surface?" now has one spelling — `abortReason` in `util.ts`, shared
    by `sleep`, the engine's abort paths and `withTimeout`'s signal link, replacing three hand-copies
    of which one had already drifted. The mocking kit follows the same rule, so the behaviour is
    observable under injected clocks: `manualClock.sleep` and `mockAdapter` reject with the signal's
    reason exactly as `systemClock.sleep` and real `fetch` do.

    **Timeouts are untouched** — the guard keys on the caller's own signal, so a per-attempt or
    total timeout still retries as before. The other two findings in
    [#705](https://github.com/rejifald/StitchAPI/issues/705) — an abort counting as a circuit
    failure even when it sent no request, and the coalescer's unreachable cancel path — are
    unchanged and remain open.

- **Breaking out of a `.stream()` loop cancels the response body instead of leaking the socket.**
  ([#686](https://github.com/rejifald/StitchAPI/issues/686)) The `'bytes'` (default) and `'json'`
  decoders released the reader lock without cancelling, so an abandoned stream stayed open and the
  vendor kept writing into it. Both now tear down on every exit path, as `'lines'`/`'ndjson'` did.
- **`@stitchapi/openapi` refuses to overwrite a file it did not generate.**
  ([#694](https://github.com/rejifald/StitchAPI/issues/694)) A re-run wrote every emitted file
  unconditionally at exit `0`, so `--out <a directory you already own>` silently discarded
  hand-written edits. It now reads back the previous run's `.stitch-gen.json` and refuses to touch
  anything that manifest does not claim — naming the files, exiting non-zero — with `--force` to opt
  in. That manifest also records the validator tier actually **emitted**, not the one requested.
- **`axiosAdapter(axios)` — the adapter's own documented snippet — now typechecks against real
  axios.** ([#708](https://github.com/rejifald/StitchAPI/issues/708)) `AxiosLikeConfig.responseType`
  was `string`, which axios types as its narrower `ResponseType` union, so passing `axios` (or
  `axios.create()`) failed with `TS2345` under `exactOptionalPropertyTypes`. The type-level test
  missed it by casting a client through `AxiosLike`; it now asserts against real `axios` types.
- **A truncated LLM completion is no longer a silent success.** ([#699](https://github.com/rejifald/StitchAPI/issues/699))
  `finishReason` was lifted by both provider mappings and read by nothing, so a completion cut short
  at the token cap resolved `ok: true` with `findings: []`. It now sets a normalised `truncated` on
  `LlmResult` and emits a `warn` drift finding — non-fatal; failing the call is a follow-up.
- **An accepted non-2xx no longer becomes a cached absence.**
  ([#704](https://github.com/rejifald/StitchAPI/issues/704)) The store gate was `out.ok` alone, so
  `verdict: { accept: [404] }` cached the absence behind the `404` — masking a record created after
  it for the whole TTL, and (a hit replays without re-running `interpret`/`verdict`) letting that
  entry reach a reader whose own verdict rejects the status. The gate is now accept-blind (`< 400`),
  so only a status every reader counts as a success on its own merits is stored.

- **Adding `cache: { ttl }` no longer turns a handled vendor failure into a process exit.**
  ([#670](https://github.com/rejifald/StitchAPI/issues/670)) A cached stitch whose vendor returned
  `503` emitted an **unhandled promise rejection**, which under Node's default
  `--unhandled-rejections=throw` terminates the process — on a failure the caller had handled
  correctly, with `.safe()` returning an honest `ok: false`. The same failure with no `cache` block
  produced none.

    The coalescer's leader rejects one shared promise to release its waiters. With no concurrent
    caller there are no waiters, so nothing ever attached a handler and the rejection went
    unobserved. That made the bug **invisible in the shape a test takes and fatal in the shape
    production has**: a test exercises coalescing with a concurrent burst, and a follower's `await`
    catches the rejection by accident; a webhook backlog or retry drain arrives staggered, where
    every call is its own leader. Measured against a failing vendor, 20 staggered calls produced 20
    unhandled rejections; the same 20 as a burst produced none.

    The shared promise now carries a terminal no-op handler from the moment it is created, so being
    unobserved is never fatal. **A follower still receives the leader's failure unchanged** — same
    tick, same error identity — because the handler is attached to a derived promise and discarded;
    only the coalescer's own liability is retired. Failure is still not _shared_ (a follower re-runs
    independently, as before); [#653](https://github.com/rejifald/StitchAPI/issues/653) tracks
    whether it should be, and this leaves that channel intact for it.

- **`@stitchapi/aws-sigv4` stamps `x-amz-date` from the injected clock, so SigV4 is testable on
  virtual time.** ([#658](https://github.com/rejifald/StitchAPI/issues/658)) The signer called
  `amzDateOf(new Date())`, so 600 **virtual** seconds moved the shipped stamp **0** seconds and a
  default `manualClock()` (which starts at epoch `0`) produced a real-time stamp regardless. Every
  test that wanted to assert anything about signing time — skew handling, a signature's age across a
  throttle wait — had to inject its own clock-reading signer to measure it.

    [#664](https://github.com/rejifald/StitchAPI/pull/664) put the stitch's `clock` on `AuthContext`
    for `oauth2`; this is the companion package taking the same seam. The signing timestamp is
    control-flow time by ADR 0010's own definition — `x-amz-date` is inside the string-to-sign, and
    AWS refuses a stamp more than ~5 minutes out with `RequestTimeTooSkewed` — so it belongs on the
    clock that already drives retry, throttle, timeout, circuit and token freshness. It reads it
    through the identical `ctx.clock?.now() ?? Date.now()` fallback core's `auth.ts` uses, so a
    hand-built `AuthContext` in a custom strategy's unit test still type-checks.

    **Nothing changes on the wire.** The engine threads `systemClock` unless a clock was injected,
    and `systemClock.now()` _is_ `Date.now()` — pinned by a test that signs a request on the wall
    clock, reads back the instant it stamped, re-signs on a clock pinned to that instant, and
    asserts the `Authorization` header is byte-identical. Payload hashing and the `signBody`
    branches are untouched. The mocking guide's clock map moves the SigV4 row from wall-clock to
    **virtual** accordingly.

- **OAuth2 token expiry rides the injected clock, so "does my client refresh before expiry?" is
  finally a test you can write.** ([#650](https://github.com/rejifald/StitchAPI/issues/650))
  `oauth2` decided token freshness on the module-global wall clock, so 600,000 **virtual** ms past a
  60s `expires_in` refetched nothing. The test people actually want to write — advance past the
  expiry, assert the second token fetch — passed while asserting nothing, because the cached token
  was still fresh by a clock the test could not move.

    [ADR 0010](docs/adr/0010-injectable-clock.md) had already scoped this correctly — the clock owns
    **control-flow** time — and token freshness is control flow: it decides whether the next call
    fetches. It was simply out of reach. `auth.ts` contained zero occurrences of `clock` and
    `AuthContext` carried none, so this was never one line pointing at the wrong function; the seam
    did not extend that far.

    `AuthContext` now carries the stitch's resolved `clock`, threaded by the engine from the same
    place `Runtime.clock` comes from — the fifth injectable arriving the way `store`, `vault`,
    `principal` and `run` already do. Both halves of the freshness math (`expiresAt` at fetch time,
    and the `refresh.skew` window at read time) read it. **Nothing changes under the default
    `systemClock`**, which is ADR 0010's own guarantee; the capability activates only when a clock is
    injected. The field is optional, so a hand-built `AuthContext` in a custom strategy's unit test
    still type-checks and falls back to the wall clock.

    The mocking guide now carries the full map of which time-driven features `manualClock` drives and
    which read wall-clock, because ADR 0010 §4 and a `types.ts` JSDoc are not where someone writing a
    test looks. **`timeout.total`, event `at`/`done.ms` and store/cache TTL remain deliberately
    wall-clock** — decisions, not gaps — and are now documented as such where testers will find them.

- **`stubStitch(...).safe()` no longer throws when the stub's impl throws synchronously.**
  ([#650](https://github.com/rejifald/StitchAPI/issues/650)) `.safe()` is the never-throws accessor —
  that is the entire reason it exists — and a synchronous `throw` inside a function impl escaped it,
  while the async twin (`() => Promise.reject(e)`) correctly resolved `{ ok: false }` and the **real**
  stitch reported an adapter's synchronous throw as `ok: false`. The stub was the only one of the
  three that threw.

    `resolve()` evaluated `impl(input)` as an **argument** to `Promise.resolve`, so the throw escaped
    before there was a chain to catch it. It is now an `async` function, whose body turns the throw
    into a rejection. `.unwrap()` and the awaited call result are fixed by the same change;
    `.stream()` was never affected (an async generator already caught it).

- **`mockAdapter` honours an aborted signal on every route, not just delayed ones.**
  ([#650](https://github.com/rejifald/StitchAPI/issues/650)) `verifyAdapterContract(mockAdapter(…))`
  passed 8 of 9 rules and failed **"abort: a pre-aborted signal rejects"** — the mock answered a
  cancelled request. `req.signal` was consulted only inside the `delay` branch, so any route without
  a `delay` ignored a signal every real transport honours, and a cancellation test written against a
  delay-less route asserted the **opposite** of production behaviour.

    The signal is now checked before anything else happens. Nothing was sent, so a pre-aborted
    request records no spy entry and consumes no slot of a route's response sequence — `callCount()`
    keeps meaning "requests that reached the wire", which is what a cancellation test asserts on.

- **BREAKING — an `input` schema now SHAPES the request, not just gates it.**
  ([#648](https://github.com/rejifald/StitchAPI/issues/648)) `validateInput` awaited the validator,
  checked `r.ok`, threw on failure — and dropped `r.value` on the floor. Its return type was
  `Promise<void>`, so it structurally could not do otherwise, and the original **unparsed** input
  went to the transport. `validateOutput` had done the opposite since
  [ADR 0015](docs/adr/0015-schema-anchored-drift.md) — "on success returns the PARSED value —
  coerced, defaulted, stripped — so the result matches the declared contract" — which left the two
  halves of one feature behaving in opposite directions, and only the stripping half documented as
  doing so.

    Measured: a `query` validator that returned `{ limit: 10 }` still put
    `?tenant=globex&limit=10&include=internal_notes` on the wire, overwriting a `tenant=acme`
    pinned in the configured endpoint — and the vendor duly returned the other tenant's data.

    ```ts
    const getOrders = stitch({
        url: 'https://api.vendor.test/v1/orders?tenant=acme',
        input: { query: z.object({ limit: z.number() }) }, // strips by default
    });
    await getOrders({ query: { limit: 10, tenant: 'globex' } });
    // before: /v1/orders?tenant=globex&limit=10   after: /v1/orders?tenant=acme&limit=10
    ```

    Two properties compounded. A schema constrains **one slot**, so an undeclared slot is a full
    passthrough; and a pinned query pair is a **default**, not a pin (`{ ...predefined,
...input.query }`). The one mechanism a reader would reach for to close the second — declare a
    strict schema — silently did nothing, because stripping unknown keys is the DEFAULT in Zod,
    Valibot and ArkType alike. It bit hardest on the MCP surface, where `run_stitch` forwards a
    **model's** argument object, but nothing about it was MCP-specific.

    Every declared slot — `params`, `query`, `body`, `headers`, and GraphQL `variables` — now
    contributes its parsed value to the request, its cache key, and the events that echo it. The
    parsed values land in a **copy**, so the object a caller passed is never rewritten.

    **What did NOT change.** A slot with no schema stays the full passthrough it has always been:
    this filters, it does not lock down. And the graphql surface's `input.variables ?? input.body`
    fallback is intact — an absent optional slot parses to `undefined`, which is nullish.

    Migration — **a declared slot now sends only what its schema returns.** If a call relied on
    extra keys riding along beside a declared schema, name them in the schema, or use a passthrough
    shape (`z.object({…}).loose()` in Zod 4, `.passthrough()` in Zod 3) to keep the old behaviour
    for that slot. Coercions and defaults a schema declares now reach the wire, where they were
    previously computed and discarded.

- **`decode: 'json'` no longer buffers the array it is streaming.**
  ([#659](https://github.com/rejifald/StitchAPI/issues/659)) Streaming a top-level JSON array
  retained the **whole array text** — 19.48 MB held for a 21.5 MB body (0.90× the wire), growing
  linearly with the response — and then tripped the decoder's own 8 MB `stream.buffer.chars`
  default mid-stream. A 60,000-row array delivered **37,288 rows and then an `error` /
  `done(ok: false)`**, which a loop matching only `delta` never sees, under a message —
  _"a malformed or never-closing value was streamed"_ — that blamed the vendor for a
  perfectly well-formed body. Scanning was superlinear too: 43× the time for 10× the rows.

    **Emission was never the problem.** One delta per top-level element, correct under `,` `]` `}`
    inside string values, escaped quotes, embedded newlines, pretty-printed multi-line records, deep
    nesting and 1-character chunk boundaries — all of it already right, and now pinned by a test that
    feeds hard records **one byte per chunk** while compaction runs on every read.

    The window was. `compact()` floors on the start of the value in flight, and a top-level array
    recorded its opening `[` as that start and held it until the closing `]` — so for the array's
    whole lifetime the floor was byte zero and `compact()` was a no-op. But an array is **never
    emitted as a value**; only its elements are (`[{…},{…}]` is one delta per element, by design).
    It therefore needs no start recorded at all, and now records none: `elementStart` alone floors
    the window while an element is mid-flight, and between elements the floor is the scan cursor —
    exactly how the concatenated-value form (`{…}{…}`, the other shape this decoder accepts) has
    always released. The two shapes now measure alike: **0.11 MB flat for 100,000 rows either way**,
    against 19.48 MB for the array before, with time linear in the rows.

    **The cap keeps its teeth**, and its meaning sharpens: it bounds one **value**, so an array is
    now capped by its largest _element_ rather than by its _length_. A single element still in
    progress across reads still floors the window and still trips the cap — which is the case the
    cap exists for. Nothing about the public API changes; a stream that used to die at 8 MB now
    finishes, in bounded memory.

- **An unusable `backoff` throws at construction instead of vanishing.**
  ([#651](https://github.com/rejifald/StitchAPI/issues/651) §3) `backoff` takes a curve or the
  `{ curve, base, max }` envelope — never a function — so `backoff: () => 6000` is correctly a type
  error. Casting past it (which people do when they believe a feature exists) constructed clean and
  then did **nothing**: the function was never invoked, and the waits fell back to the default curve
  on the default 100ms base. Measured gaps of `100, 200`ms where the config asked for 6000, with no
  throw, no event, and nothing in the trace that reads as wrong.

    `expandShorthand` folds the bare form of the slot into `{ curve }` (P12), so every value a cast
    can let through — a function, a bare `6000`, a misremembered `'exponential'` — lands on `curve`,
    where `backoffDelay` matched neither `'fixed'` nor `'expo-jitter'` and fell through to the plain
    `expo` branch. It now throws `bad backoff` from `stitch()`, mirroring the
    `bad rate: …` an unparseable `throttle.rate` has thrown at construction since
    [#618](https://github.com/rejifald/StitchAPI/pull/618). Silently degrading a resilience policy is
    the one place a fallback is worse than a crash, and this one degraded in the **permissive**
    direction — a shorter wait than asked for, which is the half that hurts.

    The check sits at the fold itself, on the value it just produced, so one comparison over the
    dominant field covers every authoring form and names the offending **fragment** rather than the
    merged result. A `backoff` that sets `base`/`max` and no curve keeps the `expo-jitter` default,
    and all three curve names are unaffected in either spelling. **Not a semver break in practice**: only a value `tsc` already
    rejected can reach the throw, and its previous behaviour was to ignore what you wrote.

- **A `bigint` path parameter no longer vanishes from the URL.** `stitch({ path: '/v1/things/{id}' })`
  called with `{ params: { id: 1234567890123456789n } }` built `https://api.test/v1/things/` — the id
  simply gone, no error, no event, no drift finding. A request meant for one item silently addressed
  the **collection**; against a `DELETE` that is a different operation than the one the caller wrote.

    `expandTemplateVar` branched on `string | number | boolean`, so a bigint matched none of the
    scalar arms and fell through to the object arm, where `Object.entries(1n)` is `[]` and nothing was
    emitted. It hit **every scalar position**, not just the plain `{id}` case measured above: `{/id}`
    dropped the whole path segment (`/v1{/id}` → `/v1`), and `{+id}`, `{#id}`, `{.id}`, `{;id}`,
    `{?id}` and the `{id:4}` prefix modifier all rendered empty. Composite values were never affected
    — `[1n, 2n]` and `{ a: 1n }` route through `String()`/`stringifyLeaf` — so a bigint inside a list
    expanded correctly while the same bigint on its own disappeared, and the query builder rendered
    `?since=1234567890123456789` for a value the path builder erased.

    **The type said the same thing twice.** Path-only vars inferred as `string | number`, so the value
    was rejected at the call site as well as dropped at runtime; fixing either half alone still left
    the caller stuck. The folded `params` slot is now `string | number | bigint`, which is what
    `expandPath` has always stringified. A key named by an `input.params` schema still answers to its
    schema — widening the path-only fold does not punch through a declared shape.

    This lands on the people who had already done the right thing: parsing a 64-bit id into a `BigInt`
    is the standard repair for JSON's double-precision rounding, and handing that repaired value back
    to a path parameter was the moment it disappeared.

- **`sse.reconnect` no longer replays a stream that already finished.** ([#640](https://github.com/rejifald/StitchAPI/issues/640))
  Measured against an OpenAI-shaped completion — `data: {…}` frames with no `id:`, terminated by
  `[DONE]` — `sse: { reconnect: true }` opened the body **4×**, delivered 24 deltas where 6 were
  sent, handed the consumer `ABCDEABCDEABCDEABCDE` instead of `ABCDE`, and still ended
  `done(ok: true)`. Against a real model API those are three billed completions nobody asked for.
  It is now 1 open, 6 deltas, `ABCDE`. Two independent defects composed:

    **Resumability was read off surface _capability_, before a single frame arrived.** The engine
    asked "does this surface expose `resumeToken`/`applyResume`", and `sseSurface` exposes both
    unconditionally — so an id-less body qualified as resumable. At reopen there was no token to
    replay, the `applyResume` guard was skipped, and the request went out with **no
    `Last-Event-ID`**: a request for the entire completion, not a resumption. Capability is now
    necessary but not sufficient; the reconnect decision tests the token the stream actually
    produced, since whether a body carries `id:` is a property of the body, not of the surface.

    **A clean close was treated as a drop.** `'closed'` and `'error'` shared one path, so a body
    that simply ran out spent the whole reconnect budget — which is why a stream that never failed
    was reopened at all, and why a well-behaved id-carrying feed also opened 4× and replayed its
    last id each time. A body that ends is now the stream _finishing_: it finalizes with what it
    collected. Only a transport failure mid-flight reconnects, which is what
    [the docs](https://stitchapi.dev/docs/reference/surfaces#resumable-sse--ssereconnect) always
    said this option did.

    `sse: true` is shorthand for `{ reconnect: true }`, so the shorthand carried both and is fixed
    by the same change. Genuine drops are untouched: a mid-flight failure on an id-carrying feed
    still reconnects and still sends `Last-Event-ID`, server `retry:` pacing still wins over the
    fallback delay, and a drop before any delta was delivered still reconnects — nothing has been
    handed over yet, so there is nothing to duplicate. The surfaces reference now states both
    requirements, which it never did: the feed must emit `id:`, and the body must have dropped.

- **An uncontended fleet-wide acquire no longer reports a phantom wait.** Under
  [ADR 0025](docs/adr/0025-fleet-wide-concurrency-by-lease.md) leases, `acquire` set
  `waited = clock.now() - blockStart` whenever that difference was non-zero — but `blockStart` is
  read before the `lease` call, which is a store round-trip. A grant on the **first** attempt
  blocked nobody, yet any round-trip that happened to straddle a millisecond reported `waited: 1`
  and fired a spurious `progress.throttled` event, telling an operator their limiter was pacing
  calls it never paced. The gate is now "did it have to poll" — `takeLease` reports whether it went
  round the loop — so store latency alone can never register, which is what the code's own comment
  ("not incidental store or scheduling time") always claimed. A genuine block still measures its
  real elapsed wait, unchanged.

    This also fixes a flaky test: `store.spec.ts`'s `expect(first.waited).toBe(0)` failed whenever
    the machine was slow enough, reliably under `--coverage` (it blocked CI on #632 twice). The new
    pin injects 5ms of store latency into an uncontended grant, so it fails deterministically
    against the old behaviour instead of once every few runs.

    It fixes a **second** flake in that file too, which #635 recorded as having a different root
    cause: the shared-rate-budget test failed ~1 run in 12 with `expected 2 to be 1` because the
    phantom wait also reaches the path where no `concurrency` is configured at all — `takeLease`
    no-ops there, but is still `async`, so the microtask hop alone could straddle a millisecond.
    The **unpaced** caller reported `waited: 1` and fired a `throttled` event beside the paced
    caller's 1000. Shared rate budgeting was never implicated: `reserve` grants the first caller
    `at`, so its `wait` is never positive. That path is now pinned deterministically too.

- **`Surface.resumeRetry` takes the canonical duration form too: its return widens to
  `number | string`.** The sibling of the `SurfaceOutcome.after` fix below, found by sweeping the
  surface under the new [P17](docs/CONTRACT.md#p17--one-canonical-duration-form)/[P25](docs/CONTRACT.md#p25--one-canonical-size-form)
  widening clause and its **R9** gate (see _Notes_). `resumeRetry` reads the server-suggested
  reconnect backoff off an emitted `delta`; it was raw ms only, and — like `after` before #609 — the
  value was read straight into the reconnect wait, so a token returned through a cast reached
  `setTimeout`, coerced to `NaN`, and fired immediately, collapsing the wait to ~0 with no error.
  It is now parsed by the shared `parseDuration`, and an unparseable token falls through to the
  configured `reconnect.delay` rather than to zero. Verified by reverting the parse with the tests
  in place: 6ms elapsed against a 110ms floor.

    Widening only, so per [P19](docs/CONTRACT.md#p19--the-alias-obligation-is-scoped-to-the-ga-channel)
    it is non-breaking and needs no alias — every existing surface returning raw ms is unaffected.

- **A store-backed throttle no longer bursts when a process joins mid-window.**
  ([ADR 0023](docs/adr/0023-a-rate-is-a-minimum-spacing.md) Decision 2) The
  distributed limiter schedules the Nth slot of a window at `windowStart + (N-1)·spacing`. A
  process starting partway through a window claims slots whose scheduled times have **already
  elapsed**, and each was granted the moment it was claimed — draining every elapsed slot in one
  tick. The burst scaled with the **window**, not the declared rate: `'2/s'` and `'120/m'` both
  declare a 500ms spacing, but the one-minute window left up to 119 elapsed slots to drain against
  one for `'2/s'`. Measured mid-window, `'120/m'` granted five concurrent calls at the same
  instant where `'2/s'` granted two.

    This is a cold start — a rolling deploy, an autoscaler adding a worker, a lambda — not the
    sustained-overload window edge `createStoreThrottle` already documented as approximate. The
    slot schedule is now a **floor** applied on top of the same per-key pacing cursor the
    in-process limiter keeps, so each grant is `max(now, cursor, slot)`: the shared counter still
    allocates slots across the fleet, while no single process grants two calls closer than
    `spacing`. A store-backed `'2/s'` and `'120/m'` now produce byte-identical grant sequences,
    matching the in-process limiter. No config changes; a throttle that was silently bursting
    starts pacing.

    **The bound is per-process, and that is the limit of what it buys a fleet.** A slot already in
    the past paces nobody, so while the stale prefix lasts only each worker's own cursor holds the
    line and N workers emit at N× the declared rate — what the cursor converts is the _shape_, from
    one worker draining every unclaimed slot into a single instant, to N calls per instant spread
    at `spacing`. Starting at a window boundary (or once the slots catch up) the fleet does pace on
    one shared budget. Both halves are pinned in `store.spec.ts`; closing the mid-window case needs
    the atomic GCRA cell `store.ts` names and defers, and the residue assertion is written to fail
    when it lands.

- **`throttle.rate: '0/s'` is rejected instead of parsing to "no limit at all".**
  ([ADR 0023](docs/adr/0023-a-rate-is-a-minimum-spacing.md), _Found while
  implementing_) `parseRate`'s count was `\d+`, so a zero count parsed and produced a spacing of `per / 0` =
  `Infinity`. Under an injected `Clock` that reads as "block everything" — which is what the test
  suite saw — but `setTimeout` clamps any delay past 2^31−1 to **1ms**, so on the system clock the
  second acquire was granted after ~1ms and the throttle was unlimited, announced only by a Node
  `TimeoutOverflowWarning` on every wait. A config that validated clean, tested as a hard stop,
  and shipped as no limit.

    The count is now `[1-9]\d*` and `'0/s'` throws `bad rate` at stitch/seam **construction**,
    where every other malformed rate already threw. There is no safe reading being taken away: a
    limiter is not how you stop calling a stitch.

- **The same net now covers NESTED envelopes — `circuit`, `retry`, `wire`, and the rest — so a
  nested rename is mechanical too.** The guard below was scoped to a config's top-level keys on the
  reasoning that an envelope is checked against its _declared_ `AtLeastOne<CircuitOptions>` and so
  stays a fresh literal. It does not. `const C` is inferred from the **whole** config object, so
  excess-property checking is suppressed at every depth, not just at the root:

    ```ts
    // before: typechecked, and `totalNonsense` was silently dropped
    stitch({
        path: '/x',
        circuit: { failures: 1, cooldown: '30s', totalNonsense: 1 },
    });
    // before: typechecked — the `retry.backoff` rename in rc.5 had no compile-time net either
    stitch({
        path: '/x',
        retry: { attempts: 2, backoff: { curve: 'fixed', baseMs: 100 } },
    });
    ```

    Both are now type errors naming the key **and the envelope it was misspelled against**, so the
    report reads against the right vocabulary:

    ```
    `totalNonsense` is not a CircuitOptions slot — check the spelling
    ```

    **Why this looked closed for so long.** The type test pinning nested coverage carried _no valid
    sibling_, so weak-type detection did the rejecting and got the credit — the exact attribution
    error the same test file's preamble warns about. Add one valid sibling and the rejection
    vanished. The two assertions are rewritten, and every new one carries a sibling.

    **The first thing it caught was a stale key this repository had already shipped past.**
    `halfOpenAfter`'s removal (above) was written around this hole — it reasoned that a leftover
    spelling could not be flagged statically, so it added a construction-time warning instead. It
    then left a stale `circuit: { …, halfOpenAfter: '60s' }` behind in `circuit-breaker.spec.ts`,
    where nothing was watching: not the type tests, not the suite, not review. Turning the guard on
    failed the build on it within one CI run. That is the whole argument for the guard, made
    against real history rather than a constructed example — the class is not that people misspell
    keys, it is that a **removal** leaves working-looking call sites behind and nothing says so.

    Covers 17 slots across two levels: the 13 envelopes plus `wire.multipart`, `retry.backoff`,
    `stream.buffer`, `sse.reconnect`. The second level is not hypothetical — rc.5's
    `baseMs`→`base` / `maxMs`→`max` renames happened there.

    **The table is explicit, not derived, and that is a correctness requirement rather than a cost
    tweak.** A walk derived from `StitchConfig[K]` descends into `output`, whose `SchemaLike` Zod arm
    is the phantom `{ _output: unknown }`; a real `z.object(…)` carries dozens of keys beyond it, so
    every config that validates anything would fail with `safeParse` reported as a misspelling. The
    same holds for each pluggable seam (`adapter` / `store` / `clock` / `trace` / `kind` / `auth`),
    where an unknown key _is_ the extension point. Unknown-key rejection is correct only for closed
    house vocabularies.

    **Cost, measured** on core's 625-call-site typecheck project: +7% types, +12% instantiations,
    and no measurable check-time change (~1.1s either way). The docs' twoslash build, every
    downstream package, and the runtime bundle are unchanged. One subtlety is load-bearing: the
    guard maps over the table's **fixed** key set rather than `keyof C & keyof NestedEnvelopes`.
    Keying it on `C` makes the parameter type depend on the type being inferred, which costs
    contextual typing for callback slots (`adapter`, `transform`) and produces spurious
    `implicitly has an 'any' type` errors.

    **Still fail-open through `extends`,** at every depth — that is the cross-layer `Layers` axis,
    and a fragment's own declaration site is where its spelling is checked. The `NoUnknownKeys`
    JSDoc previously claimed an _inline_ fragment was covered by excess-property checking; it is
    not, for the same reason the root is not, and the limit is now recorded honestly and pinned.

    The ratchet grew a **second rule** to keep the table from going stale by omission: it walks every
    root bag rule 1 found (`StitchConfig` plus the four that intersect it) and every interface the
    table covers, failing on any field naming a house `…Options` / `…Schemas` bag with no entry, at
    any depth. The rest of the class was **swept rather than assumed** — every other
    envelope-consuming surface takes its bag as a direct annotation and keeps ordinary
    excess-property checking, verified by probe (with a valid sibling present) on `seam`, `serve`,
    `createTrace`, `mockAdapter`, `oauth2`, `serveStdio`, `deltaFrame`, and `@stitchapi/shell`'s
    nested `buffer` envelope.

- **An unknown config key is now a type error, so removing or renaming a slot has a compile-time
  safety net.** The authoring overloads infer `const C` from the config argument — that is what lets
  `InputOf` read RFC 6570 path vars off the literal — and that same inference SUPPRESSES TypeScript's
  excess-property check: the literal is compared against a `C` just inferred from it, so no property
  is ever "excess", and the `C extends Partial<StitchConfig>` constraint is then verified by ordinary
  assignability, which ignores freshness. A misspelled or dead slot therefore typechecked and was
  silently dropped at runtime:

    ```ts
    // before: typechecked, and the timeout was never applied
    stitch({ path: '/things', timeut: 500 });
    ```

    It is now a type error naming the key, via the same `ConfigError` brand as the sibling guards, so
    the message lands on the offending property instead of collapsing the config to `never`:

    ```
    `timeut` is not a StitchConfig slot — check the spelling
    ```

    The decisive consequence is for **migrations**: folding a flat slot into an envelope (ADR 0022's
    `acceptStatus` → `verdict.accept`) previously left every call site that still authored the old
    spelling typechecking. `#591` hit exactly this — 2 files found by typechecking, 30 by running the
    suite. Such a rename is now mechanical, and `tsc` finds the stragglers.

    Applied to **every** authoring surface that reaches an option bag through an inferred generic
    (P16), swept for rather than patched case by case: `stitch`, `Seam.stitch`, `Seam.graphql`,
    `graphql`, `download`, `sse`, `stream` and the `.bind(...)` binders (against `StitchConfig`);
    `llm` (against `LlmOptions`); and `postmessage`'s `request` / `emit` / `events` (against
    `RequestOptions` / `EmitOptions` / `EventsOptions`). Each names its own bag in the message, so
    `reply` — a `RequestOptions` member — is correctly rejected on `emit` and `events`.

    Deliberately **cheaper** than the sibling guards — one `keyof` and one `Exclude` per call site,
    with no `Layers` walk — because unknown keys are a per-layer spelling concern, and an inline
    `extends` fragment or a nested envelope is checked against its declared type, so it keeps
    ordinary excess-property checking.

    Ruled out by the same sweep, verified rather than assumed: the framework hooks
    (`react`/`vue`/`solid`/`svelte`/`angular`/`swr`/`query-core`/`rtk-query`/`vercel-ai`) bind their
    generic to the **stitch argument**, not to an option literal, and their options bags are
    non-generic — so those keep ordinary excess-property checking already. `all()`'s named-bag form
    takes caller-chosen keys, so it has no fixed vocabulary to misspell.

    **Partial cover that already existed, and why the tests look the way they do:** these bags are
    all-optional, so TypeScript's weak-type detection rejects a literal sharing _no_ property with
    the target. That is only partial — add one valid sibling key and the unknown one rides along. So
    every `expectError` in the type tests carries a valid sibling; without one the rejection would be
    attributable to weak-type detection rather than to the guard.

    **Stronger than excess-property checking** in one respect, and the reason the net holds
    repo-wide: EPC only fires on a fresh literal, so a config hoisted into a `const` escapes it
    entirely. Reading `keyof C` sees the binding's inferred type, so the hoisted spelling is rejected
    too.

    **Known limits,** both pinned as tsd expectations alongside the loose
    `string | Partial<StitchConfig>` escape hatch, which is unchanged:

    - An unknown key inside an `extends` fragment that is a `const` binding _and_ carries at least
      one real slot is not reported — the binding is not fresh, so EPC does not fire, and the real
      slot satisfies weak-type detection. A bound fragment of only unknown keys is still rejected.
    - `Stitch.with(partial)` is the one surface left **unguarded**, and the exception is structural
      rather than a matter of taste. It is the only signature whose return type reads `keyof P`, and
      `keyof (P & NoUnknownKeys<P, …>)` does not reduce to `keyof P` while `P` is unresolved.
      Intersecting the parameter rewrites `RelaxKeys<TIn, keyof P>` into a deferred union that the
      declaration rollup emits differently than source, so the published `Stitch` stops being
      structurally identical to the source one and every `S extends Stitch<unknown>` constraint in
      the package breaks. The F-bounded spelling that would keep the parameter bare is a circular
      constraint (TS2313). Guarding it would degrade the public `Stitch` type for every consumer,
      which costs more than the hole it closes.

    The class is now held closed by a **ratchet** rather than by having been swept once —
    `pnpm check:unknown-keys` ([`scripts/check-unknown-keys.mjs`](scripts/check-unknown-keys.mjs)),
    wired into `verify.yml` and `lefthook` pre-push beside `check:contract`. Every
    generic-inferred option bag must either carry the guard or be listed in
    `scripts/unknown-keys.baseline.json` **with a reason** — a bare `TODO` fails the gate — so a new
    unguarded surface forces a deliberate decision instead of passing by omission. It currently sees
    17 guarded surfaces and 4 baselined exceptions (`postmessage`'s three `channel()`-local impls,
    whose consumer-facing declarations are guarded, and `Stitch.with`). Documented in
    [docs/CONTRACT.md §7](docs/CONTRACT.md).

- **BREAKING (types only) — `llm()` is now generic, so it infers its call argument.** Its parameter
  was non-generic on purpose: excess-property checking was the only thing rejecting the removed
  `maxTokens` spelling (P4), and keeping it meant giving up `const C` inference entirely. Now that
  `NoUnknownKeys` supplies the rejection, the trade is gone and `llm` gets what every other surface
  has — `InputOf<C>` call-argument inference:

    ```ts
    const chat = llm({
        provider: anthropic,
        url: 'https://llm.example.com/{version}/messages',
    });
    chat(); // now a type error: the path template requires `params`
    chat({ params: { version: 'v1' } });
    ```

    Runtime behaviour is unchanged — the stitch is byte-identical. Breaking only in that a call
    argument that was previously the loose `StitchInput` is now checked against the config's `input`
    schemas and path template, so a call site that was silently under-specified now fails to compile.
    `llm.stitch` and `llm.bind(...).stitch` inherit it; the binder moves to the loose-impl-plus-cast
    idiom `download` already uses, because a generic impl cannot be checked against a member of its
    own guarded shape.

- **The config guards now read the composed config, so `extends` counts.** `wire.multipart` and
  `document`/`operationName` are gated on an enabler — a multipart body, the graphql surface — and
  both guards previously inspected only the config LITERAL. A config that inherited its enabler
  through `extends` was therefore rejected outright:

    ```ts
    const gqlBase = { kind: graphqlSurface, baseUrl };
    stitch({ extends: [gqlBase], document: `query { me { id } }` }); // was a type error
    ```

    Both now walk the same layer list `InputOf` uses (`Layers`), so an enabler from any layer
    counts. There is deliberately one flattener rather than a second copy — a private one would
    drift on depth budget and fragment normalisation, and the guards would disagree with `InputOf`
    about what a config is.

    The scan is **existential** ("is the enabler set anywhere?") rather than last-wins. Resolving an
    override chain at the type level is easy to get subtly wrong, and the two failure directions are
    not symmetric: a false positive rejects working code loudly, a false negative merely fails to
    catch something the compiler never caught before. Scanning existentially can only produce the
    second.

    Two limits are inherited from `Layers` and unchanged: an `extends` list widened to `Frag[]` (a
    `const` binding without `as const`) and the P7 single-fragment spelling (`extends: frag`) both
    read as empty, because the flattener destructures a tuple. `InputOf` has read `extends` that way
    since #76. Both are pinned as tsd expectations.

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

### Security

- **Five Dependabot alerts closed by `pnpm.overrides` — `fast-uri` and `ip-address`.** Both are
  transitive-only: no manifest in the workspace names either one, so Dependabot could not open a
  PR for them — a transitive fix needs a parent release that pulls the patched version, and none
  had shipped. The override block is the mechanism here, and it already carried a `fast-uri` floor
  from the previous round of this same advisory.

    **`fast-uri`** ([GHSA-7p8r-x3mc-p8w7](https://github.com/advisories/GHSA-7p8r-x3mc-p8w7) —
    host confusion via a backslash authority introducer, CVSS 7.5). Both majors were in the tree
    and both were vulnerable. The existing `<3.1.4` floor becomes `<3.1.5`, and a second entry
    covers the 4.x line (`>=4.0.0 <4.1.2` → `^4.1.2`), mirroring the two-entry `brace-expansion`
    shape already in the block. The 3.x copy is reachable at runtime through `ajv` →
    `@modelcontextprotocol/sdk` and `@stitchapi/sandbox`; the 4.x copy only through fastify, which
    is a dev dependency.

    **`ip-address`** (three alerts, one High and two Medium: leading-zero octets decoded as decimal
    where resolvers decode them as octal; a CIDR suffix suppressing special-use classification; and
    IPv4-mapped/NAT64 IPv6 misclassification). All three are one failure wearing three hats — an
    address parser disagreeing with the resolver about what an address _means_, which is precisely
    what makes an SSRF allowlist lie. A single floor at `<10.3.1` clears the set. Runtime, via
    `express-rate-limit` → `@modelcontextprotocol/sdk`.

    `pnpm audit` reports no known vulnerabilities after the bump.

### Notes

- **The duration/size rule is now stated over the value rather than the slot, and gated.**
  [P17](docs/CONTRACT.md#p17--one-canonical-duration-form) and
  [P25](docs/CONTRACT.md#p25--one-canonical-size-form) already required every consumer-authored
  duration and byte cap to accept `number | string`, but framed it as a property of end-user
  **config** — which is why the 2026-07 sweep skipped `SurfaceOutcome.after` (authored by a
  `Surface`, not an end user) and it shipped taking raw ms. Both rules now read forwards as one
  test — **if a position accepts a duration or a byte size at all, it must also accept a
  `string`** — over all four authoring positions: an `*Options` field, a tuple element of a
  positional shorthand, a function parameter, and the return value of a hook you implement on an
  extension seam. The complement is stated just as firmly: a duration or size the library
  **produces** stays a bare ms/byte `number`, and a `chars` code-unit cap must **not** grow a
  string arm, since a size token on decoded text is a category error.

    Lint **R9** in `check:contract` enforces both directions, and both halves of the rule are held:
    R9 pins the type, while the requirement that the value actually reach `parseDuration`/`parseBytes`
    is pinned by test — a widened type over an unparsed read site is the silent-collapse bug, which is
    worse than never widening at all. Nothing else on the published surface needed changing.

- **`sse`, `stream`, and `postmessage` were checked in the same pass and deliberately left
  alone.** `sse` and `stream` have no `buildRequest`, so their `method` is genuinely honoured;
  their `wire.response` is inert, but because the _engine_ sets `stream: true` and the adapter
  returns the live body before consulting it — one rule about the streaming path that applies
  to any surface with a `stream` hook, third-party ones included, rather than a per-surface
  override. `postmessage` ignores most HTTP knobs, but through a custom `execute` that replaces
  the transport outright; the honest fix there is narrowing what its option types admit, which
  is a larger separable change. See ADR 0005 Decision 1's addendum.

- **GraphQL file uploads remain unsupported, now explicitly.** `wire.body: 'multipart'` was
  the closest thing to a spelling for them, and it never worked: a GraphQL upload is not the
  JSON body multipart-encoded, it is the
  [GraphQL multipart request spec](https://github.com/jaydenseric/graphql-multipart-request-spec)'s
  separate `operations` / `map` / file-part envelope, which the surface does not implement.
  Rejecting the flag keeps the gap honest instead of silently sending JSON. To upload
  alongside a GraphQL API today, POST the file with a plain
  `stitch({ wire: { body: 'multipart' } })` and pass the resulting handle as a GraphQL
  variable. See ADR 0005 Decision 1's addendum for why this was deferred and what implementing
  it would take; relaxing the guard later is non-breaking.

- **The bundle-size gate's externals now match what the build actually emits.**
  ([#709](https://github.com/rejifald/StitchAPI/issues/709)) `check:size` externalised `node:*`, but
  `tsup` strips the prefix — `lib/` emits bare `from"fs"` — so the pattern matched nothing, and
  measuring a builtin-using entry failed outright with `Could not resolve "fs"`. No measured or
  advertised number moves; the fix is repo tooling only.

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
