# Proofs — OAuth2 rotating refresh tokens under concurrency

Runnable evidence for the claims in
[`../../oauth2-refresh-token-rotation.md`](../../oauth2-refresh-token-rotation.md).

Every script is standalone, offline, and deterministic about the thing it measures: it injects a
fake in-memory OAuth2 provider through StitchAPI's `adapter` seams (`stitch({ adapter })` for the
resource server, `oauth2({ adapter })` for the token endpoint) and **counts token-endpoint calls
exactly**. Nothing touches the network.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/oauth2-refresh-token-rotation/c1-cold-start-single-flight.ts

# all of them
for f in docs/scenarios/proofs/oauth2-refresh-token-rotation/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path,
so they test the working tree, not the published bundle.

## What each script establishes

| Script                           | Question                                                    | Measured                                                                      |
| -------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `c1-cold-start-single-flight.ts` | 20 concurrent cold callers through one `oauth2()` stitch    | **1** token request                                                           |
| `c2-concurrent-401-refresh.ts`   | 20 concurrent 401s on a cached token                        | **1** refresh when the 401s are simultaneous; **10** when they land 8ms apart |
| `c3-two-workers-shared-store.ts` | two workers sharing `store` + `key`, both cold, concurrent  | **2** token requests — the store is a cache, not a lock                       |
| `c4-params-escape-hatch.ts`      | can `oauth2()` do `grant_type=refresh_token` with rotation? | **No.** Redemption #2 replays the consumed token and the family is revoked    |
| `c5-custom-auth-strategy.ts`     | can a user write it as a custom `AuthStrategy`?             | **Yes**, 79 lines, 0 replays                                                  |
| `c6-cross-process-lock.ts`       | can user code close C3's cross-process gap?                 | **Yes**, +42 lines on top of C5, using `increment()` + `set(key, undefined)`  |
| `c7-cookiesession-hooks.ts`      | is `cookieSession.onRefresh` a seam for rotating state?     | **No** — the hook gets `{ ok, status }`; the login body never reaches it      |

## Files

- `fake-provider.ts` — the Atlassian/Asana-style provider: single-use rotating refresh token,
  replay detection, token-family revocation. Exposes both endpoints as `Adapter`s and records
  every call.
- `harness.ts` — `check` / `note` / `heading` / `finish`. No test framework.
- `rotating-refresh-strategy.ts` — **user code** for C5: rotation + durable persistence +
  in-process single-flight.
- `locked-refresh-strategy.ts` — **user code** for C6: the above plus a store-backed lock scoped
  to the connected account.

## Reading the numbers honestly

- **C2b's "10 refreshes" is not flaky-looking noise, it is the shape of the thing.** `singleFlight`
  coalesces callers that arrive _while a redemption is in flight_. Callers whose 401 lands after
  that window start a new one. The exact count depends on the stagger (8ms) versus the token-request
  latency (10ms); the assertions only claim `1 < refreshes < N`.
- **C6 shares one `memoryStore` in one process.** It proves the lock _logic_ is expressible with the
  primitives StitchAPI exposes. It does not prove `memoryStore` is a distributed lock —
  `verifyStoreContract` only requires `increment` to be atomic _within_ a process
  (`packages/core/src/testing.ts:160`). A real deployment needs a backend whose increment is atomic
  across processes (Redis `INCR`).
- **C4b/C4c show a hack that works, in one process only.** A `params` getter plus a response-capturing
  `adapter` does rotate correctly when redemptions are serialised. C4d shows it revoking the account
  across two workers, and C4e shows why it cannot be fixed: a `params` value must be produced
  synchronously, and every `StitchStore` read is async.
