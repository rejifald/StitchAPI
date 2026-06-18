# Proposal — a shipped testing story (GAP-AUDIT §2.9)

**Status:** proposed · **Scope:** `packages/core` (`stitchapi/testing`), one core change (Clock seam) · **Target branch:** `main`
**Closes:** GAP-AUDIT.md §2.9 ("A shipped testing story (mock adapter)") · RELEASE.md v1.1 "Published record/replay mock adapter"

> [!NOTE]
>
> This is a design record, not yet implemented. It folds in the open question
> raised in review: should time become an injectable entity so users can test
> retry/throttle/timeout logic? (§4 — yes, behind a `Clock` seam.)

---

## TL;DR

Today **nothing public helps a user test code that calls stitches.** The only
shipped `stitchapi/testing` surface is the _vendor-facing_ conformance kit
(`verifyStoreContract` / `verifyAdapterContract` / `verifySinkContract` /
`verifyFingerprintContract`) — for proving a custom store/adapter/sink complies,
not for testing your own application code. The productizable pieces already exist
in-repo as private test support (`test/support/mock-server.ts`,
`test/support/streams.ts`) and are copy-pasted across 30–40 specs.

The thesis: because StitchAPI already has a first-class network seam
(`Adapter`, a one-function contract `(req) => Promise<res>`), the test story is
**"inject a fake adapter," not "monkeypatch global `fetch`."** That is cleaner
than MSW/nock and is the headline we should sell.

We propose a small toolkit on `stitchapi/testing`, browser-safe (passes the
browser-first + bundle-frugal gates), serving two distinct jobs, plus one
architectural change — an injectable **`Clock`** — that makes retry/throttle/
timeout logic deterministically testable.

---

## 1. Two distinct testing jobs

People mean two different things by "test my stitches," and they need different
tools:

| Job                                                                                                                                         | Who                  | Controls                                     | Seam                         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------- | ---------------------------- |
| **A. Test the stitch definition** — does `getUser` hit the right URL, send the right body, validate/unwrap, retry on 503, paginate, stream? | Author of the stitch | the **network**, while the real runtime runs | inject a mock `Adapter`      |
| **B. Test code that _calls_ a stitch** — my handler calls `getUser()`; a unit test that never touches the runtime                           | Consumer of a stitch | the **stitch itself** (canned return)        | replace with a fake `Stitch` |

Both are unserved today. The architecture makes A easy (the `Adapter` contract is
`(req: AdapterRequest) => Promise<AdapterResponse>`, `types.ts:225`) and B
fiddly-but-high-value (a conformant fake `Stitch` is hard to hand-roll — it must
be callable returning a `StitchResult` _and_ carry
`.safe()/.unwrap()/.stream()/.with()/.cache/.invalidate()/__config/__stitch`,
`types.ts:735` and `:754`).

---

## 2. What already ships, and who it serves

-   **`stitchapi/testing` conformance kit** (`packages/core/src/testing.ts`):
    `verify{Store,Adapter,Sink,Fingerprint}Contract`, `assertConformance`,
    `adapterContractFixture`. **Audience: vendors.** Not for app code.
-   **Usable-but-not-test-specific main exports:** `memoryStore()`,
    `consoleSink()`/`loggerSink()`, `fetchAdapter`/`axiosAdapter`/`xhrAdapter`.
-   **Private, not the user-facing story:** `@stitchapi/sandbox-sim` (playground
    simulator), `@stitchapi/eval-harness` (agent evals).
-   **Rich internal support — the obvious thing to productize:**
    -   `test/support/mock-server.ts` — route patterns, **status sequences**
        (`[503,503,200]`), latency knobs, real chunked streaming, **call spies**
        (`calls()`, `callCount()`). Used by 30+ specs.
    -   `test/support/streams.ts` — `streamOf`, `streamThenError`, `gatedStream`,
        `streamAdapter`, `collectEvents`. Used by 40+ specs.
    -   Copy-pasted-in-6+-places adapter factories (`counting`, `recordingClient`,
        `scriptedAdapter`) and a local `collect()` drainer — direct evidence of the
        missing exported helper.

GAP-AUDIT §2.9 already names the build: _"publish a `mockAdapter({handlers})` …
optionally with record/replay to fixtures, plus a testing guide."_

---

## 3. Proposed surface

All on **`stitchapi/testing`** (one home; documented in two sections —
"conformance" for vendors, "mocking" for app authors). Browser-safe: no
`node:http`. The internal node `mock-server.ts` stays internal for the lib's own
deep transport tests; any filesystem record/replay goes behind a node-only entry.

### P0 — the headline

**`mockAdapter(routes)` → `Adapter` + spy.** Adapter-level (browser-safe), _not_ a
real server. Productizes `mock-server.ts`'s `RouteBehavior` at the adapter layer:

-   match by method + path/url (string / pattern / regex)
-   response = value | **sequence** (for retry) | `(callIndex, req) => …`
-   `status` sequences, `delayMs`, headers, streaming body (returns a `ReadableStream`)
-   **request spy:** `.calls()`, `.callCount()`, `.lastRequest()` — assert
    method/url/headers/body
-   configurable unmatched behavior (404 vs throw)

Wire via `stitch({ adapter })` or `seam({ adapter })`. Serves Job A directly.

**`collectStitchEvents(streamable)` → `{ types, deltas, drifts, result, error, done }`.**
Promote the existing internal `collectEvents`. Kills the `collect()` copy-paste
and gives users the canonical way to assert on `.stream()`.

### P1 — round out the two jobs

**`stubStitch(value | fn, opts?)` / `fakeStitch`** — a _correct_ fake `Stitch` for
Job B. Supports canned success, scripted failure (`StitchError`), call recording,
and a scripted event sequence for `.stream()`. Pairs with the Nest
`overrideProvider(useValue: fakeStitch)` pattern already assumed in ADR 0006.

**Stream-body builders:** `streamOf(chunks)`, `sseStream(events)`,
`streamThenError`, `gatedStream` — promote from `test/support/streams.ts`. Needed
to test the `sse`/`stream` surfaces, mid-flight errors, and SSE reconnect.

### P2 — the named-but-deferrable bit

**Record/replay** (`recordAdapter(real, fixtureFile)` + replay) — the literal v1.1
line item. The _replay_ half is browser-safe; the _record_ half touches the
filesystem → node-only entry (`stitchapi/testing/node`). Lower priority than the
above.

---

## 4. Decision: time becomes an injectable `Clock` (→ future ADR 0010)

**Question raised in review:** advanced users want to test retry logic on their
side — should the clock move into its own entity so it can be mocked?

**Answer: yes — but it must own all three time primitives, not just `now()`.**

Time enters the runtime through three module-global primitives today:

1. `now()` — `util.ts:4` — event timestamps (`at: now()`), scheduling math,
   token-expiry checks (`auth.ts:346`), circuit cooldown (`resilience.ts:292`).
2. `sleep(ms, signal)` — `util.ts:39` — retry backoff (`engine.ts:420`) and
   throttle spacing (`resilience.ts:123`); built on `setTimeout`.
3. raw `setTimeout`/`clearTimeout` — the timeout wrapper (`resilience.ts:201`) and
   the total-budget timer (`engine.ts:458`).

The actual _waiting_ is in (2) and (3), **not** `now()`. Extracting only `now()`
gives deterministic timestamps but leaves retry/throttle/timeout tests real-time
(and flaky under load — cf. the known-flaky `throttle-host-pooling.spec.ts`,
`380 < 400ms`). So the seam must wrap all three:

```ts
export interface Clock {
    now(): number;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
    setTimer(fn: () => void, ms: number): TimerHandle; // wraps setTimeout
    clearTimer(h: TimerHandle): void;
}
```

-   **`systemClock`** (default) wraps `Date.now` + global timers — today's behavior,
    zero change for users. Injected via config/seam alongside `adapter`/`store`/
    `trace`/`auth` ("contract, not dependency").
-   **`manualClock()`** (shipped in `stitchapi/testing`) exposes `.advance(ms)` /
    `.tick()` that fast-forwards `now` _and_ resolves every pending `sleep`/timer
    whose deadline was crossed. Advanced users can plug their own clock (or
    `@sinonjs/fake-timers`) by satisfying the interface.

**Why it's worth a core change (beyond easier mocks):**

-   Instant long-horizon tests — OAuth token expiry, `maxMs` backoff caps, circuit
    `cooldownMs` — without waiting minutes.
-   Deterministic `at:` timestamps, so `collectStitchEvents` snapshots are stable
    (today `at: now()` must be stripped before snapshotting).
-   Removes wall-clock flakiness from timing assertions.

**On the "no fake timers" stance:** that rule governs _the library's own_
internal tests (deliberate, to catch real timing regressions). Exposing a `Clock`
_seam for users_ is orthogonal — it does not force the lib to fake its own time.
No contradiction.

**Cost / sequencing:** genuine core change — every `now()`/`sleep()`/`setTimeout`
call site in `engine.ts`, `resilience.ts`, and `auth.ts` routes through the
injected clock, threaded via `makeRuntime` (where `store`/`trace`/`throttle`
already thread). Deserves its **own ADR (0010) + PR**, landing _after_ the P0
`mockAdapter` + `collectStitchEvents` MVP, which needs none of it.

---

## 5. Browser-safety & bundle

The headline helpers (`mockAdapter`, `collectStitchEvents`, stream builders,
`systemClock`/`manualClock`, `stubStitch`) must pass the **browser-first** and
**bundle-frugal** gates: no `node:*`, small footprint. The node `mock-server.ts`
and any filesystem record/replay live behind a node-only entry and never enter the
browser graph. The CI bundle guard (`test/gaps/browser-bundle.spec.ts`) gains the
new subpath to its matrix.

---

## 6. What to hold the line on

-   **Don't reimplement MSW/nock.** The `Adapter` seam _is_ the interception point;
    "swap the adapter" is the idiomatic, global-patch-free story.
-   **Don't publish `sandbox-sim` as the test story** — it is a playground
    simulator, a different purpose.
-   **Ship the guide.** A testing guide is half of §2.9's value, not an afterthought.

---

## 7. Phasing (one PR each, stop between)

1. **P0a** — `mockAdapter` + `collectStitchEvents`, promoted from internal support,
   browser-safe; bundle-guard matrix entry; first half of the testing guide.
2. **P0b** — stream builders (`streamOf`/`sseStream`/`streamThenError`/`gatedStream`).
3. **P1a** — `stubStitch`/`fakeStitch` + Nest `overrideProvider` recipe.
4. **P1b** — ADR 0010 + `Clock` seam (`systemClock` default, `manualClock()` test
   impl); retro-fit a few slow internal timing specs as the dogfood proof.
5. **P2** — record/replay behind `stitchapi/testing/node`.
