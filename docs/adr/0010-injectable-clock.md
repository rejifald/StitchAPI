# ADR 0010 — An injectable `Clock` for deterministic time in tests

- **Status:** Accepted
- **Date:** 2026-06-18
- **Tags:** testing, time, retry, throttle, timeout, circuit, seam, determinism

> [!NOTE]
>
> This is the time half of the testing story ([`docs/proposals/testing-utilities.md`](../proposals/testing-utilities.md), GAP-AUDIT §2.9). The mocking kit (`mockAdapter` / `stubStitch` / stream builders / `collectStitchEvents`) makes a stitch's _network_ controllable; the `Clock` makes its _time_ controllable. The load-bearing decision is **what the clock owns** — all three time primitives (`now` + `sleep` + the timer), not just `now()`, because the flakiness lives in the waiting, not the reading.

## Context

A stitch's resilience behaviour is time-driven: retry **backoff** sleeps, the **throttle** paces on a rate budget, the **per-attempt timeout** arms a timer, and the **circuit** opens for a cooldown. Testing any of these meant real wall-clock waiting — slow, and flaky under load (the repo's own `throttle-host-pooling` timing test reads `380 < 400ms` and passes only on retry). The library deliberately uses **no fake timers internally** (real elapsed-bound assertions catch real regressions), but that is a choice about _the library's own_ tests — it left _users_ with no way to drive a stitch's time at all.

Time entered the runtime through three module-global primitives in `util.ts`: `now()` (scheduling math + circuit cooldown + `Retry-After` HTTP-dates), `sleep()` (backoff + throttle pacing), and raw `setTimeout`/`clearTimeout` (the per-attempt timeout wrapper). Extracting only `now()` would give deterministic timestamps but leave the **waits** real — so retry/throttle/timeout tests would still be wall-clock-bound. The seam must own all three.

This fits the project's "contract, not dependency" model exactly: a `Clock` is the fifth injectable alongside `adapter` / `store` / `trace` / `auth`, threaded through `makeRuntime` the same way.

## Decision

**Add a `Clock` interface, default it to a `systemClock`, and thread it through the resilience path — so injecting a `manualClock()` makes retry, throttle, the per-attempt timeout, and the circuit deterministic with zero real waiting.**

1.  **`Clock` owns three primitives** (`packages/core/src/types.ts`): `now()`, `sleep(ms, signal?)`, `setTimer(fn, ms)`, and `clearTimer(handle)`. `systemClock` (`util.ts`) wraps `Date.now` + `sleep` + the global timers — today's exact behaviour. It is the default everywhere (`clock: Clock = systemClock` on every threaded function), so **nothing changes unless a clock is injected** (the 710-test suite is unchanged).

2.  **Injected via config, resolved once, threaded on the `Runtime`.** `StitchConfig.clock` (and `SeamOptions.clock`, via `SeamConfig`) carry it; `makeStitch` resolves `shared?.clock ?? cfg.clock ?? systemClock` and passes it to `createThrottle`/`createStoreThrottle` **and** onto `Runtime.clock`. The engine reads `rt.clock` at every wait/schedule site: `sleepWithin` (backoff), `withTimeout` (per-attempt timeout), `createCircuit` (cooldown), `parseRetryAfter` (HTTP-date), and the throttle's pacing `sleep`. It is a live object, so it is **stripped from `__config`** like `adapter`/`store`/`auth` (exfil-at-rest, ADR 0002 §4/§6).

3.  **`manualClock()` ships in `stitchapi/testing`.** Virtual time you move with `advance(ms)`, which fires every timer/`sleep` due at or before the new time **in due order** — including ones a fired callback schedules (so a retry's next backoff is armed before the next `advance`). `pending()` exposes the live timer count to assert nothing leaked. It is browser-safe (rides the testing entry's browser-bundle guard).

4.  **Bounded scope — the clock drives _control-flow_ time, not bookkeeping.** Deliberately left on wall-clock, and documented on the `Clock` JSDoc: **`timeout.total`** (its budget deadline stays wall-clock — virtual sleeps don't consume it), **event `at` / `done.ms` timestamps** (cosmetic, would force threading the clock through ~30 event builders for no test-determinism gain), and **`memoryStore` TTL / cache TTL** (a separate concern — store/cache expiry). Under `systemClock` all of these coincide with the rest; under `manualClock` they remain real, which is harmless for retry/throttle/timeout/circuit testing and avoids an invasive, low-value refactor.

## Consequences

- **Deterministic, zero-wait tests** for the four time-driven behaviours, via the published `manualClock()` + the `mockAdapter` from the same entry. No fake-timer library, no monkeypatching `Date`/`setTimeout`.
- **No behaviour change by default.** `systemClock` is the default at every site; the full suite is green unchanged. The new capability activates only when a `Clock` is injected.
- **Bundle cost:** the seam adds ~0.14 kB to the `import { stitch }` path (it threads through the hot path), nudging the advertised tree-shaken size from ~17 kB to ~18 kB (still within the CI budget). The whole entry stays ~22 kB.
- **Advanced users can BYO clock** — any object satisfying `Clock` (e.g. a wrapper over `@sinonjs/fake-timers`) plugs in via `clock`, since `Clock` and `systemClock` are exported from the main entry.
- **Follow-ups (out of scope here):** driving `timeout.total`, event timestamps, and store/cache TTL off the clock, should a concrete need arise.
