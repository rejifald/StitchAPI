# Scenario: OAuth2 rotating refresh tokens under concurrent calls

**Researched:** 2026-08-04 · **Status:** VERIFIED — achievable with user code · page shipped
**Slug:** `oauth2-refresh-token-rotation`

**Verification:** 7 proof scripts, run offline, in
[`proofs/oauth2-refresh-token-rotation/`](proofs/oauth2-refresh-token-rotation/). Published
page: [`scenarios/oauth2-refresh-token-rotation.mdx`](../../apps/docs/content/docs/scenarios/oauth2-refresh-token-rotation.mdx).
Separate finding escalated to a draft:
[`issue-drafts/oauth2-params-rotation-footgun.md`](issue-drafts/oauth2-params-rotation-footgun.md).

| Claim                                                     | Verdict               | Measured                                                  |
| --------------------------------------------------------- | --------------------- | --------------------------------------------------------- |
| C1 — 20 concurrent cold callers, one `oauth2()` stitch    | PASS                  | 1 token request, 1 distinct bearer                        |
| C2 — 20 concurrent 401s on a cached token                 | PASS, with a boundary | simultaneous ⇒ 1 refresh; staggered 8ms ⇒ **10**          |
| C3 — 2 workers sharing `store` + `key`, cold              | capability ABSENT     | **2** token requests; scales with workers, not callers    |
| C4 — `oauth2()` doing rotating `grant_type=refresh_token` | FAIL                  | redemption #2 replays the consumed token ⇒ family revoked |
| C5 — custom `AuthStrategy` doing rotation + single-flight | PASS                  | 1 redemption, 0 replays, **79 lines**                     |
| C6 — store-backed cross-process lock                      | PASS                  | 3 workers × 10 callers ⇒ 1 redemption, **+42 lines**      |
| C7 — `cookieSession` as a richer seam                     | refuted               | hook receives only `{ ok, status }`                       |

**Hypotheses that were wrong.** Two of the pre-verification guesses below did not survive:

- "`oauth2()` is `client_credentials`, so rotation is simply out of scope" — half wrong, and
  the wrong half matters. `params` _can_ override `grant_type`, and the first redemption
  genuinely **succeeds**. It is not rejected or unsupported; it works once, then kills the
  account. That is worse than unsupported, and is why the issue draft exists.
- "`params` is static so a rotated value has no path back" — right conclusion, wrong mechanism.
  A getter satisfies `Record<string, string>` and is invoked per request, so the hack rotates
  correctly in one process. It still dies across two workers, and cannot be repaired: a getter
  must return synchronously while every `StitchStore` read is async.

---

## The use case

A backend integrates a third-party SaaS API on behalf of each of its users — Atlassian
(Jira/Confluence), Asana, Xero, QuickBooks, Slack, Google. The integration holds a
long-lived **refresh token** per connected account and exchanges it for a short-lived
access token as needed (`authorization_code` grant, then `grant_type=refresh_token`).

The workload is ordinary: a sync job, a webhook handler, and a user-facing request path
all call the same vendor API for the same connected account, concurrently, from more than
one worker process.

## Why it is not straightforward

Two properties collide.

**1. The refresh token is single-use and rotates.** Modern providers implement
[RFC 6819 §5.2.2.3](https://datatracker.ietf.org/doc/html/rfc6819#section-5.2.2.3) refresh
token replay detection: redeeming a refresh token returns _a new one_ and invalidates the
old. Presenting an already-redeemed refresh token is treated as evidence of theft — so the
provider does not merely reject that one call, it **revokes the entire token family**. The
user is silently disconnected and must re-authorize through the browser.

**2. Expiry is discovered concurrently.** N in-flight requests all hit `401` at the same
instant, or all read the same "expires in 12 seconds" cached token. Each independently
decides to refresh. The first redemption succeeds and rotates; every other redemption
presents a consumed token and trips replay detection.

The failure is therefore **not** "one request fails and retries." It is "the integration
loses the account," and it happens precisely under load, which is when it is hardest to
reproduce and most expensive.

Three further wrinkles make the naive fixes insufficient:

- **A mutex is not enough if it is in-process.** Two workers, two pods, or a serverless
  fan-out each hold their own lock. The correct scope of mutual exclusion is _the connected
  account_, which spans processes.
- **The rotated token must be durably persisted before it is used.** If worker A redeems,
  writes the new refresh token to the database, and crashes between the HTTP response and
  the commit, the stored token is now the consumed one — the account is dead on next
  refresh. The write must land before the old token is considered spent.
- **Retry makes it worse.** A generic "retry on 401" wrapper turns one replay into several,
  which is exactly the signal providers read as token theft.

## Evidence this bites real projects

- **OpenAI Codex** — [`openai/codex#10332`](https://github.com/openai/codex/issues/10332):
  "refresh token was already used" when multiple app-server instances run concurrently.
- **MCP TypeScript SDK** — [`modelcontextprotocol/typescript-sdk#1760`](https://github.com/modelcontextprotocol/typescript-sdk/issues/1760):
  a race in `auth()` invalidates the refresh token when rotation is on.
- **better-auth** — [GHSA-392p-2q2v-4372](https://github.com/better-auth/better-auth/security/advisories/GHSA-392p-2q2v-4372)
  (CVE-2026-53517): concurrent redemption _forks the token family_, because the provider's
  read → validate → revoke → mint sequence is non-atomic.
- **oauth2-proxy** — [`oauth2-proxy#1992`](https://github.com/oauth2-proxy/oauth2-proxy/issues/1992):
  refresh session handling has a race condition.
- **Nango** — [_How to handle concurrency with OAuth token refreshes_](https://nango.dev/blog/concurrency-with-oauth-token-refreshes/):
  names Atlassian and Asana as rotating providers where parallel 401s trip replay detection.

Note the pattern: these are not application bugs by careless teams. They are races found in
_auth libraries and platforms_ — the layer whose whole job is this.

## The common solutions, and what each costs

| Approach                                            | What it is                                                                                                    | Where it breaks                                                                                                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Refresh-on-401, no coordination**                 | Interceptor catches `401`, refreshes, replays the request. The default in most axios/fetch wrapper tutorials. | The baseline bug. N concurrent 401s ⇒ N redemptions ⇒ family revoked.                                                                                                                                                    |
| **In-process single-flight / promise memo**         | Keep one in-flight refresh promise per account; concurrent callers await it.                                  | Correct and cheap for **one** process. Silently insufficient the moment there are two workers — and it _looks_ fixed in dev, where there is only one.                                                                    |
| **Distributed lock (Redis `SETNX`, advisory lock)** | Serialize refresh across workers. Losers wait and re-read the token.                                          | Works, but is now a distributed-systems problem: lock TTL vs refresh latency, crash-while-holding, fencing tokens, and a hard dependency on Redis in the request path.                                                   |
| **Proactive refresh with a skew**                   | Refresh N seconds before expiry rather than on `401`.                                                         | Shrinks the window, does not close it — the skew boundary is itself a moment every worker crosses together. Best used _with_ coordination, not instead of it.                                                            |
| **Grace period / accept the old token briefly**     | Provider-side: the consumed token stays valid for a few seconds.                                              | Not the client's to choose. Auth0, Okta and others offer it; Atlassian and Asana notably do not — and [better-auth#8512](https://github.com/better-auth/better-auth/issues/8512) shows it is still a live design debate. |
| **Dedicated refresh worker**                        | One process owns refresh; everyone else reads the cached access token.                                        | Clean and genuinely correct. Costs an extra deployable, and a cold access token now blocks on a queue round-trip.                                                                                                        |

**Summary of the state of the art:** there is no one-liner. The honest minimum is
_coordination scoped to the account and spanning processes_, plus _durable persistence of
the rotated token before the old one is treated as spent_. Everything cheaper is a
narrower race, not a fixed one.

---

## What to verify against StitchAPI

Read of the working tree (`packages/core/src/auth.ts`, ahead of the published docs bundle)
before verification — **hypotheses, to be confirmed or refuted by running code**:

- `oauth2()` performs the **`client_credentials`** grant (`auth.ts:465`). That grant has no
  refresh token at all, so rotation may simply be out of scope for it.
- There **is** an in-process `singleFlight` helper (`auth.ts:432`) keyed per token key, and
  a shared `store` is documented to make one token serve many workers.
- `params?: Record<string, string>` (`auth.ts:393`) can override `grant_type` — but it is a
  **static** record, so a _rotated_ refresh token returned in the response has no path back
  into the next token request. This is the suspected structural gap.
- `cookieSession` exposes `RefreshResult` / `CookieSessionRefreshOptions` — possibly a
  richer seam for carrying rotating state.

**Claims to test with runnable offline code:**

1. **C1** — N concurrent calls needing a token fire exactly **one** token request (in-process).
2. **C2** — a `401` mid-flight triggers exactly **one** refresh + retry, not N.
3. **C3** — two independently constructed stitches sharing a `store` (a two-worker
   simulation) fire **one** token request between them, or two.
4. **C4** — `oauth2()` can run `grant_type=refresh_token` where the response returns a
   **new** `refresh_token` that must be used for the _next_ refresh.
5. **C5** — if C4 fails, can a custom `AuthStrategy` implement rotation + single-flight, and
   how much user code does that take? (Decides "achievable but not simple" vs "not achievable".)
