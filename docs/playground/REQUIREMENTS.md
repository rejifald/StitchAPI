# Playground Execution Engine — Shape & Requirements

> **Status:** contract defined, implementation **DEFERRED.** > **Snapshot date:** 2026-06-11
> **Decision to build in-house:** [RATIONALE.md](./RATIONALE.md) · **Options rejected:** [COMPETITORS.md](./COMPETITORS.md) · **Contract:** the `CodeRunner` interface in §1 below

This document defines what the in-browser code-execution engine must be and do, so
the playground UI and the docs can be built against a stable contract before the
engine itself exists.

The engine is the hard part. It is intentionally deferred. Everything here is the
_specification_ the deferred work must satisfy — not a description of shipped code.

---

## 1. Purpose & scope

A docs reader edits a `stitch()` snippet in the browser, hits **Run**, and sees the
result inline — console output, the resolved response, and (later) a build-stitch
diagram. The engine is the piece that **transpiles and executes** that snippet.

**In scope:** transpile TS/JSX → JS, execute with an injected scope, await async
results, capture console, surface errors, expose structured stitch traces.

**Out of scope (handled elsewhere):** the editor (CodeMirror 6), the same-origin
proxy that injects secrets, and the browser build of `stitch`. Those are dependencies
of the engine, specified at a high level in §6–§7 and tracked as separate work.

**The contract** every implementation conforms to is the `CodeRunner` interface:

```ts
interface CodeRunner {
    readonly id: string;
    run(req: RunRequest): Promise<RunResult>; // never rejects for *snippet* errors
    dispose?(): void;
}
```

Two trivial implementations frame the work: a deferred stub (returns a "not
implemented" error) and a mock runner (canned output, to build the UI against).
The deferred work is the real implementation — `InHouseRunner` — that actually
runs code.

---

## 2. Functional requirements

| #       | Requirement                                                                                                                                                                                                                                                                                                                      |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FR1** | **Transpile in-browser.** Accept TypeScript + JSX, strip types, emit runnable JS. Erasure only — no type-checking (see §5, transpiler choice).                                                                                                                                                                                   |
| **FR2** | **Execute same-origin.** Code runs **in-page or in a same-origin iframe on the docs origin** — never a foreign-origin bundler iframe. This is what keeps `fetch('/api/…')` same-origin against the allowlisted proxy with zero CORS. Non-negotiable; it is the reason we are not using Sandpack-by-default (see COMPETITORS.md). |
| **FR3** | **Async-first.** Support top-level `await`. `stitch()` returns a promise; the engine wraps the snippet in an async IIFE, awaits the final promise, and surfaces its resolved value as `RunResult.value`. (react-live's weakness here is a primary reason it was rejected.)                                                       |
| **FR4** | **Capture console.** Intercept `console.log/info/warn/error/debug` in execution order into `RunResult.logs`, preserving raw args so the renderer can format objects. Must not leak to the host page console.                                                                                                                     |
| **FR5** | **Injected scope.** Expose a controlled set of globals to the snippet (at minimum `stitch`), via `RunRequest.scope`. No implicit access to the host `window`/`globalThis`. Each run gets a fresh scope — no state bleed between runs.                                                                                            |
| **FR6** | **Distinct errors.** Separate transpile errors from runtime errors (`RunError.phase`), with line/column when available. A failing snippet resolves with `result.error` populated — it does **not** reject the `run()` promise.                                                                                                   |
| **FR7** | **Cancellation & timeout.** Honor `RunRequest.signal` (Stop button, route change) and a `timeoutMs` hard cap. A hung request must be abortable; the proxy fetch is wired to the same signal.                                                                                                                                     |
| **FR8** | **Structured stitch trace.** Beyond console, expose each `stitch()` call as a `StitchTraceEntry` (request/response/timing, and `dependsOn` for composed pipelines) so the output panel can render a response card and a **Mermaid build-stitch DAG** — the payoff that justified building in-house.                              |

---

## 3. Non-functional requirements

| #                         | Requirement                                                                                                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NFR1 — Lightweight**    | The execution core (transpile + eval + capture) is small. The editor and transpiler are **lazy-loaded** so docs pages that don't run code pay ~nothing. Target: no measurable hit to first load of a prose page.                 |
| **NFR2 — Security**       | The engine `eval`s visitor-typed code. It must isolate that code from the docs app (see §8). The **real trust boundary is the server-side proxy allowlist**, not the eval — the browser can only harm the visitor's own session. |
| **NFR3 — SSR-safe**       | Client-only. Must not touch `window`/`document` at module load, and must not break Fumadocs/Next SSR or static export. Dynamic-import the engine behind the component.                                                           |
| **NFR4 — Swappable**      | Conform to `CodeRunner`. We must be able to swap the transpiler (Sucrase ⇄ Babel), swap in-page ⇄ iframe execution, or fall back to a LiveCodes-backed runner, without touching the playground UI.                               |
| **NFR5 — Theming & a11y** | Output panel and editor follow the docs light/dark theme. Editor is keyboard-accessible; Run/Stop/Reset are real buttons with labels.                                                                                            |

---

## 4. The reference stack (to validate in the spike)

Not yet built; this is the intended composition. See RATIONALE.md §"Reference stack".

- **Editor:** CodeMirror 6 (TS/JSX language + theme sync). Lighter than Monaco; richer than a Prism textarea.
- **Transpiler:** Sucrase (fast, tiny, TS+JSX erasure — what `react-runner` uses). Fallback: `@babel/standalone`.
- **Execution:** in-page async `Function` constructor with injected scope and captured console:

```ts
const js = transform(code, {
    transforms: ['typescript', 'jsx', 'imports'],
}).code; // sucrase
const fn = new Function(
    'stitch',
    'console',
    `return (async () => { ${js} })()`,
);
const value = await fn(stitchBrowser, capturedConsole);
```

…optionally wrapped in a `<iframe sandbox="allow-scripts allow-same-origin">` served
from the docs origin for DOM isolation while preserving the same-origin fetch (§8).

---

## 5. Transpiler decision points

- **Sucrase vs `@babel/standalone`:** Sucrase is smaller and faster and does exactly
  the erasure we need; Babel is the officially-blessed browser build (it powers the
  Babel REPL / JSFiddle) and bundles `typescript` + `react` presets. Either works —
  Sucrase is the default, Babel the fallback. **esbuild-wasm is overkill** (ships a
  WASM binary) for a fetch-wrapper snippet.
- **No type-checking:** both only erase types. If we want red squiggles for type
  errors later, that's a separate CodeMirror + `@typescript/vfs` concern, not the
  runner's job.

---

## 6. The Node-only API boundary (critical)

`stitch`'s HTTP core is `fetch`-based ([`src/adapters/fetch.ts`](../../src/adapters/fetch.ts)
wraps global `fetch`), so the **call shape runs in a browser**. But several surfaces
are Node-only and **do not exist in the browser** — the engine cannot run them, and
the browser `stitch` build must shim them:

| Surface                                                  | Browser policy                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Secrets resolver (`keychain()` / env-backed credentials) | **Route through proxy** — secret injected server-side; client never sees it. |
| `cookieSession` cookie jar                               | **Shim** to browser cookies / proxy-managed session, or no-op with a notice. |
| `env()`                                                  | **No-op** returning documented demo values, or proxy-provided.               |
| JSONL trace files / filesystem                           | **No-op** in browser; surface the trace via `StitchTraceEntry` instead.      |
| Shell / non-HTTP adapters                                | **Unsupported live** — show recorded output (Tier 3, §7).                    |

> **Open work item:** produce a browser-targeted `stitch` build (from `lib/stitchapi.mjs`)
> that provides these shims so a docs snippet runs unmodified. This is the largest
> unknown in the deferred work — scope it first.

---

## 7. Execution tiers (what can actually run live)

1. **Tier 1 — runs in-browser, zero infra.** Unauthenticated `stitch()` against
   CORS-enabled demo APIs (e.g. `reqres.in`). Pure client-side. **The playground's
   default examples live here.**
2. **Tier 2 — needs the same-origin proxy.** Authenticated / cookie-walled stitches.
   Browser code stays identical (`stitch('https://api/me')`, no token visible); the
   same-origin proxy injects the secret server-side and forwards. This is the live
   demonstration of "capability, not credential."
3. **Tier 3 — cannot run live.** Shell, filesystem, raw sockets, trace files. Show
   recorded output / a static trace; do not pretend to execute.

---

## 8. Security model

- Snippet code runs in the **visitor's own browser**; blast radius is their session.
- **Isolation:** prefer a same-origin `<iframe sandbox="allow-scripts allow-same-origin">`
  so snippet code can't read/modify the docs app's DOM or state, while still reaching
  the same-origin `/api` proxy. In-page eval is acceptable for v1 given the small
  surface, but iframe isolation is the belt-and-suspenders target.
- **The proxy is the trust boundary.** It MUST allowlist destination hosts (no
  arbitrary user-supplied URLs → no SSRF / open relay), inject secrets server-side,
  and rate-limit. Never expose a wildcard "fetch anything" forwarder.
- **CSP:** the eval approach needs a CSP that permits it in the sandbox without
  loosening the rest of the docs site — validate in the spike.

---

## 9. Acceptance criteria for engine v1

The deferred work is "done enough" when, wired into the playground UI with the in-house runner:

- [ ] Running `const u = await stitch('https://reqres.in/api/users/2'); console.log(u);`
      renders the `console.log`, the resolved value, and `done · <ms>`.
- [ ] A TS snippet with annotations (`const n: number = …`) runs (types erased).
- [ ] A failing request (404 / network) renders a clean `RunError`, not a crash, and
      does not reject `run()`.
- [ ] Top-level `await` works without the author wrapping an IIFE themselves.
- [ ] `console.*` is captured in order and does not leak to the host page console.
- [ ] **Stop** aborts an in-flight request via `signal`.
- [ ] A Tier-2 snippet calling an authenticated endpoint succeeds via the proxy with
      **no credential present in the editor source**.
- [ ] No `window`/`globalThis` leakage between two consecutive runs.

---

## 10. Open questions to resolve in the spike

1. **Browser `stitch` build** — how to package `lib/stitchapi.mjs` with the §6 shims
   so snippets run unmodified. (Largest unknown.)
2. **In-page vs iframe** — measure the security/UX tradeoff; pick the v1 default.
3. **Async output rendering** — exact pattern for rendering a resolved `stitch()`
   value + trace + Mermaid DAG in the output panel.
4. **Editor bundle cost** — CodeMirror 6 lazy-loaded weight on the docs page.
5. **Proxy shape** — Next.js Route Handler vs Cloudflare Worker for the allowlisted,
   secret-injecting proxy; where it's deployed relative to the docs origin.
