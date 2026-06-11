# B1 — Browser `stitch` build

> Implements [B1-SPIKE.md](../B1-SPIKE.md) (verdict **GO-WITH-CAVEATS**). A
> browser-targeted build of the `stitch` call API that runs in a Web Worker with
> **no `process`** and **no `node:*`**. Codes against FROZEN contracts; does **not**
> modify `packages/core`. Downstream: **R1** (Worker runner injects this build),
> **D1** (dispatcher).

## What this is

A thin **docs-side entry** + **bundler alias/define** — exactly the spike's
recommended shape (B1-SPIKE §6). `packages/core` is untouched; all of the Node
entanglement is redirected at bundle time.

```
docs/playground/runtime/
  stitch-browser.ts          ← THE ENTRY. Re-exports core's browser-safe surface,
                                wires the shimmed Node-only surfaces + server stubs.
  build-stitch-browser.mjs   ← esbuild build script (alias + define), emits ESM.
  B1-README.md               ← this file.
  shims/
    node-crypto.ts           ← node:crypto alias → Web Crypto (randomUUID/randomBytes)
    node-fs.ts               ← node:fs alias    → no-op writes, existsSync→false
    node-path.ts             ← node:path alias  → regex dirname
    process.ts               ← the `process` value the build `define`s
    notices.ts               ← RunNotice collection channel (drainNotices)
    otlp-browser.ts          ← no-op OTLP exporter (no egress) + shimmed otlpTrace
    node-surfaces.ts         ← keychain/env (demo values) + cookieSession (in-mem jar)
    server-tier-stubs.ts     ← cli/serve/mcp throwing stubs (server-tier only)
```

(`transpile.ts` in this directory is owned by task **R2** — not part of B1.)

## How the build is produced

Three knobs, all proven in the spike (B1-SPIKE §4):

1. **alias** the 3 reachable Node built-ins to the hand-written shims:
   `node:crypto → shims/node-crypto.ts`, `node:fs → shims/node-fs.ts`,
   `node:path → shims/node-path.ts`. These are the *only* three built-ins reachable
   from core's barrel (7 import sites across `engine/otlp/auth/trace/drift`).
2. **alias** `@stitchapi/core → packages/core/src/index.ts` so the bundle resolves
   **without `pnpm install`** (zod is unused in the reachable graph — B1-SPIKE §1).
   In R1's installed workspace this alias is unnecessary; point it at the published
   entry instead.
3. **define** `process` to a JSON literal `{ env:{}, platform:'browser', versions:{} }`
   so every runtime `process.env.*` read inlines and the bundle has **zero residual
   `process.env`**. (Alternative: R1 injects a `process` global into the Worker
   scope — see "Blockers for R1" below.)

`sideEffects:false` on `packages/core` drops `cli/serve/mcp/registry`.

### Run it

```bash
# Workspace with esbuild installed:
node docs/playground/runtime/build-stitch-browser.mjs           # → /tmp/b1-out/stitch-browser.mjs
OUT=/tmp/stitch-browser.mjs node docs/playground/runtime/build-stitch-browser.mjs

# Deps not installed (spike method): point ESBUILD at any esbuild build:
ESBUILD=/abs/path/to/esbuild/lib/main.js \
  node docs/playground/runtime/build-stitch-browser.mjs
```

### Equivalent esbuild CLI (the spike's `npx` method)

```bash
npx -y esbuild docs/playground/runtime/stitch-browser.ts \
  --bundle --format=esm --platform=browser --target=es2022 \
  --alias:node:crypto=docs/playground/runtime/shims/node-crypto.ts \
  --alias:node:fs=docs/playground/runtime/shims/node-fs.ts \
  --alias:node:path=docs/playground/runtime/shims/node-path.ts \
  --alias:@stitchapi/core=packages/core/src/index.ts \
  --define:process='{"env":{},"platform":"browser","versions":{}}' \
  --outfile=/tmp/b1-out/stitch-browser.mjs
```

## The shim list (what each stands in for)

| Surface | Shim | Behaviour |
|---|---|---|
| `node:crypto` `randomUUID` (engine.ts — **hot path**, write idempotency) | `node-crypto.ts` | `crypto.randomUUID()` (Web Crypto; available in Workers) |
| `node:crypto` `randomBytes` (otlp.ts span ids) | `node-crypto.ts` | `crypto.getRandomValues` + faithful `.toString('hex')` |
| `node:fs` (auth/trace/drift) | `node-fs.ts` | no-op writes; `existsSync → false`; `readFileSync` throws ENOENT |
| `node:path` `dirname` (trace/drift) | `node-path.ts` | pure regex `dirname` |
| `process.env.*` (stitch getTrace, trace HOME, otlp endpoint, auth) | `process.ts` via `--define` | `{}` → every read `undefined` → safe defaults |
| `keychain(name)` | `node-surfaces.ts` | documented **demo value** + `RunNotice{kind:'shim'}` |
| `env(name)` | `node-surfaces.ts` | documented **demo value** + `RunNotice{kind:'shim'}` |
| `cookieSession` | `node-surfaces.ts` | core's pure-JS strategy; **in-memory jar** (lives in the StitchStore) + notice |
| `createTrace` | `stitch-browser.ts` | JSONL = no-op; **console forced off** (no `process.stderr`); notice if a file path is set |
| `otlpTrace` / `otlpHttpExporter` | `otlp-browser.ts` | **no-op exporter, zero network egress** + notice |
| `cli` / `serve` / `mcp` | `server-tier-stubs.ts` | **throw** — server-tier only |

### Shim-notice channel

Shimmed Node-only surfaces emit a `RunNotice { kind:'shim', surface, message }`
(the FROZEN shape from `contracts/runner.ts`) into `shims/notices.ts`. The runner
(R1) calls **`drainNotices()`** after each run and puts the result on
`RunResult.notices` so the UI can show "ran `keychain` shimmed" (SANDBOX §5.7).
Notices are deduped per surface+message, so a hot-path surface called N times shows
one line. **No contract was widened** — `RunNotice` is reused structurally.

## Verification (reproduced)

Built to `/tmp/b1-out/stitch-browser.mjs` (51 KB ESM). Grep of the bundle:

```
node:        0
process.env  0
process.X    0      (the only literal "process" tokens left are a build comment
                     and the word "process" inside the cli/serve/mcp error string)
```

Run-probe (`/tmp/b1-out/probe-run.mjs`) with `globalThis.process = undefined` and
global Web Crypto present (Node ≥ 18, matching a Worker):

```
exports present: 24 / 24
construct stitch(): OK   (runs makeStitch()/getTrace() — the process.env hot path)
run stitch(): OK         (executes end-to-end against a stub fetch)
write stitch (idempotency → randomUUID hot path): OK
createTrace() direct: OK (no process.stderr access)
keychain() → demo value + a shim RunNotice collected
serve() throws as expected (server-tier only)
PROBE OK — no ReferenceError, hot path constructed & ran Node-less.
```

## Blockers / must-knows R1 (and D1) MUST honor

Lifted from B1-SPIKE §7, plus what this implementation adds:

1. **`process` in the Worker scope.** Web Workers have no `process`. EITHER build
   with `--define:process={"env":{},...}` (this build does), OR have R1 inject a
   minimal `process` global into the Worker. Pick one; don't do neither. If R1
   injects instead of defining, it MUST be a JSON-shaped object (`env`, `platform`,
   `versions`) — **do not add a `process.stderr`**; see #4.
2. **Web Crypto in the Worker.** `crypto.randomUUID` / `crypto.getRandomValues`
   are available in Workers and back the `node:crypto` alias — including the
   **engine write hot path** (`randomUUID`). Safe; just keep the alias when R1
   wires its own bundler.
3. **No-op OTLP.** Real OTLP egress is server-tier only. The browser build's default
   exporter is a no-op (`otlp-browser.ts`) — do **not** rely on CSP `connect-src`
   alone (SANDBOX §7). `otlpTrace()`/`otlpHttpExporter()` are in `NODE_ONLY_SURFACES`,
   so a snippet naming them routes to the server tier when it exists; pre-server it
   runs shimmed-with-notice.
4. **NEW (this impl): core's `createTrace` console path uses `process.stderr.write`.**
   The `process` define is a JSON literal and cannot carry a `stderr` function, so
   the browser entry **forces `console:false`** in `createTrace`. R1 must NOT
   re-enable core console trace in the browser (and must not set
   `STITCH_TRACE_CONSOLE=1` in any injected `process.env`). Trace is surfaced via
   `StitchTraceEntry`, not stderr.
5. **The `@stitchapi/core` alias is a spike/no-install convenience.** It points at
   `packages/core/src/index.ts`. In R1's installed workspace, drop the alias (or
   point it at the package's published ESM entry) — the result is the same or better
   (B1-SPIKE §7).
6. **Determinism (D1/UI):** `keychain`/`env` demo values are stable
   (`demo-<NAME>-secret`) so snapshots are reproducible (SANDBOX §4.3). The actual
   secret is never real; the dispatcher's `NODE_ONLY_SURFACES` routing list needs
   **no change** (B1-SPIKE §7).

## Out of scope

`cli`/`serve`/`mcp` (server tier, Tier-3 §7), the fake-API simulator
(`@stitchapi/sandbox-sim`, task S*), the transpiler (`transpile.ts`, R2), and the
Worker runner itself (R1). This task delivers only the browser `stitch` build + its
shims and proves it bundles and runs Node-free.
```
