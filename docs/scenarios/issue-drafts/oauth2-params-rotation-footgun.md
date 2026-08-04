# Issue draft — `params` lets you configure a rotating refresh grant that works once, then revokes the account

**Status:** DRAFT — not filed. Raised by the scenario pass on 2026-08-04.
**Scenario:** [`oauth2-refresh-token-rotation`](../oauth2-refresh-token-rotation.md)
**Suggested template:** bug_report.yml · **Suggested labels:** `auth`, `footgun`, `docs`

> The scenario itself came out **achievable** (a custom `AuthStrategy` does it — proven by
> `docs/scenarios/proofs/oauth2-refresh-token-rotation/c5`/`c6`), so no escalation was needed
> for achievability. This draft is a _separate_ finding surfaced by the same verification: a
> silent-failure path that the current docs actively point readers toward.

## Summary

`OAuth2Options.params` merges arbitrary fields into the token-request body and can override
`grant_type` (`packages/core/src/auth.ts:393`, merged at `:511-518`). That makes this compile,
typecheck, and **succeed on the first call**:

```ts
oauth2({
    tokenUrl,
    clientId: env('ID'),
    clientSecret: env('SECRET'),
    params: { grant_type: 'refresh_token', refresh_token: storedRefreshToken },
});
```

But `oauth2()` reads only `access_token` and `expires_in` from the token response
(`auth.ts:549-568`) — the vault entry is exactly `{ token, expiresAt }`. A **rotated**
`refresh_token` in that response is silently discarded.

Against a provider that rotates (Atlassian, Asana — RFC 6819 §5.2.2.3 replay detection), the
second redemption therefore presents the **already-consumed** token. That is not a failed
request: the provider treats it as token theft and **revokes the entire token family**. The
connected account is dead until the user re-authorizes in a browser.

## Why this is worth fixing rather than documenting away

The failure has every property that makes a footgun expensive:

- **No signal at authoring time.** No type error, no runtime warning, no lint.
- **No signal on first use.** Redemption #1 returns 200 and the call succeeds.
- **The docs point at it.** [`guides/auth/oauth2.mdx:78-82`](../../../apps/docs/content/docs/guides/auth/oauth2.mdx)
  says `params` "merges arbitrary fields into the token-request body (e.g. `resource`, or a
  custom `grant_type`)" — naming a custom `grant_type` as an intended use, with no caveat.
- **The blast radius is the account, not the request.**

## Reproduction

Measured, offline, no network:

```bash
pnpm exec tsx docs/scenarios/proofs/oauth2-refresh-token-rotation/c4-params-escape-hatch.ts
```

Observed (C4a): redemption #1 sends `RT-0`, provider rotates to `RT-1`, vault stores only
`{token, expiresAt}`. Redemption #2 sends **`RT-0` again** ⇒ 1 replay ⇒ family revoked ⇒ the
call throws. `RT-1` never appears on the wire.

The proof also closes off the obvious workaround. A `params` **getter** (legal — an object with
a getter satisfies `Record<string, string>` and `Object.assign` invokes it per request) plus a
capturing adapter does rotate correctly in one process (C4b/C4c: 11 redemptions, 0 replays).
It still revokes the family across two workers (C4d), and it **cannot be repaired**, because a
getter must return synchronously while every `StitchStore` read is async — C4e measures
`[object Promise]` arriving at the token endpoint.

## Options (in increasing order of work)

1. **Docs-only.** Add an explicit "not for rotating refresh tokens" warning to the `params`
   paragraph and to the `oauth2` reference. Cheapest; leaves the silent-failure path in place.
2. **Fail loudly.** Throw at strategy construction when `params.grant_type === 'refresh_token'`,
   pointing at the custom-strategy path. Turns a revoked account into a startup error. Narrow,
   but only catches the literal spelling.
3. **Preserve the rotated token.** When the token response carries a `refresh_token`, persist it
   to the vault alongside the access token. Small change, and it makes a correct
   `refresh_token` grant expressible — but only meaningful together with (4).
4. **A first-class rotating grant.** `oauth2({ grant: 'refresh_token', … })` that rotates,
   persists write-before-use, and coordinates redemption per account across workers. This is
   the real fix and the largest; it needs a cross-process lock the store does not currently
   offer (see the companion note below).

## Companion finding (separate, smaller)

`StitchStore` is `get`/`set`/`increment`/`close` with no compare-and-set and no blocking wait
(`types.ts:1965-1976`). A mutex can be built from `increment(key, ttl) === 1` — proven in
`c6-cross-process-lock.ts`, 3 workers × 10 callers ⇒ 1 redemption — but its correctness depends
on `increment` being atomic **across processes**, while the store contract only specifies
atomicity _within_ a process (`testing.ts:160-162`). Either the contract should be tightened for
backends that can honor it, or a lock primitive should be offered directly.

## Also worth a docs correction

[`guides/auth/oauth2.mdx:50-52`](../../../apps/docs/content/docs/guides/auth/oauth2.mdx) —
"one token serves them all — across stitches and across workers" is true for _sharing_ a token
once a write has landed, but not for _coordinating the fetch_. Measured: two cold workers on a
shared `store` + `key` fire one token request **each** (`c3-two-workers-shared-store.ts`); the
count scales with workers, not callers. Harmless for `client_credentials` (a wasted request);
fatal under rotation.
