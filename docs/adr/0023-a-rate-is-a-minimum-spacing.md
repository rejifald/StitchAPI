# ADR 0023 — A rate is a minimum spacing, not a window budget; the two limiters must agree before the grammar grows

- **Status:** Proposed (2026-08-04). Nothing here is implemented. Opened by the question "does the P17/P25 `number | string` widening extend to a rate?" ([#618](https://github.com/rejifald/StitchAPI/pull/618)); the answer is no, but establishing why surfaced a live defect in the store-backed limiter that this ADR treats as the blocking issue. Touches the pluggable store ([DESIGN.md §13](../DESIGN.md), which has no ADR of its own) and builds on [ADR 0010](./0010-injectable-clock.md) (the injectable `Clock`, whose tags already include `throttle` — the fix's tests need it).
- **Date:** 2026-08-04
- **Tags:** resilience, throttle, store, api-surface, correctness, P1, P12, P16, P17, P25

> [!NOTE]
>
> One thesis, three consequences. **`ThrottleOptions.rate` denotes exactly one
> number** — the minimum spacing `per / count` — and the `count`/`per` pair is
> notation for it, not two independent knobs. The in-process limiter already
> behaves that way. The **store-backed limiter does not**: it uses `per` a second
> time as a window quantum, which makes the _spelling_ of a rate load-bearing and,
> today, admits up to a full window's budget instantaneously on a cold key. Until
> the two agree, no grammar question about `rate` can be answered — so the grammar
> stays frozen and the defect is the first thing to fix.

## Context

[#618](https://github.com/rejifald/StitchAPI/pull/618) stated the P17/P25 widening
rule as one test over two dimensions: _if a position accepts a duration or a byte
size, it must also accept a `string`._ The natural next question was whether a rate
like `'2/s'` belongs to that family.

It does not, and the reason is short. The widening exists because a duration and a
byte cap are **magnitudes over a house unit** — `5_000` already means 5000ms,
`4096` already means 4096 bytes — so the number arm is meaningful on its own and
the string is ergonomics on top. A rate looks like two quantities, so a bare `2`
would have to invent a default window to denote anything, and that invisible
default is what P15/P20 exist to reject. `rate?: string` is not an un-widened
field; it is already canonical, and canonical _because_ it is string-only.

That answer is correct and it is also the least interesting thing in this document.
Establishing it required reading what the pair actually does downstream, and the
two limiters do not agree.

### The in-process limiter keeps only the ratio

[`createThrottle`](../../packages/core/src/resilience.ts) consumes the parse result
in exactly one place:

```ts
const rate = opts?.rate ? parseRate(opts.rate) : undefined;
const spacing = rate ? rate.per / rate.count : 0; // ms between grants
```

`count` and `per` never appear again. The pair collapses to one scalar at the point
of use, so **every rate with the same ratio is the same configuration**: `'1/s'` and
`'60/m'` are indistinguishable, and `'2/500ms'` — if the grammar admitted it — would
be indistinguishable from `'4/s'`. This matches what the field's JSDoc now says out
loud: a minimum spacing between successive calls, **not a token bucket**.

### The store-backed limiter uses `per` a second time

[`createStoreThrottle`](../../packages/core/src/store.ts) computes the same spacing
and then does something more:

```ts
const spacing = rate.per / rate.count;
const windowStart = Math.floor(clock.now() / rate.per) * rate.per;
const n = await store.increment(`rl:${key}:${windowStart}`, rate.per + 100);
const grantAt = windowStart + (n - 1) * spacing;
```

`per` is now a **window quantum** as well as half the ratio. Two rates with the same
spacing but different `per` get different window boundaries, different counter
lifetimes, and different grant schedules. The spelling has become load-bearing —
silently, since nothing in the type, the JSDoc, or the guides suggests that `'1/s'`
and `'60/m'` are different requests.

### What that costs, measured

Both spellings below name **2 calls per second** — spacing 500ms in every case.
Arrivals were spread one per 50ms so calls land in several windows rather than all
being counted into one; the budget over 4s is 8 grants.

| Rate      | In-process | Store-backed |
| --------- | ---------- | ------------ |
| `'2/s'`   | 8, 8       | 25, 23       |
| `'120/m'` | 8, 9       | **79, 79**   |

The in-process limiter is exact and spelling-independent. The store-backed limiter
is neither: `'120/m'` admitted 79 of 80 offered calls — effectively no limiting at
all — while `'2/s'`, the same rate, admitted about a third of that.

The mechanism is the absolute `windowStart`. A key first seen part-way through a
window is credited with every slot that has _already elapsed_ in that window, and
those grants are in the past, so they fire immediately. The size of that opening
burst is bounded by `count`, which is proportional to `per`:

| Rate      | Of 40 simultaneous calls on a cold key, granted immediately |
| --------- | ----------------------------------------------------------- |
| `'2/s'`   | 1, 2, 3                                                     |
| `'120/m'` | 24, 40, 40                                                  |

Three runs each; the variation is the phase of the wall clock within the window,
which is itself part of the problem — behaviour depends on when the process happens
to start relative to an epoch boundary.

This is the burst that `createStoreThrottle`'s own JSDoc says the design avoids:
_"attaching a store no longer silently switches pacing to bursty fixed-window."_
Within a single window that claim holds — grants there really are evenly spaced, and
the boundary carry-over really does work. It fails for a key that starts mid-window,
which is every key in a freshly started process.

### Why the existing test does not catch it

[`store.spec.ts`](../../packages/core/test/store.spec.ts) fires 8 simultaneous
acquires at `'5/s'` and asserts that the last three grants are >120ms apart. All 8
land in one window as `n = 1…8`; slots 6–8 exceed `count = 5`, so they are pushed
past the boundary and are correctly spaced — the assertion passes. The test never
varies arrival time, never uses a key that starts mid-window, and never compares
_total admitted_ against the configured budget. It pins the tail of the schedule,
which was the bug it was written for, and is blind to the head.

## Decision

### 1. A rate denotes a minimum spacing, and that is the whole semantics

`per / count` is the value. The pair is notation. Nothing may derive behaviour from
`count` or `per` independently — that is what makes two spellings of one rate
substitutable, which is the only reason the many-to-one grammar is safe.

This ratifies the in-process limiter and the field's existing JSDoc rather than
inventing anything. StitchAPI's throttle is a **pacer**, not a quota manager: it
answers "how close together may two calls be", not "how many may I make this
minute". A caller who needs burst-then-drain wants a token bucket, and this ADR
declines to make `rate` mean that (see Alternative C).

### 2. `createStoreThrottle` is a defect against Decision 1 and is fixed first

A grant must not be scheduled from an absolute window origin the caller never asked
about. The store limiter must pace on the same one scalar the in-process one does,
so that `'1/s'` and `'60/m'` are once again the same request. The window is an
implementation device for sharing a counter across processes; it must not leak into
observable behaviour.

Two shapes are plausible and this ADR does **not** pick between them — that belongs
in the fix, with tests:

- **(a) Clamp the credit.** Keep the per-window counter, but schedule the Nth grant
  from `max(windowStart, firstSeenInWindow)` rather than `windowStart`, so a cold
  key cannot claim elapsed time it was not present for. Smallest change; keeps the
  existing store contract; still approximate across boundaries.
- **(b) Store the timestamp.** Hold `nextGrantAt` in the store rather than a counter,
  which is exact GCRA and spelling-independent by construction. This needs an atomic
  read-compute-write the `StitchStore` contract does not currently offer — the
  extension the JSDoc already flags as "deliberately deferred". Correct, and a
  contract change ([P21](../CONTRACT.md#p21--every-contract-has-an-extension-seam)
  makes room for it, but it is every implementor's problem, so it is a real cost).

Whichever lands, the regression test is the measurement above: **total admitted over
a multi-window interval, against budget, for two spellings of one rate** — not just
the spacing of the tail.

### 3. The grammar stays frozen until Decision 2 ships

`<count>/<unit>` with `unit ∈ {ms, s, m}` is unchanged for now. The gap is real —
`'1000/h'` is an ordinary API quota and cannot be written today, and the reachable
spacings are only `{1/n, 1000/n, 60000/n}`, so 3.6s is not expressible at all — but
every extension makes the current defect worse rather than better:

- adding `h`/`d` raises the achievable `count` by orders of magnitude, and the cold
  key burst is bounded by `count`, so `'1000/h'` would admit up to **1000 immediate
  calls** on the store path;
- admitting a duration denominator (`'2/500ms'`) introduces pairs that are identical
  in-process and different under a store, which is a
  [P16](../CONTRACT.md#p16--cross-surface--cross-package-parity) parity break
  manufactured on purpose.

Once Decision 2 lands, `per` no longer affects behaviour, and both extensions become
pure notation over the one scalar — at which point they are cheap and this ADR
recommends taking them. Ordering, not rejection.

### 4. `rate` stays a flat string; it does not become an envelope

[P24](../CONTRACT.md#p24--a-shared-field-name-prefix-in-a-house-contract-is-an-envelope)
pressure exists — `{ count, per }` is sitting right there — and it is wrong here. An
envelope would **reify** as two configurable knobs a pair that Decision 1 says is one
value, promising independent control the semantics does not have. `'2/s'` is not the
P12 shorthand for a richer object; it is the value's only form, and the object form
would be a lie about what the limiter reads. The existing P12 relationship —
`throttle: '2/s'` ≡ `throttle: { rate: '2/s' }` — is at the `throttle` level and is
unaffected.

### 5. The non-widening is recorded, in one line, where the widening is stated

P17/P25 gain a sentence: the widening reaches a **magnitude over a house unit**, so a
rate is outside it, and `rate` is string-only by construction. This is worth stating
precisely because the question recurs — it prompted this ADR — and because R9's
vocabulary silently depends on it: `rate` is absent from that list, and a reader
should be able to find out why without reconstructing the argument.

## What this preserves

- Every existing `'2/s'` config keeps working; Decision 3 changes no grammar.
- The in-process limiter is unchanged — it is already the reference behaviour.
- `parseRate`'s fail-loud contract ([#618](https://github.com/rejifald/StitchAPI/pull/618))
  stands: for a rate, `undefined` would mean _unlimited_, so a typo must throw rather
  than fall back. Decision 2 does not touch it.
- `throttle.concurrency`, `pool`, and `delegate` are untouched; this is only about
  what the rate value means.

## Alternatives considered

### A. Fix the grammar first, defer the limiter — **rejected: ships the bug wider**

Adding `h`/`d` is a ten-line change and would close a real gap today. It also
multiplies the exact defect Decision 2 exists to remove, since the cold-key burst
scales with `count`. Shipping a more expressive way to write a broken configuration
is not progress, and the ordering costs nothing: the grammar change is cheap _after_
the fix and stays cheap.

### B. Declare the store limiter's behaviour intended and document it — **rejected: it contradicts the field**

Defensible on its face: fixed-window limiters burst, everyone knows this, write it
down. It fails because the same `rate` value then means two different things
depending on whether a `store` is attached — a
[P16](../CONTRACT.md#p16--cross-surface--cross-package-parity) break at the point
where parity matters most, since attaching a store is advertised as scaling the same
policy across workers, not changing it. It also cannot be documented honestly at the
field: `rate` would have to say "the minimum spacing, unless you have a store, in
which case also a window quantum whose size you chose implicitly by how you spelled
this string".

### C. Make the rate genuinely windowed — a token bucket, so `count` and `per` are both real — **rejected: it is a different capability, and a bigger one**

This is the one alternative that would make `'2/500ms'` legitimately differ from
`'4/s'`, and it is what many APIs actually enforce. It is rejected here on scope, not
on merit: burst capacity is a second dimension (how much credit may accumulate), it
needs its own field, its own defaults, and its own distributed story, and folding it
into the existing `rate` string would silently change what every current config does.
If burst semantics are wanted, they should arrive as a named capability with `rate`
keeping its meaning — a separate ADR, for which this one is the prerequisite, since
it establishes what `rate` means today.

### D. Reify the scalar — replace `rate` with a spacing field like `every: '500ms'` — **rejected: it optimises for the implementation over the reader**

Honest about the semantics, and it would make the whole grammar question vanish:
`every` is a duration, so P17 covers it, `parseDuration` parses it, and every
reachable spacing is expressible including 3.6s. It loses more than it gains. APIs
document quotas as "1000 requests per hour", and `'1000/h'` transcribes that directly
while `every: '3.6s'` asks every reader to do division at the authoring site and again
at every review. A notation that matches how the domain states the constraint is worth
a many-to-one mapping onto the underlying scalar. Worth revisiting only if the
`count/unit` grammar proves unable to reach spacings people actually need after
Decision 3's extensions land.

### E. Keep `{ count, per }` distinct in-process too, for symmetry — **rejected: symmetry toward the wrong reference**

The two limiters disagree, so one must move. This picks the in-process one as
correct because it is the one that matches the documented semantics, the simpler
behaviour, and the one that has no defect. Making the in-process limiter
window-aware would propagate the cold-start burst to the default configuration —
the opposite of a fix, reached by treating "consistent" as the goal instead of
"consistently right".

## Open questions

1. **Decision 2(a) or 2(b)?** Deliberately left to the fix. (b) is correct and costs a
   `StitchStore` contract extension every implementor must satisfy; (a) is
   proportionate and stays approximate at boundaries. The measurement above is the
   acceptance criterion either way.
2. **Should the defect ship as a fix or a breaking change?** It tightens a limiter, so
   callers relying on today's over-admission would see fewer calls get through. That is
   a bug fix by any reading, but on the `rc` channel it is worth a CHANGELOG note under
   BREAKING CHANGE rather than a quiet correction, since the observable effect is
   throughput.
3. **Non-integer counts** (`'0.5/s'`) are unaddressed. Under Decision 1 they are pure
   notation — `'0.5/s'` ≡ `'1/2s'` ≡ a 2000ms spacing — so they are safe but redundant;
   they belong with Decision 3's extension question, not before it.
4. **`concurrency` is still in-process only** under a store, as `createStoreThrottle`'s
   JSDoc notes (a distributed semaphore needs leases). Out of scope here and unaffected,
   but it is the second place where "attach a store to share the policy" is only
   partly true, and the two should probably be documented together.
