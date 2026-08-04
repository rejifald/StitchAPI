# Changelog

All notable changes to the `stitchapi` core library (and the in-repo peer-dep
packages) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Dates are ISO-8601 and derived from the git history; entries without a published
npm release are grouped under the in-development version that introduced them.

## [Unreleased]

### Changed

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

### Fixed

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

### Notes

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
