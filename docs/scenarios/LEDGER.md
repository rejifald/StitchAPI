# Scenario ledger

Real-world API integration scenarios researched by the `/loop` scenario pass. One row
per scenario, so later iterations don't re-cover ground.

**Flow per scenario:** web research → capture in `docs/scenarios/<slug>.md` → a subagent
proves (or fails to prove) it with **runnable offline code** under
`docs/scenarios/proofs/<slug>/` → then either a published page at
`apps/docs/content/docs/scenarios/<slug>.mdx` **or** an issue draft in
`docs/scenarios/issue-drafts/<slug>.md`.

Issue drafts are **not filed** — they accumulate here for review when the loop stops.

| #   | Scenario                                              | Slug                            | Verdict                   | Outcome                                                                                                                        |
| --- | ----------------------------------------------------- | ------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | OAuth2 rotating refresh tokens under concurrent calls | `oauth2-refresh-token-rotation` | achievable with user code | [page shipped](../../apps/docs/content/docs/scenarios/oauth2-refresh-token-rotation.mdx) + 1 issue draft (`params` footgun)    |
| 2   | Cost-based rate limits reported in the response body  | `cost-based-rate-limits`        | achievable with user code | [page shipped](../../apps/docs/content/docs/scenarios/cost-based-rate-limits.mdx) + 1 issue draft (3 body-verdict footguns)    |
| 3   | Batch writes with per-item partial failure            | `batch-partial-failure`         | achievable with user code | [page shipped](../../apps/docs/content/docs/scenarios/batch-partial-failure.mdx) + 1 issue draft (`paginate` silent data loss) |

## Open issue drafts

Not filed — review these when the loop stops.

| Draft                                                                              | Severity                        | Ask                                                                                                                           |
| ---------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [`oauth2-params-rotation-footgun`](issue-drafts/oauth2-params-rotation-footgun.md) | high                            | `params` can express a rotating grant that succeeds once, then revokes the account                                            |
| [`body-verdict-footguns`](issue-drafts/body-verdict-footguns.md)                   | high                            | `verdict.flag` returns `ok: true` on an error envelope; `.safe()` drops `RateLimitError.body`; `backoff` fn silently vanishes |
| [`paginate-silent-data-loss`](issue-drafts/paginate-silent-data-loss.md)           | **high — a bug, not a footgun** | a zero-item page ends `paginate` with `ok: true` and the remainder unfetched; "finished" and "gave up" are the same value     |

### Pattern across the pass

All three scenarios came out **achievable, but only off the documented path** — the built-in
that the docs point at missed, and a less-obvious seam carried it. Worth deciding whether that
is a signposting problem (three pages of "if X, reach for Y") or a sign the built-ins are
scoped one notch too narrow.
