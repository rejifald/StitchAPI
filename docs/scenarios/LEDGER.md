# Scenario ledger

Real-world API integration scenarios researched by the `/loop` scenario pass. One row
per scenario, so later iterations don't re-cover ground.

**Flow per scenario:** web research → capture in `docs/scenarios/<slug>.md` → a subagent
proves (or fails to prove) it with **runnable offline code** under
`docs/scenarios/proofs/<slug>/` → then either a published page at
`apps/docs/content/docs/scenarios/<slug>.mdx` **or** an issue draft in
`docs/scenarios/issue-drafts/<slug>.md`.

Issue drafts are **not filed** — they accumulate here for review when the loop stops.

| #   | Scenario                                              | Slug                            | Verdict                                                                                                              | Outcome                                                                                                                                                                                        |
| --- | ----------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | OAuth2 rotating refresh tokens under concurrent calls | `oauth2-refresh-token-rotation` | achievable with user code                                                                                            | [page shipped](../../apps/docs/content/docs/scenarios/oauth2-refresh-token-rotation.mdx) + 1 issue draft (`params` footgun)                                                                    |
| 2   | Cost-based rate limits reported in the response body  | `cost-based-rate-limits`        | achievable with user code                                                                                            | [page shipped](../../apps/docs/content/docs/scenarios/cost-based-rate-limits.mdx) + 1 issue draft (3 body-verdict footguns)                                                                    |
| 3   | Batch writes with per-item partial failure            | `batch-partial-failure`         | achievable with user code                                                                                            | [page shipped](../../apps/docs/content/docs/scenarios/batch-partial-failure.mdx) + 1 issue draft (`paginate` silent data loss)                                                                 |
| 4   | Async job triangle — submit, poll, download           | `async-job-polling`             | achievable with user code                                                                                            | [page shipped](../../apps/docs/content/docs/scenarios/async-job-polling.mdx) + 1 issue draft (clock + diagnostic side effects)                                                                 |
| 5   | A stream that fails after 800 tokens                  | `mid-stream-failure`            | achievable with user code (resumable feeds: **achievable outright**)                                                 | [page shipped](../../apps/docs/content/docs/scenarios/mid-stream-failure.mdx) + 1 issue draft (**SSE reconnect replays completed streams — a bug in #622**)                                    |
| 6   | ETag revalidation and the bodyless 304                | `conditional-requests-304`      | achievable with user code                                                                                            | [page shipped](../../apps/docs/content/docs/scenarios/conditional-requests-304.mdx) + 1 issue draft (`cache` cannot revalidate; surfaces can't see the principal)                              |
| 7   | Multipart upload and the mandatory abort              | `multipart-upload`              | achievable — but the library is a **bystander for the cleanup**                                                      | [page shipped](../../apps/docs/content/docs/scenarios/multipart-upload.mdx) + 1 issue draft (no compensation seam)                                                                             |
| 8   | Receiving a signed webhook                            | `webhook-receipt`               | **split — receipt OUT OF SCOPE by design, reaction in scope**                                                        | [page shipped](../../apps/docs/content/docs/scenarios/webhook-receipt.mdx) + 1 issue draft (`void call()` drops work)                                                                          |
| 9   | One tenant's revoked token, everyone's outage         | `multi-tenant-blast-radius`     | achievable with user code (~3 strings per tenant)                                                                    | [page shipped](../../apps/docs/content/docs/scenarios/multi-tenant-blast-radius.mdx) + 1 issue draft (**resilience has no tenancy axis — 9/9 blast radius**)                                   |
| 10  | Failing over to the backup provider                   | `provider-failover`             | achievable with user code (~30 lines of routing)                                                                     | [page shipped](../../apps/docs/content/docs/scenarios/provider-failover.mdx) + 1 issue draft (`any()` priced as a hedge; per-call header broadcast)                                            |
| 11  | Pagination over a live collection                     | `unstable-pagination`           | achievable with user code — keyset in 4 lines; detection is yours                                                    | [page shipped](../../apps/docs/content/docs/scenarios/unstable-pagination.mdx) + 1 issue draft (dedupe in `items` **causes** data loss; 4 endings share one break)                             |
| 12  | A canary rollout of a response-shape change           | `intermittent-drift`            | achievable with user code — 9 declarative lines + ~84 for the rate                                                   | [page shipped](../../apps/docs/content/docs/scenarios/intermittent-drift.mdx) + 1 issue draft (a `coerced` finding can't grade the coercion; nullable has no level)                            |
| 13  | The export that eats the heap                         | `large-response-memory`         | achievable with user code — one seam, ~75 lines, **NDJSON only**                                                     | [page shipped](../../apps/docs/content/docs/scenarios/large-response-memory.mdx) + 1 issue draft (**`.stream()` is not memory-bounded; `decode: 'json'` buffers**)                             |
| 14  | The signature that expired in your own queue          | `expiring-signatures`           | **ACHIEVABLE** — the queue/retry halves need no user code at all                                                     | [page shipped](../../apps/docs/content/docs/scenarios/expiring-signatures.mdx) + 1 issue draft (SigV4 ignores the injected clock; a skew 403 opens the breaker)                                |
| 15  | The charge you can't confirm                          | `unconfirmed-write`             | achievable with user code — 43 lines, 19 of them the recovery                                                        | [page shipped](../../apps/docs/content/docs/scenarios/unconfirmed-write.mdx) + 1 issue draft (**`idempotency: true` double-charged a re-driven job; `retry` silences the warning**)            |
| 16  | One list, a hundred follow-up calls                   | `n-plus-one-fanout`             | achievable with user code — ~8 lines, the partial-failure branch                                                     | [page shipped](../../apps/docs/content/docs/scenarios/n-plus-one-fanout.mdx) + 1 issue draft (a coalesced failure is not shared; a `store` un-pools `pool: 'host'`)                            |
| 17  | The deprecation you never saw                         | `deprecation-headers`           | achievable with user code — 3 seams, ~112 lines, **0 config keys**                                                   | [page shipped](../../apps/docs/content/docs/scenarios/deprecation-headers.mdx) + 1 issue draft (hooks can rewrite the call; seam-level `kind` is a compile error that works)                   |
| 18  | The agent picks the arguments                         | `agent-holds-the-tool`          | **credential boundary held** (30 scans, 0 hits); argument boundary is the user's — safe exposure = 3 seams, 47 lines | [page shipped](../../apps/docs/content/docs/scenarios/agent-holds-the-tool.mdx) + 2 issue drafts (unfiltered MCP error channel leaks a query credential; input schemas check but never filter) |
| 19  | The mock that passed for six months                   | `stale-fixture`                 | **split** — resilience/streams test perfectly offline; the scenario's own direction is **invisible** offline         | [page shipped](../../apps/docs/content/docs/scenarios/stale-fixture.mdx) + 1 issue draft (**`manualClock` covers 6 of 12 time-driven features; 2 bugs in the testing kit**)                    |

## Open issue drafts

Eight are filed (#640–#645, #648, #650). The rest are unfiled — review when the loop stops.

| Draft                                                                                                                                                               | Severity                                        | Ask                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`oauth2-params-rotation-footgun`](issue-drafts/oauth2-params-rotation-footgun.md)                                                                                  | high                                            | `params` can express a rotating grant that succeeds once, then revokes the account                                                                                                                                                                       |
| [`body-verdict-footguns`](issue-drafts/body-verdict-footguns.md)                                                                                                    | high                                            | `verdict.flag` returns `ok: true` on an error envelope; `.safe()` drops `RateLimitError.body`; `backoff` fn silently vanishes                                                                                                                            |
| [`paginate-silent-data-loss`](issue-drafts/paginate-silent-data-loss.md) **→ [#644](https://github.com/rejifald/StitchAPI/issues/644)**                             | **high — a bug, not a footgun**                 | a zero-item page ends `paginate` with `ok: true` and the remainder unfetched; "finished" and "gave up" are the same value                                                                                                                                |
| [`clock-and-diagnostic-side-effects`](issue-drafts/clock-and-diagnostic-side-effects.md)                                                                            | **high ×2**                                     | `timeout.total` is wall-clock while its sleeps use the injected clock, so a `manualClock` test of it passes vacuously; `.inspect()`/`.report()` re-issue the request and duplicated a job submit                                                         |
| [`sse-reconnect-replays-completed-streams`](issue-drafts/sse-reconnect-replays-completed-streams.md) **→ [#640](https://github.com/rejifald/StitchAPI/issues/640)** | **highest — a bug in freshly shipped #622**     | `sse: { reconnect: true }` reopens a **completed** id-less stream 4× and delivers `ABCDEABCDEABCDEABCDE` to the consumer, ending `ok: true`                                                                                                              |
| [`cache-cannot-revalidate`](issue-drafts/cache-cannot-revalidate.md)                                                                                                | medium (capability gap)                         | `cache` is a value store so an ETag can never reach it; a surface can't see the bound principal, which is what makes a hand-written ETag store leak across credentials                                                                                   |
| [`no-compensation-seam`](issue-drafts/no-compensation-seam.md)                                                                                                      | medium (capability gap, sharp edges)            | nothing runs on failure, so a mandatory cleanup call can't be expressed — and the two natural ways to hand-write it (`.safe()` on the abort; cleanup inside `Surface.execute`) are silently wrong                                                        |
| [`void-call-drops-work`](issue-drafts/void-call-drops-work.md)                                                                                                      | **high**                                        | `void call(input)` makes **0 HTTP calls and 0 errors** — the idiomatic fire-and-forget spelling silently drops the work; plus `backoff.base` clamped by `max` without warning                                                                            |
| [`resilience-has-no-tenancy`](issue-drafts/resilience-has-no-tenancy.md) **→ [#641](https://github.com/rejifald/StitchAPI/issues/641)**                             | **highest production impact**                   | `throttle`/`circuit` have no `tenancy`, so one customer's revoked token failed **9 of 9** healthy customers and never self-healed. Fix is one option name on two interfaces, on an existing axis                                                         |
| [`any-is-priced-as-a-hedge`](issue-drafts/any-is-priced-as-a-hedge.md) **→ [#643](https://github.com/rejifald/StitchAPI/issues/643)**                               | **high** (a credential leak + silent spend)     | a per-call `authorization` for the primary **arrived at the backup verbatim**; and `any()` is documented as failover while calling every member on every call — 20 requests for 10 answers                                                               |
| [`paginate-cannot-report-a-partial-run`](issue-drafts/paginate-cannot-report-a-partial-run.md) **→ [#645](https://github.com/rejifald/StitchAPI/issues/645)**       | **high** (companion to the draft above)         | deduping in `items` — the standard mitigation — emptied a page and **lost 6 rows**; four different endings share one `break` and one successful result                                                                                                   |
| [`drift-cannot-grade-a-coercion`](issue-drafts/drift-cannot-grade-a-coercion.md)                                                                                    | medium-high (flagship, mostly working)          | a `coerced` finding is byte-identical for `"12345"→12345` and `"abc"→0`; and "nullable = warn, value intact" has no spelling — `.nullable()` makes a rollout invisible                                                                                   |
| [`streaming-is-not-memory-bounded`](issue-drafts/streaming-is-not-memory-bounded.md)                                                                                | **high — two located bugs**                     | `engine.ts:1443` retains every chunk so `.stream()` measures the same as `await`; and `decode: 'json'` buffers the array it streams, tripping its own cap at 37k rows                                                                                    |
| [`sigv4-ignores-the-injected-clock`](issue-drafts/sigv4-ignores-the-injected-clock.md)                                                                              | medium (+ a third clock instance)               | SigV4 signs with `new Date()` so skew is untestable on a virtual clock; a skew 403 opens the dependency's breaker; `onRequest` runs after signing                                                                                                        |
| [`idempotency-default-is-not-restart-safe`](issue-drafts/idempotency-default-is-not-restart-safe.md) **→ [#642](https://github.com/rejifald/StitchAPI/issues/642)** | **highest stakes — measured in charges**        | `idempotency: true` minted a new key on a re-driven job → **8 charges for 6 intended payments**; and adding `retry`, which the warning itself advises, silences the warning                                                                              |
| [`coalescing-does-not-share-failures`](issue-drafts/coalescing-does-not-share-failures.md)                                                                          | medium (+ a strong positive)                    | in-flight coalescing genuinely works (100 calls / 30 ids → 30 requests), but a coalesced FAILURE releases every joiner — 100 requests for one 404ing id; and a `store` silently un-pools `pool: 'host'` concurrency                                      |
| [`hooks-can-rewrite-the-call`](issue-drafts/hooks-can-rewrite-the-call.md)                                                                                          | medium-high (a docs/behaviour mismatch)         | the hooks guide says hooks never change what a stitch returns; mutating `ctx.res.status` turned a vendor 200 into a thrown 503. Plus the definitive accessor→headers table                                                                               |
| [`mcp-error-channel-leaks-a-query-credential`](issue-drafts/mcp-error-channel-leaks-a-query-credential.md)                                                          | medium-high (**scoped** leak + a real positive) | the MCP error channel renders `Error.message` unfiltered, so a DNS failure under `apiKey({ in: 'query' })` put the key in the model's context. **The credential boundary itself held: 30 scans, 0 hits.** Plus a rename bypasses the registry allow-list |
| [`input-schemas-check-but-never-filter`](issue-drafts/input-schemas-check-but-never-filter.md) **→ [#648](https://github.com/rejifald/StitchAPI/issues/648)**       | **high** (not MCP-specific)                     | `validateInput` discards the parsed value while `validateOutput` returns it, so a stripping schema — the Zod/Valibot/ArkType default — does not strip. Declaring a strict schema to constrain an untrusted caller silently does nothing                  |
| [`testing-kit-clock-gaps-and-two-bugs`](issue-drafts/testing-kit-clock-gaps-and-two-bugs.md) **→ [#650](https://github.com/rejifald/StitchAPI/issues/650)**         | **high — 2 bugs + a soundness table**           | `manualClock` drives 6 of 12 time-driven features (OAuth2 expiry is NEW and undocumented); `stubStitch().safe()` throws on a sync throw; `mockAdapter` violates the library's own `abort` rule                                                           |

> **Triage note — two, in this order.**
>
> 1. [`resilience-has-no-tenancy`](issue-drafts/resilience-has-no-tenancy.md) — highest
>    production impact. One customer's revoked token failed **9 of 9** healthy customers, and the
>    outage does not self-heal. Not a bug (everything behaves as documented) but the composition
>    has a 100% blast radius, and the fix is one option name on two interfaces, on an axis
>    `CacheOptions`/`OAuth2Options` already carry.
> 2. [`sse-reconnect-replays-completed-streams`](issue-drafts/sse-reconnect-replays-completed-streams.md) —
>    a genuine bug in code that shipped in **#622**. It delivers duplicated content to end users
>    on a stream that never failed, and the run ends `ok: true`.

### Patterns across the pass

**0. One stale docs reference, verified and left unfixed.**
`apps/docs/content/docs/concepts/run-identity.mdx:26` and `:33` describe "each step of a
`pipe()`" and label a diagram `a pipe(): step 1`. `stitchapi/pipe` exports exactly
`all, any, linked, race` — the construct described is `linked()`. A two-line docs edit, left
out of the scenario commits to keep them scoped.

**1. Achievable, but only off the documented path — 7 for 7** (scenario 8 is the exception that
proves the rule: it is out of scope by design, and the docs already say so). Every in-scope
scenario was solvable,
and in none of them did the built-in the docs point at carry it. `throttle` sends you to
`delegate` (status-keyed, wrong); `paginate` looks like the loop and is a trap twice over;
`retry.respect` is inert on the body path; `cache` cannot revalidate. **A custom `Surface` has
now been part of the answer in six of seven** — `interpret` in 2, 4 and 7, `execute` in 5 and
6, both in 3. Scenario 7 is the exception that sharpens the point: a surface lifted the ETag,
but nothing in the library touched the requirement the scenario existed for.
Worth deciding: is this signposting — an "if the signal is in the body, write a surface"
pointer from each guide — or are the built-ins scoped one notch too narrow?

**2. `verdictOf` is mandatory by convention, not by construction.** Every surface written in
this pass had to remember to compose it first, and the one proof that omitted it returned a
404 as `ok: true`. A correctness requirement currently enforced by documentation.

**2a. The buffered and streaming paths disagree about `interpret`, undocumented.** It runs for
every response including non-2xx on a buffered stitch (measured on `[200, 304, 404]`), and
**zero times** on a streaming one. Anyone reasoning from one path to the other will be wrong.

**2b. SIX time-driven features ignore the injected clock — settled deliberately in scenario 19.**
`manualClock` drives `retry` backoff, `throttle` (rate and concurrency), `circuit.cooldown`, the
per-attempt `timeout` and `Retry-After`. It does **not** drive `timeout.total`, `cache.ttl`, the
`memoryStore` TTL beneath it, event `at`/`done.elapsed`, **OAuth2 token expiry** or SigV4. ADR
0010 §4 documents **four** as deliberate; **SigV4 and OAuth2 expiry are documented nowhere**, and
`auth.ts` has no clock plumbing at all. Measured cost: a `timeout: { total: 1000 }` call survived
**2700 virtual ms** and returned `ok: true`. Superseded note below —

**2b (superseded). THREE time-driven features ignore the injected clock** — `timeout.total` (4), `cache.ttl`
(6) and **SigV4 signing** (14) all read wall-clock while their neighbours use `clock`. Three
point fixes are worth less than one audit plus a line in the testing guide.

**2f. `verdict.flag`'s absent-path rule has produced a silent success FOUR times** — a THROTTLED
envelope returned as data (2), `flag: 'UnprocessedItems'` inert because arrays are truthy (11),
a `RequestTimeTooSkewed` 403 swallowed (14), and an `idempotency_key_in_use` 409 swallowed
(15). Each time the fix was ~6 lines of
`Surface.interpret`. An absent flag meaning "no signal" is defensible; it being the _quiet_
answer four times running is the pattern. **This is now the single most-repeated finding of
the pass.**

**2b-bis. The buffered and streaming paths disagree about six things, all silently.** Across
scenarios 5 and 13: `retry` inert, `interpret` never called, `pick` never called, `transform`
never called, `output` validates but doesn't transform, and `stream({ kind })` drops the
surface. The engine already warns about one ignored slot (an undrawable upload-progress bar
emits an `info` event) — these six get nothing. A single "this config slot does nothing on a
stream" diagnostic would cover the class.

**2c. `paginate`'s `items.length === 0` break has now cost data in three separate scenarios**
(3, 4 and 11) — a zero-progress batch round, a drifted page mid-collection, and a deduper doing
its job. It is one line (`engine.ts:984`) and it is the single most expensive default found in
this pass.

**2d. `.report()` / `.inspect()` are fresh probes — four sightings now** (4, 7, 11, 12). In
scenario 12 `.report()` called immediately after a drifting call reported **zero** findings,
because the probe hit a clean response, _and_ it added a tick to the rate's denominator. The
name says "tell me about that run"; the behaviour is "make another one".

**2e. `trace` + `ctx.spanId` is the one place cross-call state is the design, not a leak.**
Scenarios 7, 9 and 11 all wanted per-call or cross-call state and found closures that leak or
no slot at all. Scenario 12 found the answer: a `TraceSink` sees every event of every call and
`spanId` collapses them per call. Worth pointing at from the guides that need it.

**3. My pre-verification hypotheses were wrong in every single scenario.** Usually about which
primitive would carry the solution — and twice (9, 10) wrong _optimistically_. Scenario 11 was
the first wrong about a matter of **fact**: it had offset drift's causation backwards (insert
→ skip, delete → duplicate; it is the reverse), and would have shipped a page teaching it wrong.
That is the strongest argument for the executable-proof bar:
a docs-and-source audit would have shipped four wrong pages.
