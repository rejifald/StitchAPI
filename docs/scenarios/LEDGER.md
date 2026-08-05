# Scenario ledger

Real-world API integration scenarios researched by the `/loop` scenario pass. One row
per scenario, so later iterations don't re-cover ground.

**Flow per scenario:** web research → capture in `docs/scenarios/<slug>.md` → a subagent
proves (or fails to prove) it with **runnable offline code** under
`docs/scenarios/proofs/<slug>/` → then either a published page at
`apps/docs/content/docs/scenarios/<slug>.mdx` **or** an issue draft in
`docs/scenarios/issue-drafts/<slug>.md`.

Issue drafts are **not filed** — they accumulate here for review when the loop stops.

| #   | Scenario                                              | Slug                            | Verdict                                                              | Outcome                                                                                                                                                           |
| --- | ----------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | OAuth2 rotating refresh tokens under concurrent calls | `oauth2-refresh-token-rotation` | achievable with user code                                            | [page shipped](../../apps/docs/content/docs/scenarios/oauth2-refresh-token-rotation.mdx) + 1 issue draft (`params` footgun)                                       |
| 2   | Cost-based rate limits reported in the response body  | `cost-based-rate-limits`        | achievable with user code                                            | [page shipped](../../apps/docs/content/docs/scenarios/cost-based-rate-limits.mdx) + 1 issue draft (3 body-verdict footguns)                                       |
| 3   | Batch writes with per-item partial failure            | `batch-partial-failure`         | achievable with user code                                            | [page shipped](../../apps/docs/content/docs/scenarios/batch-partial-failure.mdx) + 1 issue draft (`paginate` silent data loss)                                    |
| 4   | Async job triangle — submit, poll, download           | `async-job-polling`             | achievable with user code                                            | [page shipped](../../apps/docs/content/docs/scenarios/async-job-polling.mdx) + 1 issue draft (clock + diagnostic side effects)                                    |
| 5   | A stream that fails after 800 tokens                  | `mid-stream-failure`            | achievable with user code (resumable feeds: **achievable outright**) | [page shipped](../../apps/docs/content/docs/scenarios/mid-stream-failure.mdx) + 1 issue draft (**SSE reconnect replays completed streams — a bug in #622**)       |
| 6   | ETag revalidation and the bodyless 304                | `conditional-requests-304`      | achievable with user code                                            | [page shipped](../../apps/docs/content/docs/scenarios/conditional-requests-304.mdx) + 1 issue draft (`cache` cannot revalidate; surfaces can't see the principal) |
| 7   | Multipart upload and the mandatory abort              | `multipart-upload`              | achievable — but the library is a **bystander for the cleanup**      | [page shipped](../../apps/docs/content/docs/scenarios/multipart-upload.mdx) + 1 issue draft (no compensation seam)                                                |
| 8   | Receiving a signed webhook                            | `webhook-receipt`               | **split — receipt OUT OF SCOPE by design, reaction in scope**        | [page shipped](../../apps/docs/content/docs/scenarios/webhook-receipt.mdx) + 1 issue draft (`void call()` drops work)                                             |
| 9   | One tenant's revoked token, everyone's outage         | `multi-tenant-blast-radius`     | achievable with user code (~3 strings per tenant)                    | [page shipped](../../apps/docs/content/docs/scenarios/multi-tenant-blast-radius.mdx) + 1 issue draft (**resilience has no tenancy axis — 9/9 blast radius**)      |
| 10  | Failing over to the backup provider                   | `provider-failover`             | achievable with user code (~30 lines of routing)                     | [page shipped](../../apps/docs/content/docs/scenarios/provider-failover.mdx) + 1 issue draft (`any()` priced as a hedge; per-call header broadcast)               |

## Open issue drafts

Not filed — review these when the loop stops.

| Draft                                                                                                | Severity                                    | Ask                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`oauth2-params-rotation-footgun`](issue-drafts/oauth2-params-rotation-footgun.md)                   | high                                        | `params` can express a rotating grant that succeeds once, then revokes the account                                                                                                                |
| [`body-verdict-footguns`](issue-drafts/body-verdict-footguns.md)                                     | high                                        | `verdict.flag` returns `ok: true` on an error envelope; `.safe()` drops `RateLimitError.body`; `backoff` fn silently vanishes                                                                     |
| [`paginate-silent-data-loss`](issue-drafts/paginate-silent-data-loss.md)                             | **high — a bug, not a footgun**             | a zero-item page ends `paginate` with `ok: true` and the remainder unfetched; "finished" and "gave up" are the same value                                                                         |
| [`clock-and-diagnostic-side-effects`](issue-drafts/clock-and-diagnostic-side-effects.md)             | **high ×2**                                 | `timeout.total` is wall-clock while its sleeps use the injected clock, so a `manualClock` test of it passes vacuously; `.inspect()`/`.report()` re-issue the request and duplicated a job submit  |
| [`sse-reconnect-replays-completed-streams`](issue-drafts/sse-reconnect-replays-completed-streams.md) | **highest — a bug in freshly shipped #622** | `sse: { reconnect: true }` reopens a **completed** id-less stream 4× and delivers `ABCDEABCDEABCDEABCDE` to the consumer, ending `ok: true`                                                       |
| [`cache-cannot-revalidate`](issue-drafts/cache-cannot-revalidate.md)                                 | medium (capability gap)                     | `cache` is a value store so an ETag can never reach it; a surface can't see the bound principal, which is what makes a hand-written ETag store leak across credentials                            |
| [`no-compensation-seam`](issue-drafts/no-compensation-seam.md)                                       | medium (capability gap, sharp edges)        | nothing runs on failure, so a mandatory cleanup call can't be expressed — and the two natural ways to hand-write it (`.safe()` on the abort; cleanup inside `Surface.execute`) are silently wrong |
| [`void-call-drops-work`](issue-drafts/void-call-drops-work.md)                                       | **high**                                    | `void call(input)` makes **0 HTTP calls and 0 errors** — the idiomatic fire-and-forget spelling silently drops the work; plus `backoff.base` clamped by `max` without warning                     |
| [`resilience-has-no-tenancy`](issue-drafts/resilience-has-no-tenancy.md)                             | **highest production impact**               | `throttle`/`circuit` have no `tenancy`, so one customer's revoked token failed **9 of 9** healthy customers and never self-healed. Fix is one option name on two interfaces, on an existing axis  |
| [`any-is-priced-as-a-hedge`](issue-drafts/any-is-priced-as-a-hedge.md)                               | **high** (a credential leak + silent spend) | a per-call `authorization` for the primary **arrived at the backup verbatim**; and `any()` is documented as failover while calling every member on every call — 20 requests for 10 answers        |

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

**2b. Two time-driven features ignore the injected clock** — `timeout.total` and `cache.ttl`
both read wall-clock while their neighbours use `clock`. Two point fixes are less valuable
than one audit plus a line in the testing guide.

**3. My pre-verification hypotheses were wrong in every single scenario** — usually about
which primitive would carry it. That is the strongest argument for the executable-proof bar:
a docs-and-source audit would have shipped four wrong pages.
