# ADR 0024 — A fleet paces on one cursor: `StitchStore.reserve`, the optional GCRA cell

- **Status:** Accepted and implemented (2026-08-04). Closes the residue [ADR 0023](./0023-a-rate-is-a-minimum-spacing.md) Decision 2 recorded and deferred, and resolves its open question 1's remaining half — option **(b)**, now that (a) has shipped and shown exactly what it cannot reach. Extends the pluggable store ([DESIGN.md §13](../DESIGN.md)) and rides [ADR 0010](./0010-injectable-clock.md)'s injectable `Clock`.
- **Date:** 2026-08-04
- **Tags:** resilience, throttle, store, api-surface, contract-extension, P16, P18, P19, P21

> [!NOTE]
>
> A counter can allocate **positions**. Turning a position into a **time** needs an
> origin, and every origin a caller can compute is either per-process (so N workers
> pace independently) or fixed to a window (so a worker joining mid-window inherits
> slots that already elapsed). This adds the one primitive that needs neither:
> `reserve` — atomically `at = max(now, cell); cell = at + spacing`. It is
> **optional**, because an eventually-consistent backend cannot implement it and
> because `StitchStore` is a contract consumers implement.

## Context

ADR 0023 established that a rate is a minimum spacing and fixed the store-backed
limiter to honour it, then wrote down what its fix could not do:

> the cursor bounds a burst PER PROCESS, which is the limit of what it can do without
> a new store primitive: a slot already in the past paces nobody, so N workers that all
> start mid-window emit at N× the declared rate until the slots catch up with the clock.

That residue is asserted, not merely described — `store.spec.ts` pinned two workers
emitting at 2× and three at 3×, with a comment naming this ADR's arrival as the moment
the assertion should flip. It has.

### Why the counter could never get there

The shared counter is genuinely atomic, and it does allocate a distinct slot `n` to
every caller across the fleet. The problem is turning `n` into an instant, which needs
an origin — and both available origins are wrong in a different direction:

| Origin                           | Fails when                        | Symptom                                                                 |
| -------------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| The window's epoch-aligned start | a process joins mid-window        | every elapsed slot is claimable at once — the ADR 0023 cold-start burst |
| The process's own cursor         | several processes share the store | each paces itself correctly; the fleet emits N×                         |

Both were tried, in that order, and each fix exposed the other. There is no third
origin a caller can derive, because the missing information — _when did the fleet last
grant?_ — lives in no single process and in no counter.

A **cursor** needs no origin at all. It is already an instant, it carries continuously
(no window to restart at), and `max(now, cell)` resets it after idle. The only thing it
requires is that read-compute-write be indivisible, which is precisely what the store
contract did not offer.

### Why `increment` cannot be bent into one

Worth recording, because it is the cheap idea that does not work. A counter whose TTL
tracked the schedule head would behave like a cursor — but `RedisDriver` **mandates**
that `increment`'s expiry bind to the creating increment and never extend, enforced in
the Lua (`if v == 1 and ttl > 0 then PEXPIRE`), for a stated reason: _"a busy rate
window would slide forever and never reset."_ A cursor must slide; a window must not.
The same verb cannot do both, so this is a new verb rather than a new argument.

## Decision

### 1. `StitchStore.reserve` — the cell, and its exact semantics

```ts
reserve?(key: string, spacing: number, now: number, ttl?: number): Promise<number>;
```

Atomically, indivisibly across every process sharing the store:

```
at = max(now, cell ?? 0);   cell = at + spacing;   return at
```

Three details are load-bearing and each is pinned by `conformance.store`:

- **`now` is the caller's clock, not the store's.** The cursor stays deterministic under
  an injected `Clock` (ADR 0010) — the fleet fixture drives it with `manualClock` — and a
  store never needs a clock of its own. Client skew is the caller's, exactly as it
  already is for every other instant the throttle computes.
- **`ttl` refreshes on every call**, the opposite of `increment`'s creation-bound expiry,
  for the reason in the Context above. Losing the cell is always _safe_: `max(now, …)`
  restarts from the present, which is a cold start, not a burst.
- **Fractional spacing survives.** `per/count` is routinely fractional (`'3/s'` is
  333.33ms), so the Redis script returns `tostring` rather than a RESP integer, which
  truncates. A fleet that rounded each grant down would drift against the in-process
  limiter by a millisecond per call.

### 2. It is optional, and the fallback is not deprecated

Two independent reasons, either sufficient:

- **Not every backend can.** Cloudflare KV is eventually consistent and offers no atomic
  read-compute-write to build a cell from. A store without `reserve` is a first-class
  citizen and keeps the ADR 0023 counter-plus-cursor path, whose residues stay pinned in
  `store.spec.ts` against a store with the verb deliberately withheld.
- **`StitchStore` is consumer-implemented.** [P19's corollary](../CONTRACT.md#p19--the-alias-obligation-is-scoped-to-the-ga-channel)
  is explicit that a contract the consumer implements and core calls cannot carry an
  alias, so adding a **required** member is a hard break in any channel. Optional is the
  only additive shape, and [P21](../CONTRACT.md#p21--every-contract-has-an-extension-seam)
  is the rule that says the seam must stay open for exactly this kind of growth.

Selection is capability-based, never configuration: the throttle uses the cell when the
store has it. There is no flag, because there is no case where a caller with a capable
store wants the weaker pacing.

### 3. Implemented where it can be, honestly absent where it cannot

| Store                              | Mechanism                                                                |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `memoryStore`                      | one JS thread, nothing awaited between read and write                    |
| `@stitchapi/redis`                 | one Lua `EVAL`, alongside the existing `INCR` script                     |
| `@stitchapi/deno-kv`               | the compare-and-set loop `increment` already uses, with its retry policy |
| `@stitchapi/cloudflare-kv`         | **absent** — eventually consistent, no atomic primitive to build on      |
| `@stitchapi/react-native` / `expo` | **absent** — an on-device store; there is no fleet to pace               |

`vaultView` forwards the verb only when the backend has it, so a namespaced view reports
the backend's real capability rather than making every store look GCRA-capable.

## What this preserves

- Every existing config is unchanged; no API a consumer writes is touched.
- A store that does not implement `reserve` behaves exactly as it did after ADR 0023.
- `concurrency` is still in-process under a store (a distributed semaphore needs leases)
  — untouched here, and still the second place "attach a store to share the policy" is
  only partly true.

## Alternatives considered

### A. A general `compareAndSet` primitive instead of a purpose-built `reserve` — **rejected: more contract, worse operation**

The obvious general-purpose extension, and it is strictly harder to implement AND worse
to use. Every implementor would owe an atomic CAS _and_ every caller a retry loop, so a
contended cursor costs multiple round-trips where `reserve` costs one — Redis executes
the whole cell server-side. It also widens the contract far past the one operation
anybody needs: `reserve` is the complete pacing primitive, whereas `compareAndSet` is a
toolkit for building it wrongly. deno-kv is the tell — it implements `reserve` _with_ a
CAS loop internally, which is exactly where that complexity belongs.

### B. Require it on `StitchStore` rather than making it optional — **rejected: excludes a real backend, and breaks every implementor**

Cleaner-looking contract, unimplementable by Cloudflare KV, and a hard break on a
consumer-implemented interface with no alias available (P19's corollary). The cost of
optionality is one capability check in one function.

### C. Keep the counter and store the origin beside it — **rejected: two keys, a race, and it still misses**

The shape a closed PR ([#623](https://github.com/rejifald/StitchAPI/pull/623)) explored:
publish the window's first-arrival instant to the store so every worker measures slots
from the same origin. It does fix the mid-window fleet case, and it needs no new verb —
but it costs a second round-trip per acquire, it has a read-your-write race between the
publishing caller and the readers, and it still bursts for a key that goes idle _within_
a window, because slot allocation lags the clock. Strictly more machinery for strictly
less correctness than one cursor.

### D. Do nothing and document the residue — **rejected, but it was the right call once**

This is what ADR 0023 decided, and it was correct then: the residue was bounded by
process count, written down, and asserted. It stops being correct once the fix is one
optional verb whose absence changes nothing — at that point "N workers exceed the rate
you configured" is a defect with a known remedy, and a rate limiter that misses by a
factor of the fleet size is missing the point of being distributed.

## Open questions

1. **Should `conformance.store` fail a store that omits `reserve`?** No, and it does
   not — the rules are added only when the verb is present. But there is no signal
   _encouraging_ a capable backend to add it either. A report line noting "no pacing
   cell — the throttle will use its per-process fallback" would be honest without being
   a failure; deferred as reporting polish.
2. **Concurrency across the fleet is still unsolved** and is a bigger problem than this
   one: a distributed semaphore needs leases with expiry and renewal, which is a much
   larger contract extension than a cursor. Named here only so the two are not confused.
3. **Clock skew between workers** now shows up directly in the cursor: a worker whose
   clock runs fast reserves further ahead. Bounded by the skew itself and no worse than
   the existing slot schedule, but a store-side clock (Redis `TIME`) would remove it for
   backends that have one — at the cost of the deterministic `now` that makes the fleet
   fixture testable. Not attempted.
