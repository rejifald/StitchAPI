# The testing kit's clock covers half its own features — plus two bugs

**Status:** ✅ **FILED** as [#650](https://github.com/rejifald/StitchAPI/issues/650)
**Scenario:** [stale-fixture](../stale-fixture.md)
**Proofs:** `docs/scenarios/proofs/stale-fixture/` (8 scripts, 168 checks, offline)

## First, what works

Worth stating because a fix shouldn't disturb it. Resilience is **fully** testable with no vendor
and no real waiting: attempt counts assertable three ways, the whole circuit
closed→open→half-open→closed trace readable from `callCount()` as `1, 2, 2 (blocked), 3, 4`,
throttle spacing exact and self-reporting (`waited` = `500` then `1000` for `'2/s'`), backoff
curves exact at virtual `0 / 1000 / 3000`. Streams are byte-identical across five repeat runs.
That is a genuinely good testing story.

The findings below are the edges.

## 1. `manualClock` drives six time-driven features and not the other six

| Feature                       | Driven by      | Measured                                                        |
| ----------------------------- | -------------- | --------------------------------------------------------------- |
| `retry` backoff               | `manualClock`  | `advance(5000)` → 3 calls; `advance(0)` → 1, pending            |
| `throttle` rate               | `manualClock`  | `advance(3000)` → 3 calls                                       |
| `throttle` concurrency        | `manualClock`  | holder releases on virtual time                                 |
| `circuit.cooldown`            | `manualClock`  | `advance(60_000)` past a 30s cooldown → half-open probe         |
| `timeout` (per-attempt)       | `manualClock`  | `advance(2000)` past a 1s timeout → error                       |
| `Retry-After`                 | `manualClock`  | honours it — **and that is a trap**, see §2                     |
| **`timeout.total`**           | **wall clock** | a 1000ms budget survived **2700 virtual ms**, `ok: true`        |
| **`cache.ttl`**               | **wall clock** | `advance(600_000)` past a 60s TTL still served the cached entry |
| **`memoryStore` TTL**         | **wall clock** | a 1s entry survived 60,000 virtual ms                           |
| **event `at`/`done.elapsed`** | **wall clock** | `at = 1785941469178` while `clock.now() = 0`                    |
| **OAuth2 token expiry**       | **wall clock** | 600,000 virtual ms past a 60s `expires_in` refetched nothing    |
| **AWS SigV4 signing date**    | **wall clock** | `new Date()`, no `clock` option exists                          |
| `paginate`                    | no time        | nothing to drive                                                |

ADR 0010 §4 documents **four** of these as deliberate — `timeout.total`, event `at`/`done.ms`
and `memoryStore`/cache TTL — and `types.ts:1476` repeats the event one in JSDoc. **SigV4 and
OAuth2 token expiry are documented nowhere.** OAuth2 is the one worth acting on, because it is in
core and looks unintentional rather than scoped out:
`packages/core/src/auth.ts:502` is

```ts
const isFresh = (t: CachedToken | undefined): boolean =>
    !!t && (t.expiresAt === 0 || now() < t.expiresAt - skew);
```

where `now` is a module-level import. `auth.ts` contains **zero** occurrences of `clock`, and
`AuthContext` carries none — so this is not one line reaching for the wrong function, the
plumbing to do otherwise doesn't exist. "Does my client refresh the token before it expires" is a
thing people write tests for, and today that test cannot be written on a virtual clock.

**One correction to how this is usually described**, including in our own capture: `timeout.total`
does not _ignore_ the clock. The per-attempt clamp fires on virtual time
(`withTimeout(..., rt.clock)`, `engine.ts:669-674`); the wall-anchored part is the **deadline**
(`wallT0 + total`). Virtual sleeps never drain it, so the budget **resets** each attempt rather
than being ignored. On a real clock it behaves correctly — this is specifically a testing
unsoundness.

ADR 0010 also closes with _"Follow-ups (out of scope here): driving `timeout.total`, event
timestamps, and store/cache TTL off the clock, **should a concrete need arise**."_ The measured
vacuous pass is that concrete need.

**Ask:** route OAuth2 expiry through the injected clock; and put the table in the mocking guide —
an ADR section and a `types.ts` JSDoc are not where someone writing a test will look.

## 2. `Retry-After` as an HTTP-date is a trap _because_ it honours the clock

`parseRetryAfter` computes `httpDateEpoch - clock.now()` (`resilience.ts:70`), and
`manualClock()` starts at `0`. So a fixture carrying a normal dated `Retry-After` meaning "5
seconds" becomes a wait of roughly **20,000 days**.

This is the only row where doing the right thing produces the worse outcome, and it will read as
a hang rather than as a bug.

**Ask:** default `manualClock()` to a realistic epoch, or warn when a parsed `Retry-After` exceeds
some sane ceiling.

## 3. BUG — `stubStitch(...).safe()` throws on a synchronous throw

```
stub, impl throws synchronously   -> THREW boom
stub, impl rejects asynchronously -> ok=false
REAL stitch, adapter throws sync  -> ok=false / "transport boom"
```

`.safe()` is the never-throws accessor, and here it throws — diverging from both its async twin
and the real stitch. `resolve()` (`packages/core/src/test-stub.ts:59-63`) evaluates `impl(input)`
as an **argument** to `Promise.resolve`, so the throw escapes before there is a chain to catch it:

```ts
Promise.resolve(
    typeof impl === 'function' ? (impl as ...)(input) : impl,
);
```

`.stream()` on the same stub is unaffected. A one-line fix (`async` wrapper, or move the call
inside a `.then`).

## 4. BUG — `mockAdapter` fails the library's own adapter contract

Running `verifyAdapterContract` against `mockAdapter` passes 8 of 9 rules and violates
**`abort: a pre-aborted signal rejects`** — _"adapter resolved although the signal was already
aborted"_.

Cause: `req.signal` is consulted only inside the `delay` branch
(`packages/core/src/test-mock.ts:188-189`), so any route **without** a `delay` ignores an aborted
signal that every real transport honours. Any test of cancellation behaviour against a
delay-less route is therefore testing the opposite of production.

## 5. Smaller, same area

- **`mockAdapter` validates almost nothing about a fixture.** It served nonsense statuses
  (`999`, `-1`, `0`, fractional) and bodies of type `Date`, `Map`, class instance, `undefined`,
  `function`, `bigint` and Symbol-keyed, all verbatim through the full engine. The sharp consequence: a
  fixture built from `new Invoice(...)` gives the caller `data.total === 42` from a **prototype
  getter**, where the same object over a JSON wire is `{"id":"inv_1"}` and `data.total` is
  `undefined`. A green test for code that cannot work. A `wireShape` opt-in would cost little.
- **`stubStitch` runs none of the `input` schemas.** `{ params: { id: 42 } }` against
  `z.string()`: the real stitch errors with no request sent; the stub resolves. There is no slot
  to give it the contract — `StubStitchOptions.config` is `Partial<RedactedStitchConfig>`, which
  carries no schema.
- **Retry backoff delays are absent from the event stream.** `progress{phase:"retry"}` carries
  `waited: undefined`, while the throttle (`engine.ts:641`) and reconnect (`:1486`) paths set it.
- **`done.elapsed` is wall-clock**, so it reads `0` after any virtual time — the kit's own
  duration field cannot see the kit's own clock.
- **`stubStitch(...).with()` returns a new stub with a fresh spy**, so the parent's `callCount()`
  reads `0` after a bound call.
- **The circuit breaker has no distinct error name** — a plain `StitchError` with message
  `"circuit open"`, so assertions have to match on the string.

## Not asked for here

The scenario's own question — detecting that a _fixture_ has gone stale while the _vendor_ moved —
is a capability gap rather than a bug, and ADR 0015 removed snapshot drift deliberately ("a single
snapshot is one observation"). Recording it separately.

---

_Found by an automated scenario pass. Line references verified against `main` at the time of
filing. Runnable proof scripts live under `docs/scenarios/proofs/stale-fixture/` on the branch
`claude/api-integration-scenarios-436a38`._
