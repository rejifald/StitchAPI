# Proposal — finish "runs anywhere `fetch` does" (GAP-AUDIT §1.5)

**Status:** implemented in [#102](https://github.com/rejifald/StitchAPI/pull/102) · **Scope:** `packages/core` · **Target branch:** `main`
**Closes:** GAP-AUDIT.md §1.5 ("Runs anywhere fetch does" vs a Node-coupled hot path)

> [!NOTE]
>
> This document is the design record; the change list (§4) and CI-guard design
> (§5) were implemented as written in #102. It is kept in present/future-tense form
> as the rationale that motivated the change.

---

## TL;DR

`installation.mdx` promises the library "runs anywhere `fetch` does — Node, the
browser, and edge runtimes." When the gap audit was written (2026-06-12) that was
false: the call path had bare `node:crypto`/`node:fs` imports, read `process.env`
on every `makeStitch()`, and the package shipped no browser export condition.

**Most of §1.5 has since been remediated** — a platform seam (`util.ts:355-394`,
its own comment cites "GAP-AUDIT §1.5") replaced the static `node:*` imports with
lazy `process.getBuiltinModule('node:fs')`, the `process.env` reads with a guarded
`readEnv()`, and `node:crypto` with `globalThis.crypto`. I verified empirically
(appendix A) that the published root graph **bundles for the browser with zero
`node:` imports and executes end-to-end with no Node globals present.**

Three things remain:

1. **`auth.basic()` still calls `Buffer.from(...)`** (`auth.ts:80`) — the one
   site that throws `ReferenceError: Buffer is not defined` in a browser. This is
   the entire residual hot-path coupling.
2. **No `browser` export condition** in `package.json` — the audit's literal
   third bullet, still open.
3. **The CI guard is static-only.** `test/gaps/browser-bundle.spec.ts` already
   pins "no `node:` specifiers," but it never asserts no `Buffer`, and never
   _executes_ the bundle Node-free — so it does not catch gap #1.

The fixes are small and additive. No architectural change: we keep the realized
design of **source-level isomorphism** (one build, runtime-guarded) rather than a
build-time shim swap.

---

## 1. What §1.5 claimed vs. the code today

Every audit target re-checked against `main` (HEAD `791571d`, core `v0.7.0`):

| §1.5 target                                         | Audit (2026-06-12)            | Today                                                                           | State       |
| --------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------- | ----------- |
| `node:crypto` on the stitch path (`engine.ts`)      | bare static import            | `globalThis.crypto.randomUUID()` + Math.random fallback (`engine.ts:50`)        | ✅ fixed    |
| `node:crypto` in `otlp.ts`                          | bare static import            | `globalThis.crypto.getRandomValues()` + fallback (`otlp.ts:43`)                 | ✅ fixed    |
| `node:fs` in `trace.ts` / `auth.ts` / `drift.ts`    | bare static imports           | lazy `nodeFs()` via `getBuiltinModule` (`util.ts:384`); no-op in browser        | ✅ fixed    |
| `getTrace()` reads `process.env` per `makeStitch()` | unguarded `process.env`       | guarded `readEnv()` (`stitch.ts:167-172`); `undefined` off Node                 | ✅ fixed    |
| `node:path` `dirname`                               | static import                 | pure `dirnameOf()` (`util.ts:390`)                                              | ✅ fixed    |
| `Buffer` in `auth.basic()`                          | (implied by "plus `auth.ts`") | **still `Buffer.from(...).toString('base64')`** (`auth.ts:80`)                  | ❌ **open** |
| no browser export condition                         | absent                        | still absent (`package.json` `exports` has only `import`/`require`)             | ❌ **open** |
| sandbox shimmed it downstream, "nothing upstreamed" | true at the time              | the upstreaming happened; sandbox node/process shims are now redundant for core | ⚠️ see §5   |

The audit's line numbers (`engine.ts:40`, `trace.ts:5-6`, `otlp.ts:7`,
`stitch.ts:128-137,190`) are stale — they predate the seam work and the surfaces
refactor (ADR 0005). The audit doc is untracked ("commit or delete as you see
fit"); §1.5 there can be marked remediated-but-one once this lands.

---

## 2. The realized architecture (and why we keep it)

The remediation took the **better of the two paths** the audit author imagined.
The audit assumed the fix would mirror the sandbox: a separate browser build that
_swaps_ `node:crypto`/`fs`/`path` for shims, selected by a `browser` condition.
Instead, core was made **isomorphic at the source** via a small platform seam:

```ts
// util.ts — the platform seam (browser-safe access to Node facilities)
export function readEnv(name: string): string | undefined {
    return (globalThis as PlatformGlobals).process?.env?.[name];
}
export function nodeFs(): NodeFs | undefined {
    return (globalThis as PlatformGlobals).process?.getBuiltinModule?.(
        'node:fs',
    ) as NodeFs | undefined;
}
export function dirnameOf(path: string): string {
    /* regex dirname, no node:path */
}
```

-   **No static `node:` specifier exists in the reachable graph.** `getBuiltinModule`
    takes `'node:fs'` as a _runtime string_, so a browser bundler never tries to
    resolve it. Off Node, `process` is absent → the optional chain returns
    `undefined` → file features (JSONL trace, drift snapshots, `secretsFile`) become
    explicit no-ops, never crashes.
-   **Crypto uses Web Crypto** (`globalThis.crypto`) with a non-secret Math.random
    fallback for idempotency keys / span ids.
-   **The CLI/HTTP/MCP front doors** (`cli`, `serve`, `mcp`, `registry`) keep their
    honest static `node:` imports. They are **subpath-only** (`stitchapi/serve`,
    etc.) and are _not_ exported from the root barrel, so `import { stitch }` never
    pulls them (verified: they don't appear in the browser bundle; §6).

This is strictly better than a build-time swap: **one published artifact**, no
shim modules to drift out of sync with core, and the "browser-safe" property lives
in the source where it can be unit-tested — not in a downstream build script.

> [!NOTE]
>
> Consequence for the docs sandbox: the four de-Node "knobs" in
> `docs/sandbox/runtime/build-stitch-browser.mjs` and `build-sandbox-worker.mjs`
> (alias `node:crypto`/`node:fs`/`node:path` → shims, `define:process`) are now
> **no-ops for core's reachable graph** — there is nothing left to alias. Their
> shim doc-comments are stale (they still claim `engine.ts` imports `randomUUID`
> from `node:crypto`). Simplifying the sandbox build is a worthwhile _follow-up_
> but is out of scope here (it touches `docs/`, not the published package). The
> sandbox's _policy_ shims — demo secrets for `env()`, no-op OTLP egress under
> CSP, the `RunNotice` channel — are deliberately sandbox-only and must **not** be
> upstreamed: a real browser app may legitimately want `otlpHttpExporter()` to
> `fetch` a collector.

---

## 3. Residual gaps

### Gap 1 — `Buffer` in `auth.basic()` (the only hot-path crash)

```ts
// auth.ts:80 — Buffer is a Node global; undefined in browsers/Workers/edge
const token = Buffer.from(
    `${resolve(opts.user)}:${resolve(opts.pass)}`,
).toString('base64');
```

A browser user calling a stitch with `auth: basic(...)` gets
`ReferenceError: Buffer is not defined` (proven in appendix A, test B). Every
other auth strategy (`bearer`, `apiKey`, `oauth2`, `cookieSession`) is already
browser-clean.

### Gap 2 — no `browser` export condition

`package.json` `exports` declares only `import`/`require`. Nothing tells a
browser-targeting bundler (or a human) that the package is browser-safe, and
nothing distinguishes the browser-legit subpaths from the server-only ones.

### Gap 3 — the guard is static-only

`test/gaps/browser-bundle.spec.ts` asserts the browser bundle (a) builds and
(b) contains no `from "node:"`/`require("node:")`. Both already pass. But:

-   it has **no `Buffer` assertion**, so gap 1 sails through;
-   it is **pure string-matching** — it never runs the bundle, so it cannot prove a
    stitch actually _executes_ where only `fetch` exists ("assert no shims");
-   it covers only `index` + `sse` + `stream`, not the other browser-legit subpaths
    or the server-only ones.

---

## 4. Change list

Four files. All additive; no public API change.

### 4.1 `packages/core/src/auth.ts` — drop `Buffer`

Replace the `Buffer.from` call with an isomorphic UTF-8 base64 helper:

```ts
// Base64 of a UTF-8 string — isomorphic. `btoa` is a global in browsers, Web
// Workers, and Node ≥ 16; TextEncoder (already used across core) bridges UTF-8 →
// the binary string btoa expects, so non-ASCII credentials encode correctly.
function toBase64Utf8(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

export function basic(opts: { user: Secret; pass: Secret }): AuthStrategy {
    return {
        name: 'basic',
        apply(req) {
            const token = toBase64Utf8(
                `${resolve(opts.user)}:${resolve(opts.pass)}`,
            );
            req.headers['authorization'] = `Basic ${token}`;
        },
    };
}
```

Verified **byte-identical** to the old `Buffer` output, including multibyte input
(`user:pâss🔑` → `dXNlcjpww6Jzc/CflJE=` from both). No `!` non-null assertions
(keeps `eslint-suppressions.json` counts unchanged). `String.fromCharCode` over a
`TextEncoder` byte array is the standard btoa/UTF-8 bridge.

### 4.2 `packages/core/package.json` — add the `browser` condition

Add `browser` as the **first** condition on the **9 browser-legit** export
subpaths (root + `testing`, `fingerprint`, `cache`, `graphql`, `sse`, `stream`,
`download`, `xhr`), mirroring `import` (same isomorphic ESM artifact):

```jsonc
".": {
  "browser": { "types": "./lib/index.d.mts", "default": "./lib/index.mjs" },
  "import":  { "types": "./lib/index.d.mts", "default": "./lib/index.mjs" },
  "require": { "types": "./lib/index.d.ts",  "default": "./lib/index.js" }
}
```

Leave `./serve`, `./mcp`, `./registry` **without** a browser condition — a
browser bundler then falls through to `import`/`require`, hits their `node:*`
imports, and errors clearly at build time (these are server-tier; §6). `cli` is
the `bin`, not an export, so it is unaffected.

> [!IMPORTANT]
>
> Because the build is isomorphic, `browser` points at the _same_ ESM file as
> `import` — inert duplication that **cannot drift** (there is no separate browser
> build to fall out of sync). Verify `pnpm --filter stitchapi check:exports`
> (arethetypeswrong) stays green; types are kept consistent (`d.mts` under
> `browser`/`import`), so the `bundler` resolution attw simulates should pass.
>
> _Alternative considered:_ add nothing and rely on isomorphism + the guard. That
> leaves the audit's third bullet literally open and forgoes the bundler signal,
> so the recommendation is to add the condition. _Also optional:_ a top-level
> `"browser"` field for React Native / Metro / browserify, which read it instead
> of `exports` conditions — low value for this package, list it as a follow-up.

### 4.3 `packages/core/test/gaps/browser-bundle.spec.ts` — harden the guard

Extend the existing file (see §5 for the full design):

-   add a **`Buffer` pin** to the static bundle check (catches gap 1);
-   parametrize the static check over **all 9 browser-legit subpaths**;
-   add **negative pins**: `serve`/`mcp`/`registry` must _fail_ to bundle for the
    browser (regression-pins the server/browser split);
-   add a **behavioral test**: bundle `src/index.ts`, run it in a Node-free `vm`
    context (no `process`/`Buffer`/`require`), execute a stitch, assert it returns
    and sets the right `Authorization` header.

### 4.4 `apps/docs/.../getting-started/installation.mdx` — make the promise true

The promise on `installation.mdx:7-8` ("runs anywhere `fetch` does — Node, the
browser, and edge runtimes") becomes accurate once 4.1 lands. No copy change is
required; optionally add a one-line note that `basic()` auth is now isomorphic
(uses `btoa`, not `Buffer`). If this lands as a stacked docs PR, note the
pre-push gate runs `build-docs` over the whole tree (see repo memory).

---

## 5. CI-guard design

Goal: a **mechanical** gate so the hot path can never silently re-acquire a Node
coupling. Lives in `packages/core/test/gaps/browser-bundle.spec.ts`, runs under
`pnpm -r test` → `.github/workflows/verify.yml` (esbuild resolved via the existing
`tsup` hop — no new dependency). Three layers:

### Layer 1 — static bundle matrix (extend what exists)

For each **browser-legit** entry (`index`, `graphql`, `sse`, `stream`,
`download`, `cache`, `fingerprint`, `xhr-adapter`, `testing`): esbuild
`platform:'browser'`, `write:false`, then assert

-   `errors === []` (resolves with no unshimmed `node:*`),
-   output does **not** match `/from\s*["']node:|require\(["']node:/` (the existing
    narrow regex — correctly ignores the `getBuiltinModule("node:fs")` _string_),
-   **new:** output does **not** match `/\bBuffer\b/`,
-   output length `> 0`.

Keep the existing `sse`/`stream` "no `EventSource`" pin and the bundle-frugal
pins (`index`/`engine` don't statically import a streaming surface).

### Layer 2 — server/browser split (new, negative)

For each **server-tier** entry (`serve`, `mcp`, `registry`): assert the browser
bundle **fails** (`errors.length > 0`). This pins the boundary: if someone hoists
a `node:*` import into a shared module that the root pulls, layer 1 flips red; if
someone accidentally makes `registry` browser-clean, this layer flips and forces a
conscious decision.

### Layer 3 — behavioral "no shims" execution (new — the heart of the guard)

Bundle `src/index.ts` for the browser as CJS, then run it in a `node:vm` context
whose global has **only real browser primitives** — `crypto` (Web Crypto),
`fetch` (a stub), `Response`/`Headers`, `TextEncoder`/`TextDecoder`, `URL`,
`btoa`/`atob`, timers — and **none** of `process`, `Buffer`, `require`, `global`,
`__dirname`. Assert up front that none of those banned globals are present
("no shims"), then execute a stitch:

```ts
test('the browser bundle executes a stitch with zero Node globals', async () => {
    const code = await bundleForBrowser('src/index.ts', 'cjs');

    let captured;
    const moduleObj = { exports: {} };
    const sandbox = {
        module: moduleObj,
        exports: moduleObj.exports,
        crypto: webcrypto,
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        btoa,
        atob,
        Response,
        Headers,
        AbortController,
        setTimeout,
        clearTimeout,
        queueMicrotask,
        console,
        fetch: async (url, init) => {
            captured = { url, headers: init?.headers ?? {} };
            return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        },
    };
    vm.createContext(sandbox);
    // "assert no shims": none of these were injected.
    for (const k of ['process', 'Buffer', 'require', 'global', '__dirname'])
        expect(k in sandbox).toBe(false);

    vm.runInContext(code, sandbox);
    const { stitch, basic } = moduleObj.exports;

    // The exact §1.5 regression site — basic() must NOT throw "Buffer is not defined".
    const out = await stitch({
        url: 'https://api.test/x',
        method: 'GET',
        auth: basic({ user: 'u', pass: 'p' }),
    })();
    expect(out).toEqual({ ok: true });
    expect(captured.headers.authorization).toBe(`Basic ${btoa('u:p')}`);
});
```

**Prototype evidence (appendix A):** against today's code this harness already
runs a `bearer`-auth stitch end-to-end (returns `{ ok: true }`, sets
`Authorization: Bearer …`) — proving the engine + fetch + the rest of auth work
with zero Node globals — and fails _only_ on `basic()` with the precise
`ReferenceError: Buffer is not defined`. After change 4.1 it goes green. That
red→green is the proof the guard both catches the gap and certifies the fix.

> [!NOTE]
>
> CJS + `vm.createContext` is the pragmatic choice: a fresh vm context's global
> has no `process`/`Buffer`, and CJS avoids `vm.SourceTextModule`'s
> `--experimental-vm-modules` flag. (A real headless-browser/Worker test is
> heavier and already tracked separately as GAP-AUDIT §2.13 for the playground;
> this in-process guard is the cheap, deterministic gate for the _package_.)

---

## 6. Browser / server subpath matrix (measured)

esbuild `platform:'browser'` over every entry (appendix A):

| Subpath export  | Entry            | Bundles for browser?   | static `node:` import | `Buffer` |
| --------------- | ---------------- | ---------------------- | --------------------- | -------- |
| `.`             | `index.ts`       | ✅                     | 0                     | **1** ←  |
| `./graphql`     | `graphql.ts`     | ✅                     | 0                     | 0        |
| `./sse`         | `sse.ts`         | ✅                     | 0                     | 0        |
| `./stream`      | `stream.ts`      | ✅                     | 0                     | 0        |
| `./download`    | `download.ts`    | ✅                     | 0                     | 0        |
| `./cache`       | `cache.ts`       | ✅                     | 0                     | 0        |
| `./fingerprint` | `fingerprint.ts` | ✅                     | 0                     | 0        |
| `./xhr`         | `xhr-adapter.ts` | ✅                     | 0                     | 0        |
| `./testing`     | `testing.ts`     | ✅                     | 0                     | 0        |
| `./serve`       | `serve.ts`       | ❌ (node:http)         | —                     | —        |
| `./mcp`         | `mcp.ts`         | ❌ (node:stream/stdio) | —                     | —        |
| `./registry`    | `registry.ts`    | ❌ (node:fs/path/url)  | —                     | —        |

The single `Buffer` (root, via `auth.basic()`) is the whole of gap 1. Everything
else in the browser-reachable surface is clean today.

---

## 7. Non-goals / risks

-   **Not** introducing a separate browser build. Isomorphism is the design; a
    divergent build would reintroduce the exact drift the audit complained about.
-   **Not** changing OTLP/trace browser _behavior_ in core. `otlpHttpExporter()`
    doing a real `fetch` is correct for a browser app that wants it; the sandbox's
    no-op-egress is a CSP policy that stays in `docs/`.
-   **Not** removing the server-tier subpaths' `node:*` imports. They are honest and
    subpath-isolated; the guard's layer 2 keeps them out of the browser graph.
-   **`btoa` Node floor:** Node ≥ 16 (a global since 16.0). The package has no
    `engines` floor below that; Node 18 is the practical minimum. Low risk.
-   **attw:** the `browser` condition must keep `check:exports` green — verify in
    the PR (types kept consistent; see §4.2).

---

## Appendix A — reproducing the evidence

Run from `packages/core` (deps installed). esbuild is resolved through `tsup`.

1. **Residual-token census** of the browser bundle of `src/index.ts`:
   `Buffer.from` ×1 (in `basic`), `process` only as `globalThis.process?.…`,
   `getBuiltinModule?.("node:fs")`, **0** `from/require "node:"`.
2. **Subpath matrix** (§6): bundle each entry for `platform:'browser'`; the 9
   browser-legit entries succeed (root carries the lone `Buffer`), the 3
   server-tier entries fail to resolve their `node:*` imports.
3. **Behavioral harness** (§5): bundle `index` as CJS, run in a `vm` context with
   no `process`/`Buffer`/`require`; a `bearer` stitch returns `{ ok: true }` and
   sets `Authorization: Bearer …`; `basic()` throws
   `ReferenceError: Buffer is not defined`.

The three scratch scripts used to produce this are in `/tmp` (not committed);
their logic is folded into the layer-1/2/3 tests in §5.
