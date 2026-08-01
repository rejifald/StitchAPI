# Playground Test Coverage Map

Maps every SANDBOX §9 acceptance line and every SEC-xx invariant to its evidence:

- **covered-in-node** — asserted by a test that runs in Node/tsx (T-α integration or a named smoke)
- **proven-by-R1-harness** — asserted by the `worker_threads` harness in `browser-runner.test.ts` (real OS-thread isolation)
- **browser-deferred** — needs a Playwright-class harness (real CSP headers, real Worker global, real `fetch` interception at the browser layer)
- **server-deferred** — Phase-3 server tier not yet implemented (SR1); tests marked `skip` per the checklist

---

## 1. §9 Acceptance Criteria

| SANDBOX §9 acceptance line                                                     | Evidence                                                                                                                                                                                                              | Notes                                                                                                                                                                              |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stitch('…/users/2')` renders log + value + `StitchTraceEntry` + `done · <ms>` | **covered-in-node** — `integration.test.ts` checks #22 (GET /users/2 → 200 + correct body); `browser-runner.test.ts` (R1) proves logs + value + stitch trace entry via InProcWorker                                   | Full end-to-end (trace DAG rendered in UI) is browser-deferred                                                                                                                     |
| `?__status=500` renders a clean error, does **not** reject `run()`             | **covered-in-node** — `integration.test.ts` check #1 (status 500 from shim); R1 SEC-39c proves `run()` never rejects for snippet errors                                                                               |                                                                                                                                                                                    |
| `?__stream=sse` / LLM endpoint renders streamed output incrementally           | **covered-in-node** — `integration.test.ts` checks #9/10 (SSE ends with `[DONE]`, token present); `streaming-llm.test.ts` (S3) proves deterministic byte-identical streams                                            | Incremental UI rendering (`onEvent` chunks) proven by R1 A1 tests (`browser-runner.test.ts`); full browser streaming (CSP + real ReadableStream rendering) is **browser-deferred** |
| `?__drift=1` makes on-the-fly Zod validation fail visibly                      | **covered-in-node** — `integration.test.ts` check #3 (drifted payload asserted structurally: `id` is string, `name` absent, `extra` present); `auth-resilience.test.ts` (S4) also covers drift handler                | Zod schema wired to the runner and visible in the UI is **browser-deferred**                                                                                                       |
| `while(true){}` is **killed** at `timeoutMs`                                   | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-20/24 (real `worker_threads` thread with `worker.terminate()`)                                                                                                | True preemptive kill requires a real execution context; CSP-enforced Worker kill is **browser-deferred**                                                                           |
| **Stop** aborts an in-flight streamed response via `signal`                    | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-25 (abort fires → `reason:'abort'`); SEC-26/27 (mid-stream abort, orphaned-fetch check)                                                                       | Real browser Worker + real fetch stream abort is **browser-deferred**                                                                                                              |
| Unknown host renders the sandbox-404, with **no** real request                 | **covered-in-node** — `integration.test.ts` check #11 (unknown host → sandbox-404 with correct body + no real network); `dispatch.test.ts` (S5) T6; `browser-runner.test.ts` SEC-03 via shim                          |                                                                                                                                                                                    |
| `keychain` runs in browser **shimmed** with a visible notice                   | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-33 (shim notice on `RunResult.notices`); `dispatch.test.ts` (D1) SEC-46 (shim notice added by dispatcher); `integration.test.ts` check #15 (tier:server scan) | Phase-3 route to isolate is **server-deferred**                                                                                                                                    |
| No `globalThis` state bleed between two consecutive runs                       | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-36/37 (fresh thread per run; globalThis.\_\_bleed not present in run 2)                                                                                       | Browser Worker isolation (real CSP + Worker scope) is **browser-deferred**                                                                                                         |

---

## 2. SEC-xx Invariants

### 1. No real egress (SEC-01..05)

| ID                                                                                         | Evidence                                                                                                                                                                                                 | Gap                                                                      |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **SEC-01** Snippet sees only sim shim, not platform fetch                                  | **proven-by-R1-harness** — InProcWorker injects scope with only `fetch: simFetch`; `browser-runner.test.ts` exercises the injection                                                                      | Real-browser check (Worker `fetch === injected`) is **browser-deferred** |
| **SEC-02** Known demo host → sim handler, 0 real sockets                                   | **covered-in-node** — `integration.test.ts` checks #21/22 (api.example.com responses come from shim); `dispatch.test.ts` T7                                                                              | Real-socket spy is **browser-deferred**                                  |
| **SEC-03** Unknown host → sandbox-404, 0 real sockets                                      | **covered-in-node** — `integration.test.ts` check #11; `dispatch.test.ts` T6; `browser-runner.test.ts` SEC-03 via shim                                                                                   | Real-socket spy is **browser-deferred**                                  |
| **SEC-04** Non-HTTP egress (WebSocket, EventSource, sendBeacon, remote import) unavailable | **browser-deferred** — requires real browser Worker scope (these are browser APIs absent in Node)                                                                                                        |                                                                          |
| **SEC-05** Sim responses are deterministic                                                 | **covered-in-node** — `integration.test.ts` checks #13/14 (two identical fetches → identical bodies); `streaming-llm.test.ts` (S3) byte-identity check; `auth-resilience.test.ts` (S4) `deepEqual` check |                                                                          |

### 2. CSP backstop (SEC-10..13)

| ID                                                                  | Evidence                                                                                     | Gap |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --- |
| **SEC-10** `connect-src` excludes wildcard egress                   | **browser-deferred** — requires parsing real HTTP response headers served by the docs server |     |
| **SEC-11** `worker-src` restricts foreign Worker URLs               | **browser-deferred** — requires real browser to observe CSP violation                        |     |
| **SEC-12** Direct bypass attempt blocked by CSP (not silently sent) | **browser-deferred** — requires real browser network interception                            |     |
| **SEC-13** CSP `unsafe-eval` confined to Worker context only        | **browser-deferred** — requires real browser with CSP inspection                             |     |

### 3. Resource caps & kill switch (SEC-20..24)

| ID                                                                             | Evidence                                                                                               | Gap |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --- |
| **SEC-20** CPU-bound loop killed at `timeoutMs` → `reason:'timeout'`, resolves | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-20 (ThreadWorker `while(true){}`, < 1 s)       |     |
| **SEC-21** Kill is enforced by terminating the execution context               | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-21 (host ticker kept going during loop)        |     |
| **SEC-22** Sane default `timeoutMs` when caller omits it                       | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-22 (no `timeoutMs` still terminates)           |     |
| **SEC-23** Memory-bomb contained (server isolate)                              | **server-deferred** — Phase-3 `isolated-vm`/`worker_threads` pool not yet implemented                  |     |
| **SEC-24** Hard cap is preemptive, not cooperative                             | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-20/24 (loop never checks signal; still killed) |     |

### 4. Cancellation (SEC-25..27)

| ID                                                                      | Evidence                                                                                             | Gap                                                                      |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **SEC-25** Aborting `signal` aborts run, resolves with `reason:'abort'` | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-25 (ThreadWorker + `setTimeout(abort, 50)`)  |                                                                          |
| **SEC-26** Abort cancels in-flight SSE mid-stream                       | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-25/26 (abort during long run)                | Full SSE mid-stream cancellation in real browser is **browser-deferred** |
| **SEC-27** `signal` wired to both execution context and in-flight fetch | **proven-by-R1-harness** — `browser-runner.test.ts` (dispatcher passes `signal` through per D1 test) | Real orphaned-fetch proof is **browser-deferred**                        |

### 5. Isolation & no ambient authority (SEC-30..35)

| ID                                                        | Evidence                                                                                                                                               | Gap                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| **SEC-30** No DOM/`window` access from snippet            | **proven-by-R1-harness** — ThreadWorker scope has `window: undefined, document: undefined`; `browser-runner.test.ts` SEC-30 (injected scope allowlist) | Real parent `window` read across Worker boundary is **browser-deferred** |
| **SEC-31** No `require`/filesystem from browser tier      | **proven-by-R1-harness** — ThreadWorker scope has `require: undefined`; `browser-runner.test.ts` SEC-31                                                | `import('node:fs')` rejection in real Worker is **browser-deferred**     |
| **SEC-32** `process.env` absent or demo-only              | **proven-by-R1-harness** — InProcWorker/ThreadWorker injects `process: { env: {} }` (demo-only); `browser-runner.test.ts` (scope inspection)           |                                                                          |
| **SEC-33** Node-only surfaces shimmed with visible notice | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-33 (`keychain` → demo value + `notices[0].surface='keychain'`); D1 dispatch.test.ts SEC-46     |                                                                          |
| **SEC-34** Injected scope is a controlled allowlist       | **proven-by-R1-harness** — ThreadWorker/InProcWorker scope lists only documented identifiers; `browser-runner.test.ts` (scope construction)            | Enumerating full global scope in real Worker is **browser-deferred**     |
| **SEC-35** Console captured in order, not leaked to host  | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-35 (host spy records 0 calls; RunResult.logs has 3 entries in order)                           |                                                                          |

### 6. No state bleed (SEC-36..38)

| ID                                                                | Evidence                                                                                                        | Gap                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **SEC-36** `globalThis` state not shared between consecutive runs | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-36/37 (ThreadWorker: `__bleed` set run 1, absent run 2) |                                                                                          |
| **SEC-37** Module/singleton state not shared                      | **proven-by-R1-harness** — fresh Worker per run in ThreadWorker path; `browser-runner.test.ts` SEC-37           | Real Worker recreation proof (not reuse-dirty) in actual browser is **browser-deferred** |
| **SEC-38** Server isolate recycled per run                        | **server-deferred** — Phase-3 pool not yet implemented                                                          |                                                                                          |

### 7. Error containment (SEC-39a..d)

| ID                                                                           | Evidence                                                                                                                 | Gap |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --- |
| **SEC-39a** Runtime snippet error → `phase:'runtime'`, never rejects `run()` | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-39a (`throw new Error('boom')` → resolved result)                |     |
| **SEC-39b** Transpile error → `phase:'transpile'` with line/col              | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-39b (failing transpile → resolved error)                         |     |
| **SEC-39c** Sim failure (`?__status=500`, drift) surfaces as result          | **covered-in-node** — `integration.test.ts` check #1 (500 from shim); check #3 (drift shape verified)                    |     |
| **SEC-39d** Engine/internal failure → distinguishable internal error         | **proven-by-R1-harness** — `browser-runner.test.ts` SEC-39d (Worker factory throws → `reason:'internal'`, not `'throw'`) |     |

### 8. Server tier additions (SEC-40..45)

| ID                                                                   | Evidence            | Gap |
| -------------------------------------------------------------------- | ------------------- | --- |
| **SEC-40** Fresh isolate: no fs/require/real fetch                   | **server-deferred** |     |
| **SEC-41** Per-IP rate limit                                         | **server-deferred** |     |
| **SEC-42** Global concurrency queue                                  | **server-deferred** |     |
| **SEC-43** Isolate wall-clock + CPU + memory caps                    | **server-deferred** |     |
| **SEC-44** Isolate recycled per run                                  | **server-deferred** |     |
| **SEC-45** Hardened `worker_threads` fallback satisfies SEC-40/43/44 | **server-deferred** |     |

### 9. Dispatch safety (SEC-46..48)

| ID                                                                    | Evidence                                                                                                                                             | Gap |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| **SEC-46** Node-only ref routes server (or browser+shim if no server) | **covered-in-node** — `integration.test.ts` check #15 (`keychain` → tier:server); `dispatch.test.ts` (D1) SEC-46 (shim notice added, no double-add)  |     |
| **SEC-47** Ambiguous access → safe default browser, never server      | **covered-in-node** — `integration.test.ts` check #16 (computed access → ambiguous+browser); `dispatch.test.ts` (D1) SEC-47 (multiple dynamic forms) |     |
| **SEC-48** Scan failure/malformed input → fail-safe browser           | **covered-in-node** — `integration.test.ts` check #18 (malformed → no throw, tier:browser); `dispatch.test.ts` (D1) SEC-48                           |     |

---

## 3. Summary Count

| Category                   | Total invariants | Covered-in-node | Proven-by-R1-harness | Browser-deferred          | Server-deferred |
| -------------------------- | ---------------- | --------------- | -------------------- | ------------------------- | --------------- |
| §9 acceptance lines        | 9                | 4               | 5                    | 0 (browser proofs via R1) | 0               |
| SEC-01..05 (no egress)     | 5                | 3               | 1                    | 1 (SEC-04)                | 0               |
| SEC-10..13 (CSP)           | 4                | 0               | 0                    | 4                         | 0               |
| SEC-20..24 (resource caps) | 5                | 0               | 4                    | 0                         | 1 (SEC-23)      |
| SEC-25..27 (cancellation)  | 3                | 0               | 3                    | 0                         | 0               |
| SEC-30..35 (isolation)     | 6                | 0               | 6                    | 0                         | 0               |
| SEC-36..38 (no bleed)      | 3                | 0               | 2                    | 0                         | 1 (SEC-38)      |
| SEC-39a..d (errors)        | 4                | 1               | 3                    | 0                         | 0               |
| SEC-40..45 (server tier)   | 6                | 0               | 0                    | 0                         | 6               |
| SEC-46..48 (dispatch)      | 3                | 3               | 0                    | 0                         | 0               |
| **Total**                  | **38+**          | **11**          | **19**               | **5**                     | **8**           |

**Covered-in-node (T-α integration.test.ts or named smokes):** 11 SEC invariants + 4 §9 lines  
**Proven-by-R1-harness (worker_threads):** 19 SEC invariants + 5 §9 lines  
**Browser-deferred (needs Playwright + real CSP/Worker/fetch):** 5 (SEC-04, SEC-10, SEC-11, SEC-12, SEC-13)  
**Server-deferred (Phase-3, SR1 not yet implemented):** 8 (SEC-23, SEC-38, SEC-40–45)

---

## 4. What is NOT yet proven

The following invariants require infrastructure beyond Node/tsx and are explicitly deferred:

### Browser-deferred (need Playwright or equivalent)

- **SEC-04** — Non-HTTP egress (WebSocket, EventSource, sendBeacon, remote `import()`) blocked. Requires real browser globals.
- **SEC-10** — `connect-src` CSP header value. Requires a running docs server + HTTP response header inspection.
- **SEC-11** — `worker-src` restricts foreign Worker creation. Requires real browser + CSP violation event.
- **SEC-12** — Direct bypass attempt caught by CSP (not silently sent). Requires real browser network layer.
- **SEC-13** — `unsafe-eval` confined to Worker context only. Requires real browser CSP inspection per context.

### Server-deferred (need Phase-3 SR1 implementation)

- **SEC-23** — Memory-bomb contained by isolate memory cap. Requires `isolated-vm` or hardened `worker_threads` pool.
- **SEC-38** — Isolate recycled per run (heap/globals from run 1 unreachable in run 2). Requires pool.
- **SEC-40..45** — All server-tier invariants: network-less isolate, per-IP rate limit, concurrency queue, wall-clock/CPU/memory caps, isolate recycling, fallback equivalence.
