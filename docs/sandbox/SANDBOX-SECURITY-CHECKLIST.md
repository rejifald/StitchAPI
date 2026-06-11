# Playground Sandbox — Security & Isolation Checklist (testable invariants)

> **Status:** Accepted (C2 sign-off) · implementation **NOT STARTED** > **Date:** 2026-06-11 · **Decider:** @rejifald · **Tier:** T3 (Opus)
> **Design of record:** [SANDBOX.md](./SANDBOX.md) §7 (security model), §9 (acceptance), §10 (risks)
> **Implemented as tests by:** [SANDBOX-IMPLEMENTATION-PLAN.md](./SANDBOX-IMPLEMENTATION-PLAN.md) task **T-α** > **Contract under test:** [`component/runner.ts`](./component/runner.ts) > **Revises the older model in:** [REQUIREMENTS.md](../playground/REQUIREMENTS.md) §7–§8 (proxy-allowlist trust boundary — superseded)

This document turns the [SANDBOX.md](./SANDBOX.md) §7 security model and §9 acceptance
criteria into **binary, testable invariants**. Each row is a **contract the runners MUST
satisfy** — not a guideline. Task **T-α** implements each "How T-α tests it" column as a
mechanical assertion; a runner that fails any row fails sign-off.

The threat model this defends (per SANDBOX §1, §7): **all visitor code is untrusted.** The
revised design removes the old proxy/secret trust boundary entirely, so the invariants below
assert the new boundary — _the runtime has no network and no ambient authority, and the only
outside world a snippet sees is the simulator `fetch` shim._ The §3 static surface scan is a
**routing heuristic, not a security control**; the invariants do not rely on it for safety
(see SEC-30/31 for what the scan _is_ held to).

## Wave-0 ratifications (orchestrator T3) — read before testing

The contract gaps this checklist flagged in Appendix A are now resolved and **frozen in
[`component/runner.ts`](./component/runner.ts)**. Tests assert the concrete fields, not recommendations:

-   **Timeout vs abort vs throw** (was Appendix A.3) → `RunError.reason: 'throw'|'timeout'|'abort'|'internal'`.
    SEC-20/25 assert `reason === 'timeout'` / `'abort'` respectively.
-   **Shim notice channel** (was A.5) → `RunResult.notices: RunNotice[]` with `{ kind:'shim', surface, message }`.
    SEC-3x asserts a shim run yields a `notices[]` entry for the surface — not a log scrape.
-   **Always-resolve semantics** (was A.4) → engine failures resolve as `reason:'internal'`; `run()` rejects
    only for unrecoverable harness bugs. SEC-39d asserts a renderable `RunResult` for every failure class.
-   **Browser memory cap** (A.1) → accepted **time-bounded only**; `SEC-23` stays `server`-only.
-   **CSP tokens** (A.2) → intent `connect-src 'self'` + `worker-src 'self' blob:`; Worker eval needs
    `'unsafe-eval'` _inside the Worker only_. Exact tokens validated in the Phase-2 spike (SEC-10..13 test intent now).
-   **Determinism vs timing** (A.7) → determinism covers response **bytes**, not delivery **timing**; SEC-05
    asserts payload equality, not latency equality.

Conventions for every row:

-   **Applies to** is one of: `browser` (Phase-2 Web Worker runner), `server` (Phase-3
    isolated-vm run-service), or `both`.
-   A test is **mechanical**: it asserts an observable (a resolved `RunResult`, a thrown/not-thrown
    promise, a network spy with zero real sockets, a terminated Worker handle, a CSP string match).
-   "real network" / "real socket" means any egress that is **not** the injected simulator shim.
-   Server-tier rows (SEC-40..45) are **Phase 3**; T-α marks them `skip` until SR1 exists, but they
    are ratified here so SR1 codes against them.

---

## 1. No real egress (SANDBOX §4.3, §7)

| ID         | Invariant (assertable)                                                                                                                                                                             | Applies to | How T-α tests it                                                                                                                                                                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SEC-01** | The only `fetch` visible in snippet scope is the simulator shim; `globalThis.fetch` inside the Worker/isolate is the shim, not the platform `fetch`.                                               | both       | In the run scope, assert `fetch === scope.simFetch` (identity) and that `fetch.toString()` / a tagging symbol marks it as the shim. Assert the host-environment real `fetch` is **not** referenceable from the snippet.                                                                                                                        |
| **SEC-02** | A snippet calling a **known demo host** is answered by a simulator handler, with **no** real socket opened.                                                                                        | both       | Install a network spy at the lowest reachable layer (e.g. patch `XMLHttpRequest`/`WebSocket`/undici dispatcher in the test harness, or run with the network namespace blackholed). Run `await stitch('https://demo.stitchapi.dev/users/2')`; assert the spy recorded **0** real connections and the result value came from the seeded handler. |
| **SEC-03** | A snippet calling an **unknown host/route** receives the documented sandbox-404 body, **never** a real network attempt.                                                                            | both       | Run `await fetch('https://evil.example.com/x')`; assert the response status/body is the sandbox-404 (`"<host> is not reachable inside the StitchAPI sandbox; available demo hosts: …"`) and the network spy recorded **0** real connections.                                                                                                   |
| **SEC-04** | Non-HTTP / raw-socket egress attempts (`WebSocket`, `EventSource` to a real origin, `navigator.sendBeacon`, `import()` of a remote URL) are unavailable or shimmed — none opens a real connection. | both       | Assert each of `WebSocket`, `EventSource`, `sendBeacon`, dynamic `import('https://…')` is either `undefined` in scope or throws/sandbox-404s; network spy records **0** real connections after attempting all of them.                                                                                                                         |
| **SEC-05** | The sandbox-404 and all simulator responses are **deterministic** (seeded), so "no egress" cannot be masked by nondeterministic flakiness.                                                         | both       | Run the SEC-03 snippet twice; assert byte-identical response bodies. (Determinism is also covered functionally by S2–S4 unit tests; here it is a security backstop.)                                                                                                                                                                           |

---

## 2. CSP backstop (SANDBOX §5 "Egress backstop", §7)

The CSP is a **defense-in-depth backstop**: even if the fetch shim is bypassed by a runner bug,
the document/Worker context must be unable to open a network connection to a non-self origin.

| ID         | Invariant (assertable)                                                                                                                                                                                                                            | Applies to | How T-α tests it                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SEC-10** | The document hosting the playground (and thus the Worker it spawns) is served with a CSP whose `connect-src` directive **excludes wildcard egress** — intent: `connect-src 'self'` only (the sim shim is in-process and needs no network origin). | browser    | Parse the `Content-Security-Policy` response header (or `<meta http-equiv>`); assert `connect-src` is present, does **not** contain `*`, `https:`, `http:`, `data:` blanket sources, and is limited to `'self'` (plus any explicitly enumerated docs origins). Fail if `connect-src` is absent or defaults open. |
| **SEC-11** | `worker-src` (or `child-src`/`script-src` fallback per spec) restricts Worker creation to same-origin/`blob:` so a snippet cannot spawn a Worker from a foreign URL.                                                                              | browser    | Assert the CSP contains `worker-src 'self' blob:` (or the documented equivalent) and does **not** permit arbitrary `https:` worker scripts. Then attempt `new Worker('https://evil.example.com/w.js')` from snippet scope and assert it is blocked (throws / CSP violation), not fetched.                        |
| **SEC-12** | A direct network attempt that bypasses the shim (simulated runner bug) is blocked by CSP, not silently sent.                                                                                                                                      | browser    | In a test build, expose the real `fetch` and call `realFetch('https://evil.example.com')`; assert it rejects with a CSP/network error and the network spy records **0** completed real connections. (Asserts CSP is actually enforced, not just declared.)                                                       |
| **SEC-13** | CSP does not rely on `unsafe-eval` leaking site-wide: the eval needed by the runner is confined to the Worker/sandbox context and the parent docs CSP is not loosened by the playground.                                                          | browser    | Assert the **docs-page** CSP (prose pages) is unchanged by the playground and that any `unsafe-eval`/`wasm-unsafe-eval` needed for transpile applies only to the runner context (Worker `blob:` or sandboxed frame), per the Phase-2 spike note in §7.                                                           |

> **Note for the Phase-2 spike (SANDBOX §10):** the exact directive set (`'self'` vs enumerated
> origins, whether the Worker is a `blob:` URL) is validated in the spike. SEC-10/11 pin the
> **intent** (no wildcard egress, no foreign worker), which is what is testable regardless of the
> final origin list.

---

## 3. Resource caps & kill switch (SANDBOX §5.5, §6.1, §9; FR7)

| ID         | Invariant (assertable)                                                                                                                    | Applies to | How T-α tests it                                                                                                                                                                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SEC-20** | A CPU-bound infinite loop is **killed** at `timeoutMs`; `run()` resolves with a timeout `RunError` and does not hang.                     | both       | Spawn `while(true){}` with `timeoutMs=200`; assert `run()` **resolves** (does not reject, does not hang) within < 1 s with `result.error.phase==='runtime'` and a timeout-classified error (e.g. `name==='Timeout'`).                                                                                                    |
| **SEC-21** | The kill is enforced by terminating the execution context (`worker.terminate()` in browser), proving eval is **not** on the main thread.  | browser    | After SEC-20 fires, assert the runner's Worker handle is terminated (e.g. `postMessage` to it no longer responds / a fresh Worker is created for the next run). Assert the host main thread stayed responsive **during** the loop (a concurrent timer/microtask in the test kept ticking).                               |
| **SEC-22** | `timeoutMs` has a sane non-infinite default when the caller omits it.                                                                     | both       | Call `run({code:'while(true){}'})` with no `timeoutMs`; assert it still terminates within the documented default cap, not never.                                                                                                                                                                                         |
| **SEC-23** | A memory-bomb snippet is contained: the run is killed and `run()` resolves with an error rather than OOM-ing the host.                    | server     | Run `const a=[]; while(true) a.push(new Array(1e6))` under the isolate memory cap; assert `run()` resolves with a resource/`RangeError`-class `RunError` and the host process survives. _(Browser Workers lack a hard per-Worker memory cap — see Underspecified §A; browser relies on `timeoutMs` + the OS tab limit.)_ |
| **SEC-24** | The wall-clock cap is independent of snippet cooperation: a snippet that ignores `signal` and busy-loops is still killed by the hard cap. | both       | Run a loop that never checks `signal`; assert SEC-20 behaviour still holds (the cap is preemptive termination, not cooperative).                                                                                                                                                                                         |

---

## 4. Cancellation (SANDBOX §5.5, §9; FR7)

| ID         | Invariant (assertable)                                                                                                                       | Applies to | How T-α tests it                                                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **SEC-25** | Aborting `RunRequest.signal` aborts an in-flight run; `run()` resolves promptly with an abort-classified outcome (not a hang, not a reject). | both       | Start a run against a `?__latencyMs=5000` endpoint, call `controller.abort()` after 50 ms; assert `run()` settles within < 500 ms with an abort-classified result (`error.name==='AbortError'` or equivalent) and the Worker is torn down. |
| **SEC-26** | Abort cancels an **in-flight streamed (SSE)** response mid-stream, not only pre-response.                                                    | both       | Start a run consuming a `?__stream=sse` endpoint that emits N tokens slowly; abort after the 2nd token; assert no further tokens are delivered to the snippet, the sim stream is closed, and `run()` settles as aborted.                   |
| **SEC-27** | The same `signal` is wired to **both** the execution context and the in-flight sim fetch (no orphaned fetch after the Worker is gone).       | both       | After SEC-25, assert the simulator's in-flight handler observed an `abort` (the shim's `AbortSignal` fired) — i.e. the fetch did not continue running detached after termination.                                                          |

---

## 5. Isolation & no ambient authority (SANDBOX §5.4, §6.1, §7)

| ID         | Invariant (assertable)                                                                                                                                                                | Applies to | How T-α tests it                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SEC-30** | The snippet cannot read or mutate the docs app DOM/state: `document`, `window` (parent), and host globals are not reachable from the run scope.                                       | browser    | Inside the Worker run scope, assert `typeof document === 'undefined'` and that there is no handle to the parent `window`. From the host, assert a sentinel value on the docs page (`window.__sentinel`) is unchanged after a snippet attempts `self.parent?.__sentinel = 'pwned'`. |
| **SEC-31** | No filesystem, `require`, or module-from-disk access: Node built-ins are absent in the browser tier.                                                                                  | browser    | Assert `typeof require === 'undefined'`; assert `import('fs')` / `import('node:fs')` rejects (or resolves to a shim, never the real module); assert no `process.binding`/`process.dlopen` is present.                                                                              |
| **SEC-32** | No real environment or secrets: `process.env` is absent or returns only documented demo values; nothing resembling a real credential is present in scope.                             | both       | Assert `typeof process === 'undefined'` **or** `process.env` is an empty/demo-only object; grep the entire injected `scope` (recursively) for credential-shaped values and assert none are real (only documented demo tokens).                                                     |
| **SEC-33** | Node-only surfaces (`keychain`, `env`, `cookieSession`, JSONL trace) run **shimmed** in the browser tier and emit a **visible notice**; they never touch real OS keychain / env / fs. | browser    | Run a snippet using `keychain(...)`; assert it resolves with the documented demo value, that a notice ("running shimmed — `keychain` is simulated") appears in `result.logs`/trace, and that no real keychain/fs API was invoked (spy on the shim).                                |
| **SEC-34** | The injected scope is a **controlled allowlist**: the snippet sees only `stitch` build exports + captured `console` + sim `fetch` + documented helpers — not arbitrary host globals.  | both       | Enumerate the snippet's reachable global names; assert the set is a subset of the documented allowlist and excludes host-only globals (e.g. the docs app's bundler runtime, analytics, router).                                                                                    |
| **SEC-35** | Captured `console.*` does not leak to the host page console; it is recorded into `RunResult.logs` in order.                                                                           | both       | Spy on the host `console.log`; run a snippet that logs 3 lines; assert the host console spy recorded **0** calls and `result.logs` has the 3 entries in order with correct levels.                                                                                                 |

---

## 6. No state bleed (SANDBOX §5.4, §9; FR5)

| ID         | Invariant (assertable)                                                                                                                                     | Applies to | How T-α tests it                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SEC-36** | Two consecutive runs share no `globalThis` state: a value set on `globalThis` in run 1 is absent in run 2.                                                 | both       | Run 1: `globalThis.__bleed = 'x'`. Run 2: `console.log(typeof globalThis.__bleed)`; assert run 2 logs `'undefined'`.                                          |
| **SEC-37** | Module/singleton state inside the injected `stitch` build does not persist across runs (e.g. an in-memory cookie jar / memoryStore starts empty each run). | both       | Run 1 writes to a `cookieSession`/`memoryStore`; run 2 reads it; assert run 2 sees an empty store. (Browser: assert a fresh Worker or a reset scope per run.) |
| **SEC-38** | (Server) the isolate is **recycled per run** — heap/global state from run 1 is unreachable in run 2 even under isolate pooling.                            | server     | Pool size 1: run 1 sets an isolate global; run 2 (same pooled worker thread) asserts it is gone — i.e. the isolate was disposed/recreated, not reused dirty.  |

---

## 7. Error containment (SANDBOX §5.6, §9; FR6)

| ID          | Invariant (assertable)                                                                                                                                                                        | Applies to | How T-α tests it                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SEC-39a** | A **runtime** snippet error populates `result.error` with `phase:'runtime'` and **never** rejects `run()`.                                                                                    | both       | Run `throw new Error('boom')`; assert `run()` resolves, `result.error.phase==='runtime'`, `result.error.message` includes `'boom'`, and the promise did **not** reject.            |
| **SEC-39b** | A **transpile** error populates `result.error` with `phase:'transpile'` (with line/column when available) and **never** rejects `run()`.                                                      | both       | Run `const x: = ;` (syntax error); assert `run()` resolves, `result.error.phase==='transpile'`, `line`/`column` present when the transpiler supplies them, promise did not reject. |
| **SEC-39c** | A simulated upstream failure (`?__status=500`, drift, flaky) surfaces as `result.error`/validation failure, not a crash or a `run()` rejection.                                               | both       | Run `await stitch('…?__status=500')`; assert a clean error renders and `run()` did not reject. Run `?__drift=1`; assert Zod validation fails visibly in `result.error`/trace.      |
| **SEC-39d** | An **engine/internal** failure (transpiler failed to load, Worker failed to spawn) MAY reject `run()` — and is distinguishable from a snippet error so the UI does not blame the user's code. | both       | Force a Worker-spawn failure in a test harness; assert the rejection (or distinct internal-error result) is **not** misclassified as a snippet `transpile`/`runtime` error.        |

> **Contract anchor:** [`runner.ts`](./component/runner.ts) `CodeRunner.run` — "MUST NOT reject for
> _snippet_ errors … MAY reject only for engine/internal failures." SEC-39a..d pin both halves.

---

## 8. Server tier additions (SANDBOX §6 — Phase 3, deferred)

These are ratified now so **SR1** codes against them; T-α marks them `skip` until the
run-service exists.

| ID         | Invariant (assertable)                                                                                                                                                                          | Applies to | How T-α tests it                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SEC-40** | Each run executes in a **fresh, network-less isolate** with no fs, no `require`, and only the injected sim `fetch`.                                                                             | server     | In an isolate run, assert `fs`/`require`/real `fetch` are all absent and a real-host fetch sandbox-404s without a socket (reuses SEC-02/03/31 inside the isolate).                |
| **SEC-41** | A **per-IP rate limit** is enforced: a flood from one IP degrades to a "please wait" response, not a crash or unbounded spawn.                                                                  | server     | Fire N+1 requests from one IP within the window where the cap is N; assert request N+1 returns the documented rate-limit response (HTTP 429-class) and the service stays up.      |
| **SEC-42** | A **global concurrency queue / backpressure** caps in-flight isolates: excess load queues, it does not exhaust the worker-thread pool or OOM the box.                                           | server     | Submit more concurrent long runs than the pool size; assert excess requests queue (bounded wait) and the process memory/handle count stays bounded; no run is silently dropped.   |
| **SEC-43** | Isolate wall-clock + CPU + memory caps are enforced server-side (mirror of SEC-20/23 in the isolate).                                                                                           | server     | Reuse the SEC-20 (loop) and SEC-23 (memory) snippets against the isolate; assert each is killed and the response is a clean resource error.                                       |
| **SEC-44** | The isolate is **recycled per run** (no reuse-dirty) — same invariant as SEC-38, asserted at the service boundary.                                                                              | server     | Two sequential requests routed to the same pooled thread; assert no global/heap carryover (see SEC-38).                                                                           |
| **SEC-45** | If the hardened-`worker_threads` fallback (SANDBOX §6.2) is used instead of `isolated-vm`, it still satisfies SEC-40/43/44 (frozen globals, no `require`, injected sim `fetch`, time/mem caps). | server     | Run the SEC-40/43/44 suite against whichever isolation backend is configured; both backends must pass the same assertions (the `CodeRunner` swap must not weaken the guarantees). |

---

## 9. Dispatch safety (SANDBOX §3)

The scan is a routing heuristic, not a security control — but its **safe-default direction** is a
contract: untrusted ambiguity must never be silently sent to the (more privileged) isolate.

| ID         | Invariant (assertable)                                                                                                                                                         | Applies to | How T-α tests it                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SEC-46** | A clear Node-only reference routes to the server runner **only if the server tier is built**; otherwise it routes to browser + shim + visible notice (never silently dropped). | both       | With the server tier disabled, run a `keychain` snippet; assert `scanSurface(code).tier` resolves to `browser` execution with the shim notice (SEC-33). With it enabled, assert it routes to `server`.                             |
| **SEC-47** | **Ambiguous / dynamic** Node-only access (e.g. `core['key'+'chain']`) routes to the **SAFE default** (browser + shim + notice), never silently to the isolate.                 | both       | Run a snippet with computed/dynamic surface access; assert `scanSurface(code).ambiguous === true` and the chosen tier is `browser` (shimmed), **not** `server`. Assert there is no input that makes `ambiguous` route to `server`. |
| **SEC-48** | Routing is fail-safe: if the scan throws or is uncertain, the default is the browser tier, not the isolate.                                                                    | both       | Feed the scanner malformed/unparseable input; assert it does not throw uncaught and the dispatcher falls back to the browser tier.                                                                                                 |

---

## 10. Coverage map — every SANDBOX §9 acceptance line maps to ≥1 SEC-id

Each §9 checkbox below names the SEC invariant(s) that make it testable. **No §9 line is
left without a security/behaviour invariant.**

| SANDBOX §9 acceptance line                                                                                       | Covered by                                     |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `stitch('…/users/2')` renders log + value + `StitchTraceEntry` + `done · <ms>`                                   | SEC-02, SEC-35 (capture), SEC-05 (determinism) |
| `?__status=500` renders a clean error, does **not** reject `run()`                                               | SEC-39c, SEC-39a                               |
| `?__stream=sse` / LLM endpoint renders streamed output incrementally                                             | SEC-26 (streamed path exercised), SEC-02       |
| `?__drift=1` makes on-the-fly Zod validation fail visibly                                                        | SEC-39c                                        |
| `while(true){}` is **killed** at `timeoutMs`                                                                     | SEC-20, SEC-21, SEC-24                         |
| **Stop** aborts an in-flight streamed response via `signal`                                                      | SEC-25, SEC-26, SEC-27                         |
| Unknown host renders the sandbox-404, with **no** real request                                                   | SEC-03, SEC-04, SEC-02                         |
| `keychain` runs in browser **shimmed** with a visible notice (and, once Phase 3, routes to the isolate for real) | SEC-33, SEC-46, SEC-47                         |
| No `globalThis` state bleed between two consecutive runs                                                         | SEC-36, SEC-37, SEC-38                         |

**Plus** the §7 security-model lines that §9 does not separately enumerate, also pinned here so
nothing in §7 is untested: no ambient authority → SEC-30/31/32/34; CSP backstop → SEC-10..13;
server blast radius (capped, network-less, recycled, rate-limited) → SEC-40..45.

---

## 11. Invariant count & sign-off

**38 invariants defined** (SEC-01..05, SEC-10..13, SEC-20..27, SEC-30..38, SEC-39a..d, SEC-40..48).

-   **Phase-2 (browser, must pass for sandbox v1):** SEC-01..05, SEC-10..13, SEC-20/21/22/24,
    SEC-25..27, SEC-30..37, SEC-39a..d, SEC-46..48.
-   **Phase-3 (server, `skip` until SR1):** SEC-23, SEC-38, SEC-40..45.

T-α implements the "How T-α tests it" column verbatim as assertions and wires the §10 coverage
map into a CI gate: **sandbox v1 ships only when every Phase-2 row is green.**

---

## Appendix A — Where SANDBOX's security model was underspecified or self-contradictory

Flagged for @rejifald to resolve **before** downstream tasks (T-α, R1, D1, SR1) rely on it. None
block writing the invariants above, but each one is a place where a runner author could make a
defensible-but-wrong call:

1. **(A) Browser Worker memory cap is unspecified.** §6.1 gives the _server_ isolate a memory cap,
   but §5 gives the browser Worker only `timeoutMs`. A Web Worker has **no portable per-Worker
   memory limit** — a memory-bomb in the browser tier can only be bounded by `timeoutMs` + the
   browser/OS tab limit. SEC-23 is therefore scoped `server`-only. _Resolve:_ confirm browser tier
   accepts "no hard memory cap, time-bounded only," or add an allocation-watchdog heuristic.

2. **(B) CSP exact directive set is deferred to the spike but T-α needs a concrete target.** §5/§7
   say "validate `connect-src`/`worker-src` in the Phase-2 spike" without pinning values. I encoded
   the **intent** (`connect-src 'self'`, `worker-src 'self' blob:`, no wildcard) in SEC-10/11.
   _Resolve:_ ratify those exact strings (esp. whether the Worker is a `blob:` URL, which forces
   `worker-src blob:`, and whether transpile needs `wasm-unsafe-eval`) so SEC-10/11/13 assert exact
   tokens rather than "no wildcard."

3. **(C) Timeout/abort error taxonomy is unnamed.** §5.6 defines `RunError.phase` as
   `'transpile'|'runtime'`, but a **timeout** and an **abort** are neither cleanly — they are
   runtime-phase terminations with distinct causes. The UI (and SEC-20/25) needs to tell "your code
   timed out" from "you hit Stop" from "your code threw." _Resolve:_ decide whether to add a
   discriminator (e.g. `RunError.reason: 'timeout'|'abort'|'throw'`) — this is an **additive contract
   change owned by C1**, not C2. Until then SEC-20/25 assert on `error.name`, which is weaker.

4. **(D) "Internal failure MAY reject `run()`" vs "rich error UI" tension.** `runner.ts` lets
   engine/internal failures reject `run()`, but §9/the UI assume every failure is a renderable
   `RunResult`. If a Worker fails to spawn, does the UI get a rejection (and must try/catch) or a
   `RunResult` with an internal-error marker? SEC-39d asserts _distinguishability_ but not _which
   shape_. _Resolve:_ pick one (recommend: always resolve a `RunResult`, reserve rejection for truly
   unrecoverable harness bugs) so R1/U1 agree.

5. **(E) Shim "visible notice" channel is unspecified.** §5.7/§9 require a visible notice when a
   Node-only surface is shimmed, but the contract has no dedicated field — is the notice a
   `LogEntry` (`level:'warn'`), a `StitchTraceEntry`, or new metadata? SEC-33 asserts "appears in
   logs/trace," deliberately loose. _Resolve:_ pick the channel (additive, C1-owned) so the test and
   the UI assert the same place.

6. **(F) Per-IP rate-limit and concurrency-cap numbers are absent.** §6.1 mandates a per-IP limit and
   a global queue but gives no N (requests/window) or pool size. SEC-41/42 assert the _behaviour_
   (degrade, don't crash) but cannot assert a threshold. _Resolve (Phase-3, low urgency):_ set
   concrete defaults when SR1 is scoped.

7. **(G) Determinism vs `signal`/latency timing.** §4.3 mandates seeded determinism with "no
   wall-clock," yet §4.2 simulates `__latencyMs` and streaming — which are inherently time-based.
   The reconciliation (latency/stream _timing_ is real, but response _content_ is seeded/deterministic)
   is implied but not stated. SEC-05 assumes content-determinism only. _Resolve:_ state explicitly
   that determinism covers response **bytes**, not delivery **timing**, so S2–S5 and SEC-05 don't
   over-claim.
