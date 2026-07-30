# B1 De-Risk Spike — Browser-targeted `stitch` build

> **Status:** Spike complete — **GO-WITH-CAVEATS**. Implementation NOT STARTED.
> **Date:** 2026-06-11 · **Spiker:** B1 (Tier-3)
> **Answers open risk:** [SANDBOX.md](./SANDBOX.md) §10.4 ("browser `stitch` build … largest single unknown") · [REQUIREMENTS.md](../playground/REQUIREMENTS.md) §6, §10.1
> **Keys on:** [`contracts/dispatch.ts`](./contracts/dispatch.ts) `NODE_ONLY_SURFACES` · **Fallback if NO-GO:** [RATIONALE.md](../playground/RATIONALE.md) §"Confidence & escape hatch" (self-hosted LiveCodes)
> **Downstream:** R1 (Worker runner — injects this build), D1 (dispatcher)
> **Note (2026-07):** this is a point-in-time record; `otlpTrace` was renamed to `otlpSink` (and `toValidator` was replaced by `validate`/`compile`) in the 2026-07 contract sweep — the current lists live in `contracts/surface.ts` and `runtime/stitch-browser.ts`.

## Verdict

**GO-WITH-CAVEATS.** A browser-targeted `stitch` build is tractable and _cheap_ — the
entanglement is shallow (3 Node built-ins, 5 modules, all leaf-level), tree-shaking already
drops `cli`/`serve`/`mcp`/`registry`, and a throwaway esbuild bundle with shims **builds clean
and the `stitch()` call path constructs and runs with no `process`/`node:*` present**. The one
caveat that downgrades this from a clean GO: **the hot path is not Node-free as the design
assumed** — `engine.ts` imports `node:crypto` and `stitch.ts` reads `process.env` on every
`stitch()` call. These are real, but each is a one-line shim. No LiveCodes escape hatch needed.

---

## 1. Module-graph reality (Q1)

Entry = [`packages/core/src/index.ts`](../../packages/core/src/index.ts). The barrel re-exports
**only** browser-safe + shimmable surfaces; it does **not** re-export `cli`/`serve`/`mcp`. Every
Node-only import reachable from the barrel, with the surface that pulls it in:

| Module           | Node built-in (import)                                            | Pulled in via barrel by                                               | Reachable from browser-safe surface? | Hot path?                                                                  |
| ---------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `engine.ts:38`   | `node:crypto` (`randomUUID`)                                      | `stitch`/`defineStitch`/`graphql` → `engine`                          | **YES**                              | **YES** — `applyIdempotency()` on writes                                   |
| `stitch.ts:118`  | _(no import)_ `process.env` ×3 read at runtime                    | `stitch` → `getTrace()`                                               | **YES**                              | **YES** — runs on every `makeStitch()`                                     |
| `trace.ts:5-6`   | `node:fs` (`appendFileSync`,`mkdirSync`), `node:path` (`dirname`) | `createTrace`/`multiplex`; also `stitch`→`getTrace()`                 | **YES**                              | Indirect — only if a JSONL `path` is set; default reads `process.env.HOME` |
| `otlp.ts:7,249`  | `node:crypto` (`randomBytes`); `process.env`                      | `otlpSink`/`otlpHttpExporter`; also `stitch`→`getTrace()` import-time | **YES**                              | No (export is lazy) but **imported** on the `stitch` path                  |
| `auth.ts:15`     | `node:fs` (`existsSync`,`readFileSync`); `process.env`; `Buffer`  | `keychain`/`env`/`basic`/`cookieSession`/`oauth2`/`bearer`/`apiKey`   | **YES**                              | No — all call-time inside returned closures                                |
| `drift.ts:11-12` | `node:fs` (4 fns), `node:path` (`dirname`)                        | `drift` (and `engine`→`drift` for snapshot mode)                      | **YES**                              | No — only when `drift({snapshotFile})` is used                             |

**Browser-clean modules (no Node, confirmed):** `http-adapter.ts` (pure `fetch`/`FormData`/`Blob`),
`util.ts`, `resilience.ts`, `store.ts`, `validator.ts`, `standard-schema.ts`, `types.ts`.

**Native/Node-only npm deps:** **none.** `zod` is a _peer-shaped structural_ dependency only
(`validator.ts` duck-types `safeParse`; it is never imported). No `child_process`, `node:net`,
`node:readline`, `isolated-vm`, etc. anywhere in the reachable graph.

**Distinct Node built-ins to shim: just three — `node:fs`, `node:path`, `node:crypto`** (7 import
sites). `node:http` (serve), `node:stream` (mcp, type-only), `node:url` (registry) are **not
reachable** from the barrel.

---

## 2. Is the call core browser-clean? (Q2) — **No, with two leaks**

The design (SANDBOX §3, REQUIREMENTS §6) assumes the Tier-1 call path
(`stitch`→`engine`→`http-adapter`→`resilience`→`drift`→`validator`) is browser-safe. It is **almost**
— `http-adapter`, `resilience`, `validator` are fully clean — but Node creeps in at two points:

1. **`engine.ts:38` `import { randomUUID } from 'node:crypto'`** — top-level import on the hot path.
   Used by `applyIdempotency()` (writes only), but the _import_ loads regardless. Breaks a browser
   bundle even for a read-only `stitch()`.
2. **`stitch.ts:118-127` `getTrace()`** reads `process.env.STITCH_TRACE_FILE` /
   `STITCH_TRACE_CONSOLE` / `STITCH_EXPORT` **on every `makeStitch()`**, and statically imports
   `otlpSink` (→`node:crypto`) and `createTrace`/`multiplex` (→`node:fs`). So constructing _any_
   stitch transitively loads three Node modules and reads `process.env` at runtime. `trace.ts`'s
   default path also dereferences `process.env.HOME`.

Neither is a module-load _side effect_ that touches Node (see Q3) — they're a top-level _import_ and
_runtime_ reads — but both must be handled or the hot path won't load/run in a Worker.

---

## 3. Tree-shakeability & top-level side effects (Q3)

- **`cli`/`serve`/`mcp`/`registry` tree-shake out completely.** They are imported only by each other,
  never by the barrel. Probe 2 confirmed: the bundle contains **0** occurrences of `serveStdio`,
  `selectStitch`, `pathToFileURL`, or `process.cwd`. `package.json` has `"sideEffects": false`,
  which makes this reliable across bundlers.
- **No top-level Node _side effects_ anywhere.** Every `process.env` / `fs` / `crypto` access is
  inside a function body or a returned closure — **nothing executes Node at module-evaluation time**.
  This is the thing that usually defeats a browser bundle; here it is absent. (Verified by grep for
  module-scope `process.`/`Buffer`/`globalThis` and by Probe 5: the shimmed module _evaluates_ with
  `process` set to `undefined` and only throws if a Node path is actually _called_.)
- **The entanglement that remains is import-level, not evaluation-level**: the `node:*` imports in
  the 5 leaf modules are static `import` statements, so a plain `--platform=browser` bundle fails to
  _resolve_ them (Probe 1) — but they are trivially redirectable by alias/`browser` field because
  nothing runs at load. This is the easy kind of entanglement.

---

## 4. Trial bundle — actual errors (Q5)

`node v24`, **no `node_modules` installed** (per spike constraint: did NOT run `pnpm install`).
esbuild fetched via `npx -y esbuild`. The graph needs no workspace/npm deps to resolve (zod
unused), so bundling worked. Artifacts in `/tmp` only.

**Probe 1 — naive browser bundle (`src/index.ts --bundle --platform=browser --format=esm`):**
fails with exactly the predicted unresolved built-ins (verbatim):

```
✘ [ERROR] Could not resolve "node:fs"        src/auth.ts:15:41
✘ [ERROR] Could not resolve "node:fs"        src/trace.ts:5:42
✘ [ERROR] Could not resolve "node:path"      src/trace.ts:6:24
✘ [ERROR] Could not resolve "node:crypto"    src/otlp.ts:7:28
✘ [ERROR] Could not resolve "node:crypto"    src/engine.ts:38:27
✘ [ERROR] Could not resolve "node:fs"        src/drift.ts:11:67
  (7 of 7: node:path in drift.ts:12 also)
```

**Probe 2 — `--external:'node:*'`:** builds clean (47 KB). Confirms the graph is otherwise
fully browser-resolvable and `cli`/`serve`/`mcp`/`registry` are dropped. 7 residual `node:` refs =
exactly the 5 modules above.

**Probe 3/4/5 — `--alias` the 3 built-ins to hand-written browser shims + `--define:process`:**

- Probe 3: alias `node:fs`/`node:path`/`node:crypto` → `/tmp/b1-shims/*.js` → **builds clean,
  0 residual `node:` imports** (8 `process.env` reads remain).
- Probe 4: add `--define:process={"env":{}}` → **0 `process.env` reads remain**, builds clean.
- Probe 5 (the real proof): load the final bundle in a context with `globalThis.process = undefined`,
  import it, call `stitch("https://demo/x")`. Result: all 21 browser-safe exports present;
  `makeStitch` **runs without throwing** and returns a working stitch fn with `.stream`. The hot path
  constructs end-to-end in a Node-less environment.

So: naive bundle fails predictably; **shim+define bundle succeeds and runs.**

---

## 5. Shim effort per surface (Q4)

| Surface                                                                         | Effort               | One-line approach                                                                                                                                                                |
| ------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node:crypto` (`randomUUID`/`randomBytes`) — hot path via `engine`/`otlp`       | **Trivial**          | Web Crypto: `crypto.randomUUID()` / `crypto.getRandomValues`.                                                                                                                    |
| `env()`                                                                         | **Trivial**          | No-op closure returning a documented demo value + a `RunNotice` (REQUIREMENTS §6).                                                                                               |
| `keychain`                                                                      | **Trivial**          | No-op/demo value + notice; `node:fs` aliased to a stub whose `existsSync`→`false`.                                                                                               |
| `process.env` reads (`stitch.ts` getTrace, `trace.ts` HOME, `otlp.ts` endpoint) | **Trivial**          | Bundler `define:process={"env":{}}` (or inject a `process` stub global in the Worker).                                                                                           |
| `createTrace` + `multiplex` (JSONL/fs)                                          | **Trivial**          | `node:fs` aliased to no-op writes; trace already surfaces via `StitchTraceEntry` (SANDBOX §5.7). `multiplex` is pure JS — keep as-is.                                            |
| `cookieSession`                                                                 | **Moderate**         | In-memory cookie jar (the strategy logic is already pure JS in `auth.ts`; only the `node:fs` co-import in the module needs the fs stub). Browser jar reimpl per REQUIREMENTS §6. |
| `otlpSink` / `otlpHttpExporter`                                                 | **Trivial-Moderate** | `randomBytes`→Web Crypto (trivial); real OTLP egress is blocked by CSP `connect-src` anyway — make the default exporter a no-op/sim-routed in browser.                           |
| `cli` / `serve` / `mcp`                                                         | **Out-of-scope**     | Server tier only (REQUIREMENTS §7 Tier-3). Already not in the barrel — nothing to do for the browser build.                                                                      |

No surface is harder than **Moderate**. The "Moderate" ones (`cookieSession`, real OTLP) are
behaviour reimpls, not build blockers — the build itself is unblocked by the trivial alias+define.

---

## 6. Recommended B1 execution shape (GO path)

**Approach: a thin browser entry + bundler alias/define — do NOT fork the source.**

1. **New entry `stitch-browser.ts`** (in the docs/playground build, not `packages/core`): re-export
   the browser-safe surface from `packages/core/src/index.ts`, and re-export _shimmed_ versions of
   `keychain`/`env`/`cookieSession`/`createTrace`/`otlpSink` that emit a `RunNotice` (SANDBOX §5.7).
2. **Bundler config** (esbuild/Vite, whatever R1's Worker build uses), three knobs, all proven above:
    - `alias`: `node:fs`/`node:path`/`node:crypto` → 3 tiny browser shim modules (fs no-op,
      path.dirname regex, crypto via Web Crypto). ~30 lines total.
    - `define`: `process.env` → `{}` (or inject a minimal `process` global into the Worker scope —
      R1's call, since the Worker scope is structured-clone-constrained per SANDBOX §10.2).
    - rely on `sideEffects:false` to drop `cli`/`serve`/`mcp`.
      _Alternative considered:_ a `package.json` `"browser"` field map on `packages/core`. Rejected for
      the spike scope — it edits `packages/core` (out of bounds here) and is heavier than a docs-side
      bundler alias. Revisit only if `stitch-browser` is wanted as a published artifact.
3. **Optional hardening:** lift `randomUUID`/`randomBytes`/`process.env` to small internal helpers
   (`util.ts`) so the source is isomorphic without aliases. Nice-to-have, not required — the alias
   path already works untouched.

**Effort estimate: ~0.5–1 day.** 3 shim files (~30 LOC), one bundler config block, one
`stitch-browser.ts` (~40 LOC), plus the in-memory cookie jar for `cookieSession` (~1–2 hrs) if
Tier-1 examples need it. The risk is retired: the bundle builds and the call path runs today.

---

## 7. Blockers / must-knows for downstream

- **R1 (Worker runner):** the injected `stitch` build needs `process` (or `process.env`) defined in
  the Worker scope **or** the bundle built with `define:process={"env":{}}`. Web Workers have no
  `process`; pick one and document it. Web Crypto (`crypto.randomUUID`/`getRandomValues`) **is**
  available in Workers — the crypto shim is safe there.
- **R1:** `engine.ts` `randomUUID` is on the hot path (write idempotency). The Web Crypto shim covers
  it; just don't forget it when listing aliases.
- **D1 (dispatcher):** `NODE_ONLY_SURFACES` in [`contracts/dispatch.ts`](./contracts/dispatch.ts) is
  accurate for _routing_, but note for the browser-shim path: `env`/`keychain`/`createTrace`/`otlpSink`
  load fine once aliased and run shimmed-with-notice; `cli`/`serve`/`mcp` genuinely cannot run in the
  browser (server-tier only). The scan list needs no change.
- **CSP (SANDBOX §7):** the OTLP default exporter does a real `fetch` to a collector. With
  `connect-src 'self'` it will fail silently (already swallowed), but make the browser build's default
  OTLP exporter a no-op to avoid noise — don't rely on CSP alone.
- **No `pnpm install` was run**; bundle probes used `npx esbuild` against uninstalled source (zod is
  unused so resolution succeeded). R1's real build will run inside the installed workspace — expect
  the same result or better.

---

_Probe artifacts (throwaway, not committed): `/tmp/b1-probe_.mjs`, `/tmp/b1-shims/`.\*
