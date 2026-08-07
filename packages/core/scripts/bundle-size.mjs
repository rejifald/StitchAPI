// Bundle-size budget gate for the `stitchapi` core entry.
//
// "Pay only for what you import" is a stated principle; this makes it an enforced
// gate. We measure the TREE-SHAKEN cost of importing from `stitchapi` — what a
// downstream bundler actually emits — minified + gzipped, and fail if any scenario
// exceeds its budget.
//
// Why re-bundle instead of `ls lib/index.mjs`? tsup code-splits shared engine code
// into chunks that several subpath entries import, so the raw entry file is only
// part of the cost and those chunks carry bytes other entries use. Re-bundling each
// scenario with esbuild + tree-shaking reproduces what a consumer's bundler ships —
// the same method bundlephobia uses. The numbers quoted in the READMEs and docs come
// from here; keep them in sync (see memory: core-zero-deps-bundle-size).
//
// Budgets are a deliberate ceiling. Raising one is a conscious act: edit the number
// below and justify it in the PR. Prefer trimming the entry, or moving a new
// capability behind its own subpath import, over bumping the budget.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

// esbuild ships as CommonJS; load it through createRequire so this stays robust
// regardless of ESM/CJS interop.
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const libDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib');

const KB = 1024;

// Each scenario is a real import a consumer writes. `budget` is the min+gzip ceiling.
//
// Budgets raised for 1.0.0-rc.1 (21.5→22.0 / 17.5→17.75 KB): the engine gained
// resource-safety code that lives on the core path and cannot move to a subpath —
// the caller's AbortSignal now interrupts retry/reconnect backoff and throttle waits
// (instead of sleeping out the full delay), the in-memory store opportunistically
// sweeps expired keys, and the throttle reclaims idle per-key/host state. The growth
// (~0.3 KB gzip) buys leak-freedom under long uptime and prompt cancellation; the
// headroom (~0.4 / ~0.3 KB) is deliberately kept tight so the gate stays meaningful.
//
// Budgets raised for 1.0.0-rc.2 (22.0→22.25 / 17.75→18.0 KB): the shape-only,
// BigInt-safe drift snapshot baselines and the secret-query-key registry (now exported
// for custom trace sinks) both sit on the core path; they push the entry to ~22.04 /
// ~17.78 KB gzip. The +0.25 KB step restores the same tight headroom (~0.2 KB) the
// gate is meant to keep.
//
// Budgets raised for `.inspect()` — ADR 0016 (22.25→22.65 / 18.0→18.30 KB): the
// never-throwing raw-body + drift-findings probe is baked into the core path by design
// (ADR 0016 Decision 6 — it reuses 0015's diff/findings, so it ships always, opt-in by
// call, and cannot move to a subpath). The retainRaw/bypassCache run flags, the
// `Inspection` wrapper consumer, and the contract-violation raw-pinning add ~0.19 / ~0.12
// KB gzip (entry ~22.44 / stitch ~18.12). The step restores the same tight ~0.2 KB
// headroom the gate is meant to hold.
//
// Budgets raised for adapter capabilities + the upload-progress teaching note — ADR 0005
// Decision 9 addendum (22.65→22.95 / 18.30→18.55 KB): the built-in adapters now declare a
// `capabilities` descriptor (a positive `supports` list) and the engine emits one `info`
// event when a call asks for upload progress a transport whose `supports` omits it can't
// give (turning a silent dead bar into a teaching note). Both sit on the core path — the
// check is in `execute` and the default `fetch` adapter carries the descriptor — so neither
// can move to a subpath. They add ~0.10 / ~0.04 KB gzip (entry ~22.74 / stitch ~18.34). The
// step restores the same tight ~0.2 KB headroom the gate is meant to hold.
//
// Budgets raised for core composition primitives + the API meta-contract sweep
// (22.95→23.35 / 18.55→18.80 KB): two waves of intentional, already-merged work
// landed on the core path since #362. (1) Composition gained parallel all/any/race
// with auto-cancellation (#368), linked() replacing pipe() as a run scope
// (#369/#370), and variadic argument lists (#371) — core-entry surface, so it lifts
// the whole entry more than `import { stitch }`, which tree-shakes it away. (2) The
// meta-contract sweep (#352, P3–P20) renamed/de-suffixed public fields and co-emits
// the old names as @deprecated runtime aliases (key→keyOf;
// value→data on result envelopes; *Ms duration de-suffixing) — shared code on
// stitch's own path. Together they reach ~23.13 / ~18.61 KB gzip (+~0.39 / +~0.27
// since #362). Neither wave can move to a subpath — composition and the renamed
// result/throttle/circuit surfaces are the core API. The step restores the same
// tight ~0.2 KB headroom the gate is meant to hold.
//
// Budgets raised for the idempotency-misuse nudges + the OTLP-name alignment (23.35→23.55 /
// 18.80→19.0 KB; measured 23.32 / 18.80). Stacking on the wave above, two more things land on the core
// path and can't move to a subpath: (1) two construction-time `idempotency` nudges in
// `makeStitch` — on a read (the key is write-only, so it's silently dropped — almost always a
// missing `method: 'POST'`) and on a random key with no `retry` (it only dedupes the call's own
// retries), both silenced by `idempotency.warn = false`; and (2) the run-identity rename to the
// OTel span names (`runId`→`spanId`, `parentId`→`parentSpanId`, CONTRACT.md P22), whose longer
// public property names are emitted verbatim on every `start` event / trace ctx and can't be
// minified. The step restores the same tight ~0.2 KB headroom the gate is meant to hold.
//
// Budgets raised for the `.inspect()` redaction option + the enhanced result object (23.55→23.95 /
// 19.0→19.45 KB; measured 23.77 / 19.25). Two more ADR-0016 deferrals land on the core path and
// can't move to a subpath — both attach to the core Stitch surface: (1) ADR 0018 adds an opt-in
// `redact` to `.inspect()` (a `redactSecretsDeep` deep-clone scrubber reusing the shared secret-key
// denylist, wired at the `.inspect()` assembly site); and (2) ADR 0019 adds `.report()` returning
// `RunReport<T>` — the `source` discriminator on `Inspection`, plus `attempts`/`timing`/`config`/
// `cache` diagnostics drained off the existing event spine (no new engine events). `.report()` is a
// method on every stitch, so it lifts `import { stitch }` as much as the whole entry — it can't
// tree-shake away. The step restores the same tight ~0.2 KB headroom the gate is meant to hold.
//
// Budgets raised for array drift summarization — ADR 0017 (23.95→24.20 / 19.45→19.70 KB; measured
// 23.99 / 19.48). `classifyDiff` swaps its first-wins `change|path` dedup for group-then-summarize:
// array groups are kept and branched on `detail` homogeneity (homogeneous → one `all N elements: …`
// summary with a concrete-index `sample`; heterogeneous → one finding per distinct detail variant).
// This fixes a real correctness gap — first-wins silently dropped a second, genuinely-different drift
// at the same collapsed `[]` path — so it isn't optional and sits in the shared drift/classify layer
// that feeds both the `drift` event and `Inspection.findings`; it can't move to a subpath. It adds
// ~0.04 / ~0.03 KB gzip. The step restores the same tight ~0.2 KB headroom the gate is meant to hold.
//
// Budgets raised for the cross-origin-redirect credential-leak fix (24.20→24.80 / 19.70→20.00 KB;
// measured 24.60 / 19.80). SECURITY (HIGH): auth strategies put credentials in CUSTOM request
// headers (`apiKey` → `x-api-key`; `awsSigV4` → `authorization` + `x-amz-*`). undici (and axios's
// follow-redirects) strip `authorization`/`cookie` on a cross-origin redirect but NOT custom
// headers, so those keys leaked to a redirect target on another origin (open-redirect / compromised
// endpoint) — a "capability, not a credential" break. The fix makes `fetchAdapter` follow redirects
// itself (`redirect: 'manual'` + a bounded manual-follow loop) and, on a cross-origin hop, drop
// every non-CORS-safelisted request header (auth/cookie/custom); `axiosAdapter` does the same via a
// `beforeRedirect` hook. Both share one tiny origin-check + header-strip helper. This sits on the
// hot request path (fetchAdapter is the default transport, so it lifts `import { stitch }` as much
// as the whole entry) and is browser-safe (no node:*), so it cannot move to a subpath. It adds ~0.43
// / ~0.28 KB gzip. The step restores the same tight ~0.2 KB headroom the gate is meant to hold. The
// cost buys closing a HIGH credential-exfiltration hole — a deliberate trade the maintainer signs off
// on by merging (see PR body for the exact before/after/Δ).
// Budgets raised for the P0 `__config` redaction (24.80→24.90 / 20.00→20.10 KB; measured 24.83 /
// 20.02). CONTRACT.md P0 says the public `__config` is plain JSON data, and it was not: endpoint
// thunks, `transform`, `hooks`, the `paginate`/`retry`/`throttle`/`idempotency`/`cache` derivation
// fns and a live `TraceSink` all rode onto it. That is an exfil-at-rest hole (ADR 0002 §4/§6 — a
// public config view carrying live author closures) and a silent serialisation bug (a function
// vanishes on `JSON.stringify`, corrupting every trace / report / `mcp` view of the stitch), so the
// `stripFns` + `omit` pass is not optional. It sits in `redactConfig`, which every `makeStitch` call
// runs, so it lifts `import { stitch }` as much as the whole entry and cannot move to a subpath.
// The redaction itself is ~0.03 / ~0.02 KB over the OLD ceiling — the branch had been measuring
// against a merge base from six days earlier and `main` had grown underneath it; the `trace` slot
// added last costs 0.00 KB gzip. This is a MINIMUM step (0.07 / 0.08 KB headroom), not the ~0.2 KB
// this gate usually restores: the overflow is small and the maintainer chose the smallest deliberate
// bump that clears it (see PR #477 for the measured before/after).
// Budgets raised for the config-surface shorthands (24.90→25.10 / 20.10→20.25 KB; measured 24.99 /
// 20.14). CONTRACT.md P7/P12/P13/P15 buy authoring ergonomics with hot-path bytes: `circuit:[f,c]`,
// the single-fragment `extends`, the `cache.methods`/`vary` list widening and the `inspect(i,true)`
// probe boolean all normalise in `compose`/`makeStitch`, which every stitch runs — there is no
// subpath to move them behind, and the alternative is not "smaller" but "the shorthand does not
// exist". Measured against a `main` that had grown to 24.81 / 20.01 underneath this branch: the
// slice is +0.15 / +0.11, of which the `cache` list widening is +0.03 / +0.02 (it was declared in
// the types but never performed — `methods: 'POST'` threw). Headroom lands at 0.11 / 0.11, the same
// tight step #477 took, not a restoration of the ~0.2 KB the gate usually holds (see PR #524 for
// the measured before/after at each ref).
// Whole entry 25.10→25.15 KB for the atomic `auth` extends slot. The overflow is literally ONE byte
// (25703 vs a 25702 B ceiling): #485's apiKey cookie arm landed at 25.08 KB, leaving 0.02 KB, and
// this fix spends it. It cannot move behind a subpath — it is a merge rule in `compose`, which every
// stitch runs — and it is not optional: without it `deepMerge` splices a child strategy's `apply`
// onto an inherited strategy's `refresh`/`scheme`, so a child `bearer` answered a 401 by running an
// inherited oauth2's token request. This is a MINIMUM step (0.05 KB / ~49 B headroom), deliberately
// NOT the ~0.2 KB the gate usually restores: ADR 0021 moves the whole auth surface behind
// `stitchapi/auth`, which drops this entry to ~22.7 KB and takes the budget down with it. Until that
// lands the entry is full, and this tight ceiling is the intended signal.
// Whole entry 25.15→22.90 KB — a DROP, not a raise. ADR 0021 moved the auth surface (the five
// strategy factories + the four secret resolvers) off the root barrel onto `stitchapi/auth`, so
// `export *` no longer reaches oauth2's token cache or cookieSession's login state machine:
// measured 22.69 KB, down 2.41 from 25.10. `import { stitch }` is unchanged at 20.17 (the barrel
// was already tree-shaken there — the split makes that a module-graph fact rather than a
// tree-shaking outcome, and buys back the headroom the two PRs above spent). The advertised figure
// moves ~25 → ~23 kB. The new third scenario budgets the subpath itself: pay for the whole auth
// surface only if you `export *` from it; a real call site imports one strategy (`bearer` + `env`
// is 0.39 KB gzip, `oauth2` + `env` 3.22 KB).
// `import { stitch }` 20.25→20.30 KB for the shared urlencoded walker. Measured 20.27 against a
// `main` at 20.23 — the slice is +0.04, and `main` had only 0.02 KB of headroom left, so this
// overflows by 0.02. The bytes are ADR 0005 Decision 6 finally applied to the `form` arm: the query
// string and a `wire.body: 'form'` body now share ONE flattener (`flattenParams`), where the form
// arm previously did its own top-level `String(v)` pass and turned a nested object into
// `[object Object]` on the wire. It cannot move behind a subpath — `buildQuery` runs on every
// request the engine assembles, and the nested `wire.multipart` fold runs in `compose`, which every
// stitch runs. The alternative is not "smaller" but "a form body silently corrupts nested data".
// `buildQuery` was rewritten to concatenate instead of map+join to pay part of it back (−0.02 KB
// minified, 0.00 gzip). Whole entry is unchanged at 22.86 (0.04 left) and needs no bump. This is a
// MINIMUM step (0.03 KB headroom), matching #477/#524's tight ceilings rather than restoring the
// ~0.2 KB this gate usually holds.
// Budgets raised for ADR 0022 — response classification becomes one decision (22.90→23.30 /
// 20.30→20.70 KB; measured 23.14 / 20.55 against a `main` at 22.85 / 20.27, so the whole ADR is
// +0.29 / +0.28). The engine used to decide what a response WAS in two places at two times: a status
// check inside the attempt loop that could retry or throw but never saw the body, and a surface's
// `interpret` that saw the body but ran after the loop had finished. Neither could see what the
// other saw, and `httpSurface` — the surface almost every stitch uses — had no interpretation of its
// own at all, which is why its policy had nowhere to live and became a flat root `acceptStatus`.
//
// What the bytes buy, all of it on the core path and none of it movable behind a subpath (the
// attempt loop runs on every request):
//   • `httpFailure` / `httpInterpret` / `interpretOf` — the verdict as named, composable functions
//     instead of two unnamed engine branches, with an omitted `kind` resolving to `httpSurface` so
//     the engine holds no default of its own;
//   • `interpret` moved INSIDE the attempt loop, plus the routing that keeps `circuit` tracking
//     transport health rather than the surface's verdict;
//   • the `SurfaceOutcome` retry arm (#529) — a surface that read the body can ask for another
//     attempt, sharing the `retry.attempts` budget;
//   • `verdict.flag` — its three-state read and the `info` drift finding an inert flag emits.
//
// The split between `httpFailure` (the verdict) and `httpInterpret` (that, then the http surface's
// own "body is the value") is load-bearing, not cosmetic: a shared function that also asserted
// `data: res.body` would impose a response format on `download` (`{ blob, filename }`) and `llm`
// (the provider's parsed completion), forcing every composing surface to build a success value and
// immediately discard it. Headroom lands at 0.16 / 0.15 — the tight step #477/#524 took, not the
// ~0.2 KB this gate usually restores.
//
// Budgets raised for the store-backed throttle's cold-start burst fix — ADR 0023 Decision 2
// (23.30→23.50 / 20.70→20.90 KB; measured 23.31 / 20.72 against a `main` at 23.28 / 20.69, so the
// fix itself is +0.03 / +0.03). The distributed limiter granted every already-elapsed slot the
// moment it was claimed, so a process joining mid-window drained the window's unclaimed slots in
// one tick — a burst that scaled with the window length rather than the declared rate ('120/m'
// granted five concurrent calls at one instant where '2/s', the same 500ms spacing, granted two).
// The bytes are one `Math.max` over a per-key `nextGrantAt` cursor and its assignment, making each
// grant `max(now, cursor, slot)`.
//
// It cannot move behind a subpath: `createStoreThrottle` is reached from `stitch()` whenever a
// `store` is configured, so it is on the core path by construction — the same reason the rc.1
// raise above cites for the throttle's idle-state reclamation.
//
// Headroom lands at 0.19 / 0.18 — the ~0.2 KB this gate usually restores, not the tight step
// #477/#524 took. `main` had run down to 0.02 / 0.007, which is why a +0.03 KB fix tripped the gate
// at all; the step is sized to the headroom the gate is meant to hold rather than to this change,
// so the next small core-path fix is not gated on a budget PR of its own.
// Budgets raised for ADR 0024 — the fleet-wide GCRA cell (23.50→23.70 / 20.90→21.10 KB; measured
// 23.52 / 20.95, so the capability is +0.24 / +0.26 against a `main` at 23.28 / 20.69). ADR 0023
// closed the cold-start burst with a PER-PROCESS pacing cursor and recorded what that could not
// buy: a stale slot paces nobody, so N workers sharing a store still emit at N× the declared rate
// until the slots catch up. This is the primitive that closes it — `StitchStore.reserve`, one
// atomic read-compute-write over a shared cursor, implemented by `memoryStore`, `@stitchapi/redis`
// (Lua) and `@stitchapi/deno-kv` (compare-and-set).
//
// What the bytes buy, on the core path because `memoryStore` is the DEFAULT store:
//   • `memoryStore.reserve` — the reference cell, and the one every in-process test paces on;
//   • the second pacing path in `createStoreThrottle`, selected when the backend has the verb;
//   • `vaultView` forwarding it only when the backend really has it, so a seam's namespaced view
//     reports the backend's true capability instead of making every store look GCRA-capable.
//
// It cannot move behind a subpath: this is the throttle, which `stitch()` reaches whenever a
// `store` is configured, and the fallback has to stay reachable from the same call site for a
// backend that cannot offer a cell (Cloudflare KV is eventually consistent — no atomic
// read-compute-write to build one from). Nor can the two pacing paths share their wait/sleep
// tail: factoring it into one async helper MEASURED WORSE (+0.06 KB, the closure and its extra
// promise costing more than the duplicated four lines), so the repetition stays on purpose.
//
// The conventional 0.2 KB step rather than a minimum one — this is a new capability with a new
// store verb behind it, not a fix squeezing past a ceiling, and #620 had just restored the same
// step. Headroom lands at 0.17 / 0.15.
//
// The ADVERTISED figure moves with it: the whole entry crosses a rounding boundary at 23.53 KB, so
// every site quoting it goes ~23 → ~24 kB (`import { stitch }` stays ~21). Eight sites, propagated
// under the `bundle-advertised-size` drift tether — both READMEs, the installation and principles
// pages, the home-page metrics component, and the docs' own source blurb. Recorded here because
// this is the number the project advertises, and a budget raise that quietly left the docs
// claiming the old one would be the exact drift that tether exists to catch.
// Budgets raised for ADR 0025 — fleet-wide `concurrency` by lease (23.70→24.10 / 21.10→21.50 KB;
// measured 23.91 / 21.32, so the capability is +0.38 / +0.37 against a `main` at 23.53 / 20.95).
// ADR 0024 made the RATE fleet-wide and left the concurrency cap per-process, so `concurrency: 10`
// across eight workers was a fleet cap of eighty. Closing it needs leases rather than a counter: a
// slot is held for an unknown interval by a specific holder, and a holder that crashes never
// decrements, so a shared counter decays toward zero instead of failing safe.
//
// What the bytes buy, all on the core path because `memoryStore` is the DEFAULT store:
//   • `memoryStore.lease` / `release` — the reference semaphore, and what every in-process test
//     runs against;
//   • the lease-acquire loop in `createStoreThrottle` (poll with full jitter — there is no
//     cross-process handoff to park on) plus per-key token tracking so `release` frees a slot the
//     caller actually holds;
//   • `vaultView` forwarding the pair only when the backend has both.
//
// Trimming came first and got some of it back: holding the semaphore in its own `Map<string,
// Map<string, number>>` rather than serialising a token→expiry record through the shared `data`
// keyspace removed a helper and two `Object.fromEntries` round-trips, worth 0.07 KB measured
// (0.29 → 0.22 over). It cannot move behind a subpath — this is the throttle, reached from
// `stitch()` whenever a `store` is configured, and the per-process fallback has to stay reachable
// from the same call site for a backend that cannot lease atomically.
//
// The conventional ~0.2 KB step, sized so headroom lands at 0.19 / 0.18. The advertised rounded kB
// are UNCHANGED at 24 / 21 this time — 23.91 still rounds to 24 — so no README or docs figure
// moves; verified against the `bundle-advertised-size` tether rather than assumed, which is the
// mistake the ADR 0024 raise made.
//
// `import { stitch }` raised for the coalescer's unhandled-rejection guard — #670 (21.50→21.55 KB;
// measured 21.51 = 22026 B against a `main` at 22015 B, so the fix is +11 B). A cached stitch whose
// vendor fails, with no concurrent follower, rejected the coalescer's shared promise with nobody
// attached to it: a handled failure (`.safe()` returning `ok: false`) killed the process under
// Node's default `--unhandled-rejections=throw`. The bytes are one terminal `.catch`, attached
// where that promise is created.
//
// It cannot move behind a subpath: the coalescer is reached from `stitch()` whenever `cache` is
// configured, and it is the fix for a crash, not a capability that could be opted into. There is no
// cheaper spelling — resolving a sentinel instead of rejecting would be smaller and would remove
// the hazard outright, but it would throw away the rejection channel #653 wants to hand to
// followers. Dropping the leader claim's unread `promise` field was measured too: 3 B, which pays
// for none of this and is a public type change on `stitchapi/cache`, so it is not taken here.
//
// A MINIMUM step, not the ~0.2 KB this gate usually restores — matching #477/#524/#485: this is a
// fix squeezing past a full ceiling, not a new capability, and `main` had run down to 1 byte.
// Headroom lands at 41 B here and 14 B on the whole entry (unchanged at 24.10), so the next
// core-path byte trips this gate again; sizing that step is the maintainer's call, not a bug fix's.
//
// The ADVERTISED figure moves, and NOT because of this change: 21.5 KB is both the budget and a
// rounding boundary (22016 B), and `main` measured 22015 B — one byte below both. Any core-path
// byte at all takes `import { stitch }` from ~21 → ~22 kB. Nine figures across the six sites under
// the `bundle-advertised-size` tether — both READMEs, the installation and principles pages, the
// home-page metrics component, and the docs' source blurb — propagated by hand and verified with
// the tether. (The core README's "~21 kB brotli" moves with them and is more accurate for it: the
// whole entry's brotli is 21.6 KB, which rounds to 22, not 21.)
// `advertised: true` means the READMEs/docs quote this scenario's rounded gzip kB — see the
// `--json` note below for why that flag, not the row's presence, drives the drift tether.
const SCENARIOS = [
    {
        name: 'stitchapi — whole entry',
        code: `export * from './index.mjs';`,
        budget: 24.1 * KB,
        advertised: true,
    },
    {
        name: 'import { stitch }',
        code: `export { stitch } from './index.mjs';`,
        budget: 21.55 * KB,
        advertised: true,
    },
    {
        name: 'stitchapi/auth — whole surface',
        code: `export * from './auth.mjs';`,
        budget: 5.35 * KB,
    },
];

function measure(code) {
    const result = esbuild.buildSync({
        stdin: {
            contents: code,
            resolveDir: libDir,
            sourcefile: 'entry.mjs',
            loader: 'js',
        },
        bundle: true,
        minify: true,
        format: 'esm',
        treeShaking: true,
        platform: 'neutral',
        // Node builtins, in BOTH spellings — the package has zero deps, so builtins are
        // the only thing that is ever external and the root entry stays browser-safe.
        //
        // The bare forms are not belt-and-braces: they are the ones that actually match.
        // The source writes the prefix (`src/registry.ts` imports `node:fs`/`node:path`/
        // `node:url`) but tsup STRIPS it, so `lib/` emits `from"fs"`, `require("path")`.
        // Across the shipped files the only surviving `node:` string is inside
        // `process?.getBuiltinModule?.("node:fs")` — a runtime lookup no bundler resolves.
        // `node:*` alone therefore matched NOTHING here: measuring a builtin-using entry
        // (`stitchapi/registry`) failed outright with `Could not resolve "fs"`, and a bare
        // `fs` left non-external can be shadowed by a stray `node_modules/fs` and silently
        // inlined into the measurement. The prefixed forms are kept so this keeps working
        // if the build is ever changed to preserve `node:` (the better fix for shadowing).
        //
        // A builtin the list misses fails loudly rather than measuring something wrong —
        // extend it when the artifacts start reaching for a new one.
        external: ['node:*', 'fs', 'fs/promises', 'path', 'url', 'http'],
        write: false,
        logLevel: 'silent',
    });
    const out = result.outputFiles[0].contents;
    return {
        min: out.length,
        gzip: gzipSync(out, { level: 9 }).length,
        brotli: brotliCompressSync(out).length,
    };
}

const kb = (bytes) => `${(bytes / KB).toFixed(2)} KB`;

if (!existsSync(resolve(libDir, 'index.mjs'))) {
    console.error(
        '✗ lib/index.mjs not found — run `pnpm build` first (or use `pnpm size`).',
    );
    process.exit(1);
}

const rows = SCENARIOS.map((s) => {
    const m = measure(s.code);
    return { ...s, ...m, over: m.gzip > s.budget };
});

const failed = rows.some((r) => r.over);

if (process.argv.includes('--json')) {
    console.log(
        JSON.stringify(
            // `kb` is the *advertised* figure: the rounded gzip kB the READMEs/docs
            // quote (`~NN kB`). Emitting it here lets the yakir `bundle-advertised-size`
            // tether read the measured set straight from this output (it greps `"kb"`),
            // instead of re-deriving the rounding. See yakir.json.
            //
            // ONLY the scenarios the docs actually quote carry `kb` — the tether greps every `"kb"`
            // in this output and compares the set against the doc sites, so emitting one for a
            // scenario no README mentions (the `stitchapi/auth` subpath) would inject a number the
            // doc sites can never match and fail the tether. Budget it here, advertise it nowhere.
            rows.map(
                ({ name, min, gzip, brotli, budget, over, advertised }) => ({
                    name,
                    min,
                    gzip,
                    brotli,
                    ...(advertised ? { kb: Math.round(gzip / KB) } : {}),
                    budget,
                    over,
                }),
            ),
            null,
            2,
        ),
    );
} else {
    const col = (s, w) => String(s).padStart(w);
    console.log('\n  Core bundle budget — tree-shaken, min+gzip\n');
    console.log(
        '  ' +
            'scenario'.padEnd(32) +
            col('minified', 11) +
            col('gzip', 11) +
            col('brotli', 11) +
            col('budget', 11) +
            '   status',
    );
    console.log('  ' + '─'.repeat(89));
    for (const r of rows) {
        const headroom = r.over
            ? `OVER by ${kb(r.gzip - r.budget)}`
            : `${kb(r.budget - r.gzip)} left`;
        console.log(
            '  ' +
                r.name.padEnd(32) +
                col(kb(r.min), 11) +
                col(kb(r.gzip), 11) +
                col(kb(r.brotli), 11) +
                col(kb(r.budget), 11) +
                `   ${r.over ? '✗' : '✓'} ${headroom}`,
        );
    }
    console.log('');
}

if (failed) {
    console.error(
        '✗ Bundle budget exceeded.\n' +
            '  Trim the entry, or move the new capability behind its own subpath import\n' +
            '  (like cache / graphql / sse). If the growth is genuinely necessary, raise\n' +
            '  the budget in packages/core/scripts/bundle-size.mjs and say why in the PR —\n' +
            '  the budget is the gate, so bumping it must be deliberate.\n',
    );
    process.exit(1);
}

// Keep --json output pure (it is consumed by yakir's `bundle-advertised-size`
// tether); the human-readable confirmation is only for the table view.
if (!process.argv.includes('--json')) {
    console.log('✓ Core entry within budget.\n');
}
