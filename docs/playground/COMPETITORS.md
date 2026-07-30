# Live-Code Playground — Competitor & Options Overview

> **Snapshot date:** 2026-06-11. Maintenance/health facts are time-sensitive — **re-verify npm dist-tags and last-commit dates before committing** to any option.
> Basis: two adversarially-verified deep-research runs (≈200 agents, ~40 sources, claims killed on a 2/3 refute vote). Decision drawn from this: [RATIONALE.md](./RATIONALE.md).

## What we need (the filter)

The playground must run `stitch()` snippets in the docs. Hard constraints:

1. **In-page or same-origin iframe execution** — so snippet `fetch` stays same-origin against an allowlisted proxy (no CORS). _Disqualifies foreign-origin bundler iframes._
2. **Async-first** — `stitch()` is a promise; needs top-level `await` + resolved-value output.
3. **TS + JSX** transpiled in-browser.
4. **Lightweight** — `stitch` is a fetch wrapper; full Node emulation is overkill.
5. **MDX-embeddable** React component (Fumadocs).
6. Decent **editor** + **theming**, OSS license, self-hostable.

## Scorecard

| Option                                    | Maintained (2026)                                        | In-page / same-origin                                                 | Async output                              | TS / JSX     | Weight             | License    | Verdict                                                                      |
| ----------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------- | ------------ | ------------------ | ---------- | ---------------------------------------------------------------------------- |
| **react-live**                            | ❌ stalled — last release Nov 2024, last commit Jan 2025 | ✅ in-page                                                            | ⚠️ historically weak                      | ✅           | light              | MIT        | **Reject** — unmaintained + async-weak                                       |
| **react-runner** / react-live-runner      | ⚠️ niche, lower traction                                 | ✅ in-page                                                            | ⚠️ async = build-your-own runner          | ✅ (Sucrase) | light              | MIT        | Useful as a **building block / reference**, not turnkey                      |
| **Sandpack**                              | ✅ active                                                | ❌ **foreign-origin iframe** by default (`*-sandpack.codesandbox.io`) | ✅                                        | ✅           | heavy              | Apache-2.0 | **Reject** — reintroduces CORS; self-hosting bundler is extra work; overkill |
| **LiveCodes**                             | ✅ active — v49, May 2026                                | ⚠️ same-origin iframe **only if self-hosted on docs origin**          | ⚠️ via console panel                      | ✅           | <5kB SDK + payload | MIT        | **Viable fallback / stopgap**                                                |
| **Runno**                                 | ✅ active                                                | ❌ WASM sandbox                                                       | ❌ **no network**, QuickJS≠Node, no fetch | ❌ no TS/JSX | —                  | MIT        | **Disqualified** on 3 counts                                                 |
| **In-house** (CM6 + Sucrase + async eval) | we own it                                                | ✅ **native in-page**                                                 | ✅ **native top-level await**             | ✅           | tiny core          | ours       | **Chosen** — see RATIONALE.md                                                |

## Detail & evidence

### react-live (FormidableLabs/react-live) — REJECT

- **Stalled, not formally dead.** Last release `4.1.8` on **2024-11-19**; last `master` commit **2025-01-09** — ~17–18 months silent by the snapshot date. **Not** npm-deprecated or GitHub-archived; the README still self-describes as "Active" (a **stale badge**, contradicted by the timestamps).
- Still **~1.6M downloads/month**, 400+ dependents → abandoned by maintainers, not by consumers.
- Corporate context: **Formidable Labs → Nearform** acquisition announced **2023-10-10**. No formal OSS wind-down notice, and **no official successor/migration path** in the repo.
- **Correction:** `@uiw/react-live` (floated as a possible maintained fork) **does not exist** — npm returns 404. Do not plan around it.
- Why it still wouldn't fit even if maintained: **weak async** support, exactly what `stitch()` needs.
- Sources: [npm](https://www.npmjs.com/package/react-live) · [commits](https://github.com/FormidableLabs/react-live/commits/master) · [Nearform](https://nearform.com/digital-community/formidable-joins-forces-with-nearform/)

### react-runner (nihgwu/react-runner) — BUILDING BLOCK

- Markets itself as a more powerful react-live alternative; transpiles TS/JSX in-browser via **Sucrase**.
- **Async is not turnkey** — you "build your own async runner" for promises/dynamic imports. So it's closer to a reference implementation of the in-house approach than a drop-in.
- ⚠️ **Refuted claims** (do not cite): that `react-live-runner` is an "official drop-in migration shim" with identical API (vote 1-2); and the specific framing that Sucrase "enables modern JS in-page and avoids react-live's syntax restrictions" (1-2). Its async-runner capability + built-in TS/Sucrase **did** verify (3-0).
- Source: [github.com/nihgwu/react-runner](https://github.com/nihgwu/react-runner)

### Sandpack (CodeSandbox) — REJECT

- Executes inside an iframe that **defaults to a foreign CodeSandbox origin** (`${version}-sandpack.codesandbox.io`) — by design, to protect host cookies. That **reintroduces the exact CORS problem** we're avoiding.
- Mitigable by **self-hosting the bundler** (`bundlerURL` + the "Hosting the Bundler" guide), but a maintainer discussion notes even self-hosted it runs from an external domain in the documented setup → true same-origin needs extra work.
- Heavyweight for a fetch-wrapper demo.
- Sources: [client docs](https://sandpack.codesandbox.io/docs/advanced-usage/client) · [hosting the bundler](https://sandpack.codesandbox.io/docs/guides/hosting-the-bundler)

### LiveCodes — VIABLE FALLBACK / STOPGAP

- **Actively maintained** — release **v49 on 2026-05-08**, 75 releases, MIT, fully client-side, self-hostable on any static server.
- Ships a **<5kB zero-dep SDK with an official React wrapper** (`livecodes/react`) → embeddable in Fumadocs MDX. In-browser TS + JSX (Babel presets), 90+ languages.
- **Critical caveat:** runs visitor code in a **same-origin iframe** (its result sandbox) **only when self-hosted on the docs origin**. "Client-side" alone does not guarantee the same-origin-proxy boundary — it's a config requirement. This _satisfies_ our "same-origin iframe" constraint when self-hosted.
- Weaknesses vs our need: a general 90+-language playground (heavier conceptual surface than a fetch wrapper needs); async `stitch()` output is rendered via its **generic console panel** — we don't control it to render response cards / build-stitch DAGs.
- **When we'd pick it:** if we want something live _this week_ and accept generic output. See RATIONALE.md §"Escape hatch".
- Sources: [github.com/live-codes/livecodes](https://github.com/live-codes/livecodes) · [self-hosting](https://livecodes.io/docs/features/self-hosting) · [SDK](https://livecodes.io/docs/sdk/)

### Runno — DISQUALIFIED

- WASI/WASM sandbox with **no network access**, a virtual in-memory FS, JS via **QuickJS-compiled-to-WASM** (not Node, no `fetch`, no DOM), and **no TS/JSX**. Best for STDIN/STDOUT examples. Fails constraints 1, 2, and 3 independently.
- Sources: [github.com/taybenlor/runno](https://github.com/taybenlor/runno) · [runno.dev/docs/wasi](https://runno.dev/docs/wasi/)

## In-house building blocks (the chosen path)

| Layer      | Choice                                                           | Alternatives                                                                                            | Note                                     |
| ---------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Editor     | **CodeMirror 6**                                                 | Monaco (heavy, full IntelliSense); react-simple-code-editor + Prism (ultra-light, what react-live used) | CM6 is the weight/feature sweet spot     |
| Transpiler | **Sucrase**                                                      | `@babel/standalone` (official browser build, bundles ts+react presets); esbuild-wasm (overkill)         | Erasure only; no type-check              |
| Execution  | **in-page async `Function`** + injected scope + captured console | same-origin sandboxed iframe (stronger isolation)                                                       | natively gives in-page + top-level await |

> ⚠️ **Not independently benchmarked:** editor bundle sizes, the eval security model, and LOC/effort were _not_ in the verified claim set — validate in the spike. The hard-constraint **eliminations above (Sandpack foreign-origin, Runno disqualified, react-live stalled) are verified.**

## Sources (primary)

- react-live: npmjs.com/package/react-live · github.com/FormidableLabs/react-live (releases, commits)
- Nearform acquisition: nearform.com/digital-community/formidable-joins-forces-with-nearform/
- react-runner: github.com/nihgwu/react-runner
- Sandpack: sandpack.codesandbox.io/docs (advanced-usage/client, guides/hosting-the-bundler)
- LiveCodes: github.com/live-codes/livecodes · livecodes.io/docs (self-hosting, sdk)
- Runno: github.com/taybenlor/runno · runno.dev/docs/wasi
- Transpilers: babeljs.io/docs/babel-standalone · github.com/alangpierce/sucrase
