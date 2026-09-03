# B1 — Browser `stitch` build

> Implements [B1-SPIKE.md](../B1-SPIKE.md) (verdict **GO-WITH-CAVEATS**). A
> browser-targeted build of the `stitch` call API that runs in a Web Worker with
> **no `process`** and **no `node:*`**. Codes against FROZEN contracts; does **not**
> modify `packages/core`. Downstream: **R1** (Worker runner injects this build),
> **D1** (dispatcher).

## What this is

A thin **docs-side entry** that re-exports core's browser-safe surface and shims the
Node-only surfaces (B1-SPIKE §6). `packages/core` is untouched.

> **Update — core is now isomorphic (GAP-AUDIT §1.5, PR #102).** Core no longer has
> static `node:*` imports or bare `process`; it reaches optional Node facilities
> through `globalThis.process?.getBuiltinModule('node:fs')` / `globalThis.crypto`,
> which are absent in a Worker (→ safe no-op defaults). So the old
> `node:crypto|fs|path` bundler aliases and the `process` **define** were **removed**,
> and the `node-crypto.ts` / `node-fs.ts` / `node-path.ts` shims **deleted**. The only
> build knob left is the `stitchapi` alias (resolve core's source without a build).
> The `process` object is still provided to the **snippet scope** — but by runtime
> injection (`worker-main.ts` → `WorkerEnv`), not a define. Sections below that
> describe the aliases/define are kept only as spike history.

```
docs/sandbox/runtime/
  stitch-browser.ts          ← THE ENTRY. Re-exports core's browser-safe surface,
                                wires the shimmed Node-only surfaces + server stubs.
  build-stitch-browser.mjs   ← esbuild build script (stitchapi alias), emits ESM.
  B1-README.md               ← this file.
  shims/
    process.ts               ← `process` object injected into the snippet scope
    notices.ts               ← RunNotice collection channel (drainNotices)
    otlp-browser.ts          ← the `otlp` namespace rebuilt: no-op exporter (no
                               egress) + shimmed sink, `json` verbatim
    node-surfaces.ts         ← keychain/env (demo values) + cookieSession (in-mem jar)
    server-tier-stubs.ts     ← cli/serve/mcp throwing stubs (server-tier only)
```

(`transpile.ts` in this directory is owned by task **R2** — not part of B1.)

## How the build is produced

One knob — core's browser-isomorphism (GAP-AUDIT §1.5) retired the other two:

- **alias** `stitchapi → packages/core/src/index.ts` so the bundle resolves
  **without `pnpm install`** (zod is unused in the reachable graph — B1-SPIKE §1).
  In R1's installed workspace this alias is unnecessary; point it at the published
  entry instead.

`sideEffects:false` on `packages/core` drops `cli/serve/mcp/registry`.

### Run it

```bash
# Workspace with esbuild installed:
node docs/sandbox/runtime/build-stitch-browser.mjs           # → /tmp/b1-out/stitch-browser.mjs
OUT=/tmp/stitch-browser.mjs node docs/sandbox/runtime/build-stitch-browser.mjs

# Deps not installed (spike method): point ESBUILD at any esbuild build:
ESBUILD=/abs/path/to/esbuild/lib/main.js \
  node docs/sandbox/runtime/build-stitch-browser.mjs
```

### Equivalent esbuild CLI (the spike's `npx` method)

```bash
npx -y esbuild docs/sandbox/runtime/stitch-browser.ts \
  --bundle --format=esm --platform=browser --target=es2022 \
  --alias:stitchapi=packages/core/src/index.ts \
  --outfile=/tmp/b1-out/stitch-browser.mjs
```

## The shim list (what each stands in for)

The Node built-ins (`node:crypto`/`fs`/`path`) and `process.env` are **no longer
shimmed** — core handles them isomorphically (GAP-AUDIT §1.5). What remains are the
Node-only **surfaces** the browser entry deliberately replaces with sandbox policy:

| Surface                  | Shim                   | Behaviour                                                                                |
| ------------------------ | ---------------------- | ---------------------------------------------------------------------------------------- |
| `keychain(name)`         | `node-surfaces.ts`     | documented **demo value** + `RunNotice{kind:'shim'}`                                     |
| `env(name)`              | `node-surfaces.ts`     | documented **demo value** + `RunNotice{kind:'shim'}`                                     |
| `cookieSession`          | `node-surfaces.ts`     | core's pure-JS strategy; **in-memory jar** (lives in the StitchStore) + notice           |
| `createTrace`            | `stitch-browser.ts`    | JSONL = no-op; **console forced off** (trace via StitchTraceEntry); notice if a file set |
| `otlp` (whole namespace) | `otlp-browser.ts`      | `sink`/`exporter`: **no-op exporter, zero network egress** + notice; `json` verbatim     |
| `cli` / `serve` / `mcp`  | `server-tier-stubs.ts` | **throw** — server-tier only                                                             |

### Shim-notice channel

Shimmed Node-only surfaces emit a `RunNotice { kind:'shim', surface, message }`
(the FROZEN shape from `contracts/runner.ts`) into `shims/notices.ts`. The runner
(R1) calls **`drainNotices()`** after each run and puts the result on
`RunResult.notices` so the UI can show "ran `keychain` shimmed" (SANDBOX §5.7).
Notices are deduped per surface+message, so a hot-path surface called N times shows
one line. **No contract was widened** — `RunNotice` is reused structurally.

## Verification

Current (post-§1.5): `pnpm --filter @stitchapi/docs run build:sandbox` builds the
Worker bundle Node-free, and `browser-runner.test.ts` passes. The bundle contains
**no** `node:` import and no bare `process` identifier — core is isomorphic, so this
holds without any node:\*/process bundler shims.

Historical (spike, kept for record): the standalone `stitch-browser.mjs` built to
`/tmp` and a run-probe with `globalThis.process = undefined` + Web Crypto present
confirmed the surface constructed and ran Node-less — back when core's Node bits were
shimmed by the aliases/define this README originally documented.

## Blockers / must-knows R1 (and D1) MUST honor

Lifted from B1-SPIKE §7, plus what this implementation adds:

1. **`process` in the snippet scope.** Web Workers have no `process`. Core doesn't
   need one (it reads the guarded `globalThis.process?.env` seam → safe defaults), but
   a snippet might write `process.env.*`. `worker-main.ts` injects a JSON-shaped
   `process` (`env`, `platform`, `versions`) as `WorkerEnv.process`, which
   `worker-entry.ts` binds as the snippet's `process` param — **do not add a
   `process.stderr`**; see #4. (There is no `--define:process` anymore.)
2. **Web Crypto in the Worker.** `crypto.randomUUID` / `crypto.getRandomValues` are
   available in Workers. Core uses `globalThis.crypto` directly (engine write path /
   otlp span ids) — no `node:crypto` alias needed. `worker-main.ts` also passes
   `crypto` into the snippet scope (whose `globalThis` is shadowed).
3. **No-op OTLP.** Real OTLP egress is server-tier only. The browser build's default
   exporter is a no-op (`otlp-browser.ts`) — do **not** rely on CSP `connect-src`
   alone (SANDBOX §7). `otlp` is in `NODE_ONLY_SURFACES`,
   so a snippet naming them routes to the server tier when it exists; pre-server it
   runs shimmed-with-notice.
4. **Core's `createTrace` console path probes `process.stderr`.** In a Worker there is
   no `process`, so core's console branch falls back to `console.error` (no crash). To
   keep trace OUT of the captured `console.*` stream, the browser entry still **forces
   `console:false`** in `createTrace`. R1 must NOT re-enable core console trace in the
   browser (and must not set `STITCH_TRACE_CONSOLE=1` in any injected `process.env`).
   Trace is surfaced via `StitchTraceEntry`, not stderr.
5. **The `stitchapi` alias is a spike/no-install convenience.** It points at
   `packages/core/src/index.ts`. In R1's installed workspace, drop the alias (or
   point it at the package's published ESM entry) — the result is the same or better
   (B1-SPIKE §7).
6. **Determinism (D1/UI):** `keychain`/`env` demo values are stable
   (`demo-<NAME>-secret`) so snapshots are reproducible (SANDBOX §4.3). The actual
   secret is never real; the dispatcher's `NODE_ONLY_SURFACES` routing list needs
   **no change** (B1-SPIKE §7).

## Out of scope

`cli`/`serve`/`mcp` (server tier, Tier-3 §7), the fake-API simulator
(`@stitchapi/sandbox-sim`, task S\*), the transpiler (`transpile.ts`, R2), and the
Worker runner itself (R1). This task delivers only the browser `stitch` build + its
shims and proves it bundles and runs Node-free.

```

```
