# ADR 0025 — Fleet-wide `concurrency` by lease: a slot you hold, not a number you decrement

- **Status:** Accepted and implemented (2026-08-05). Closes the second half of "attach a store to share the policy", which [ADR 0024](./0024-the-fleet-wide-pacing-cell.md) open question 2 named as the larger remaining gap. Extends the pluggable store ([DESIGN.md §13](../DESIGN.md)); the slot-free streaming rule is [ADR 0005](./0005-surfaces-and-the-authoring-model.md) Decision 12.
- **Date:** 2026-08-05
- **Tags:** resilience, throttle, store, api-surface, contract-extension, P11, P19, P21

> [!NOTE]
>
> Rate and concurrency are not the same shape of problem. A rate is a **schedule** —
> a pure function of time, which is why one shared cursor settles it. Concurrency is
> **ownership**: a slot is held for an interval nobody can predict, by a process that
> might die still holding it. A counter cannot express that, because the decrement
> lives in a process that may never run again. A **lease** can: the slot comes back
> when its holder stops renewing, whether or not the holder is alive to say so.

## Context

`throttle.concurrency` has always been per-process, and the docs said so. Attach a
shared store and the rate budget becomes fleet-wide while the concurrency cap quietly
stays local — so `concurrency: 10` across eight workers is a fleet cap of eighty. ADR
0024 closed the rate half and named this one:

> `concurrency` is still in-process under a store … a distributed semaphore needs leases
> with expiry and renewal, which is a much larger contract extension than a cursor.

It is larger, and the reason is not implementation effort. It is that **the cursor's
trick does not transfer.**

### Why the pacing cell does not generalise

`reserve` works because a rate is a function of time alone: `at = max(now, cell)`
needs no memory of who was granted what, and a crashed caller leaves nothing behind to
clean up — its grant simply passed. Every process can compute the same answer from one
number.

A concurrency slot is the opposite in each respect. It is held for an **unknown
interval**, it belongs to a **specific holder**, and the event that frees it — the
holder finishing — is not a time, it is news. A shared counter fails the moment the
news does not arrive:

| Failure                        | A shared counter                          | A lease                                  |
| ------------------------------ | ----------------------------------------- | ---------------------------------------- |
| Holder crashes mid-call        | slot lost forever; the cap decays to zero | expires, slot returns                    |
| Release lost to a network blip | same, permanently                         | costs one slot for `lease`, then returns |
| Holder pauses (GC, VM freeze)  | still counted, correctly                  | may lose its slot early — the real cost  |

Only the last row is a regression against a counter, and it is the honest price: a
lease trades "a slot can be lost forever" for "a slot can be reclaimed early".

## Decision

### 1. Two paired verbs, `lease` and `release`

```ts
lease?(key: string, token: string, limit: number, ttl: number, now: number): Promise<boolean>;
release?(key: string, token: string): Promise<void>;
```

`lease` atomically prunes every holder expired at `now`, then: renews `token` if it
already holds a slot, else takes one if fewer than `limit` are live, else refuses.
Pruning persists **even when it refuses** — a failed attempt must not leave dead
holders for the next caller to re-walk.

Three consequences worth naming:

- **The caller mints the token**, so `lease` doubles as renewal and is idempotent. A
  caller that leases twice is extending, never taking a second slot — which removes the
  entire class of bug where a retry silently consumes the semaphore.
- **`now` is the caller's clock**, as in `reserve`: deterministic under an injected
  `Clock`, and no store needs one of its own.
- **The representation is not specified.** `memoryStore` and `@stitchapi/deno-kv` keep a
  token→expiry map; `@stitchapi/redis` uses a sorted set, where `ZREMRANGEBYSCORE` prunes
  in one command. Both satisfy the same rules, which is the point of specifying behaviour.

### 2. Optional and paired — implement both or neither

Same two reasons as [`reserve`](./0024-the-fleet-wide-pacing-cell.md), plus one of its
own: half a lease API is worse than none, because a slot could be taken and never given
back. Cloudflare KV cannot make this atomic; `StitchStore` is consumer-implemented, so a
required member is a hard break in any channel
([P19](../CONTRACT.md#p19--the-alias-obligation-is-scoped-to-the-ga-channel)). Without
the pair, `concurrency` stays per-process exactly as before — pinned in `store.spec.ts`
against a store with the verbs deliberately withheld.

### 3. `throttle.lease` — one knob, and it is a crash timer

Default 30s, `number | string` like every authored duration
([P17](../CONTRACT.md#p17--one-canonical-duration-form)). Read only when `concurrency`
is set and the store leases.

Sizing it is the one thing a user must get right, and the two directions fail
differently: too **long** strands a dead worker's slots for that long; too **short** and
a call still running has already lost its slot, so the fleet exceeds `concurrency`. The
second is the dangerous one, and what keeps it manageable is
[ADR 0005](./0005-surfaces-and-the-authoring-model.md) Decision 12 — **streaming takes no
concurrency slot at all**. The calls this bounds are buffered ones, which `timeout`
already bounds, so a `lease` above `timeout.total` cannot be outlived.

### 4. Release stays synchronous and fire-and-forget

`Throttle.release(key): void` is unchanged, so
[P11](../CONTRACT.md#p11--asyncsync-signature-parity) holds: the verb keeps one shape
across both limiters. The store call is issued and not awaited.

This is not a shortcut around P11, it is the lease design working. A caller never pays a
store round-trip on its way out, and a release lost to a blip costs the fleet one slot
for at most `lease` — the _same_ guarantee that already covers a holder crashing. Making
it async would buy promptness, not correctness, at the cost of a round-trip on every
call.

### 5. A blocked caller polls, with full jitter

There is no cross-process handoff: a worker cannot be woken by another worker's release.
So where the in-process limiter parks on a FIFO queue and is handed the slot, the
fleet-wide one retries on a uniform `[0, 50ms)` delay — full jitter, the same reasoning
`expo-jitter` uses, so a fleet queued behind one slot does not re-collide in lockstep.

The cost is real and worth stating: FIFO fairness is gone, and contention costs store
round-trips proportional to how long callers wait. Both are inherent to a shared
semaphore without a notification channel, not artefacts of this design.

## What this preserves

- Every existing config is unchanged; a store without the verbs behaves exactly as before.
- Streaming still takes no slot (ADR 0005 Decision 12), pinned under leases too.
- `waited` is still reported, so `progress.throttled` still fires — measured under leases
  rather than predicted, since the store owns the count.

## Alternatives considered

### A. A shared counter with `increment`/decrement — **rejected: it cannot survive a crash**

The obvious reuse of a verb that already exists, and it fails at the first failure. A
holder that dies never decrements, so the cap decays monotonically toward zero and only
a restart or manual intervention restores it — a limiter that gets _stricter_ every time
something goes wrong, silently. Every fix for that reintroduces expiry, which is a lease.

### B. Lease renewal on a timer while the slot is held — **rejected for now: cost without a case**

Strictly more correct: a heartbeat would let a slow call keep its slot past `lease`. It
needs a timer per held slot, wired through the `Clock` seam, cancelled on every exit path
including aborts — real machinery whose failure mode (a leaked timer holding a slot alive
after its call is gone) is worse than the problem it solves. And the case is thin, because
streaming holds no slot: a `lease` above `timeout.total` cannot be outlived. Revisit if
someone genuinely needs an unbounded buffered call under a fleet cap.

### C. A distributed queue for fairness instead of polling — **rejected: a different system**

FIFO across processes needs a durable ordered queue and a notification channel, which is
a message broker, not a KV store. It would fix the fairness this design gives up, and it
would put a broker on the critical path of every throttled call.

### D. Leave it per-process and document harder — **rejected: the documentation was the problem**

The gap was already documented, and the documentation is exactly what made it unsatisfying:
"attach a store to share the policy" was true of one of the two limits. A caller who reads
`concurrency: 10` and runs eight workers has not misread the docs so much as been told
something that stopped being true halfway through.

## Open questions

1. **Poll interval is not configurable.** 50ms with full jitter is a default chosen for a
   fleet queued behind a slot, not measured against a real workload. It should probably
   scale with `lease`, or be tunable, once there is evidence about contention shapes.
2. **`pool: 'host'` and leases share a key namespace** but have never been exercised
   together across a fleet. Nothing suggests they conflict — the key is just a string — but
   it is untested territory.
3. **Clock skew shortens leases** for a worker whose clock runs fast, exactly as it shifts
   the pacing cursor. Bounded by the skew and no worse than the existing behaviour, but a
   store-side clock would remove it for backends that have one.
4. **No visibility into semaphore state.** There is no way to ask "how many slots are held
   right now", which is the first thing anyone debugging a stuck fleet will want. A
   read-only `held(key)` would be cheap; it is left out because an unused verb on a
   consumer-implemented contract is a cost everyone pays.
