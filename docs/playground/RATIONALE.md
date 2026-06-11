# Decision Record — Build the Playground Execution Engine In-House

> **Status:** Accepted (engine implementation **deferred**)
> **Date:** 2026-06-11 · **Decider:** @rejifald
> **Related:** [REQUIREMENTS.md](./REQUIREMENTS.md) (the shape) · [COMPETITORS.md](./COMPETITORS.md) (options rejected) · [`component/runner.ts`](./component/runner.ts) (the contract)

## Context

The StitchAPI docs site (Fumadocs / React / Next.js, OSS self-hosted) needs **live
playground widgets**: a reader edits a `stitch()` snippet and runs it against a real
API, inline. We evaluated the maintained off-the-shelf options and the in-house path
across two adversarially-verified research runs.

Three facts shaped the decision:

1. **The execution surface is tiny.** `stitch`'s core is `fetch`-based
   ([`src/adapters/fetch.ts`](../../src/adapters/fetch.ts) wraps global `fetch`), so a
   snippet is essentially `await stitch(url, opts)` — not a multi-file app. The usual
   "don't roll your own" caution is weak when the thing you'd build is this small.
2. **Same-origin execution is a hard constraint.** To demo authenticated calls we
   route through a same-origin allowlisted proxy that injects secrets server-side.
   That only works if snippet code runs **in-page or in a same-origin iframe** — which
   eliminates foreign-origin bundler iframes (Sandpack-by-default).
3. **No off-the-shelf tool ships a live REPL** for this; every option is a bolt-on, and
   the best-maintained in-page library (react-live) is **stalled and async-weak**.

## Decision

-   **Docs framework:** Fumadocs (decided earlier — React/Next-native, component-first, MIT, actively maintained).
-   **Execution engine:** **build in-house** — CodeMirror 6 editor + Sucrase transpiler +
    in-page async `Function` execution with an injected `stitch` scope and a bespoke
    output panel. Conform to the `CodeRunner` contract so it's swappable.
-   **Implementation is deferred.** This change defines the engine's _shape and
    requirements_ and stubs it (`DeferredRunner` / `mockRunner`) so the UI and docs
    proceed without it.

## Rationale — why in-house over LiveCodes (the only viable off-the-shelf option)

1. **Only path that natively satisfies all three hard constraints** — in-page
   same-origin execution, top-level `await`, and an injectable scope. These are exactly
   what react-live fought us on and what a general playground doesn't give cleanly.
2. **We own the output surface — the actual point.** A generic playground gives you a
   console pane. In-house, the output panel renders the **response card, retry / throttle /
   drift annotations, and a Mermaid build-stitch DAG** from the structured trace. That
   turns the playground into a _product demo_, directly serving the "Mermaid-from-
   definition" roadmap and the "capability, not credential" pitch.
3. **Buy-vs-build math favors build here.** The execution core (transpile + async eval +
   console capture) is small and its dependencies (Sucrase, CM6) are stable. The
   maintenance burden is low precisely because the surface is narrow.
4. **No coupling** to an unmaintained project (react-live) or a heavyweight 90-language
   general playground (LiveCodes) whose model we'd be fighting to get bespoke output.

## Alternatives considered

See [COMPETITORS.md](./COMPETITORS.md) for the full scorecard. In short:

-   **react-live** — rejected: stalled (~18 months no release), async-weak. `@uiw/react-live` doesn't exist.
-   **Sandpack** — rejected: foreign-origin iframe by default reintroduces CORS; heavyweight.
-   **Runno** — disqualified: no network, QuickJS≠Node, no TS/JSX.
-   **react-runner** — kept as a **reference** for the in-house Sucrase + async-runner approach, not adopted wholesale.
-   **LiveCodes** — the credible off-the-shelf option and our explicit fallback (below).

## Consequences

We now own, as part of the deferred work:

-   the **eval security model** (isolation; the proxy allowlist is the real trust boundary);
-   **console capture** and **async/promise output rendering**;
-   a **browser build of `stitch`** that shims its Node-only surfaces (`keychain`, `env`,
    `cookieSession`, JSONL trace) — see REQUIREMENTS.md §6, the **largest unknown**;
-   the **same-origin allowlisted proxy** (Next Route Handler or Cloudflare Worker).

## Confidence & escape hatch

-   The **constraint-based eliminations are verified** (Sandpack foreign-origin, Runno
    disqualified, react-live stalled). The in-house-vs-LiveCodes call and the reference
    stack are **engineering judgment**, not independently benchmarked — validate in a spike.
-   **Escape hatch:** if the in-house engine proves more costly than expected (esp. the
    browser `stitch` build), fall back to **self-hosted LiveCodes** on the docs origin.
    Because the UI is built against `CodeRunner`, that swap is a single implementation,
    not a rewrite.

## Revisit this decision if…

-   react-live ships a release / a maintained successor with first-class async appears;
-   the browser `stitch` shim (REQUIREMENTS.md §6) turns out to be disproportionately hard;
-   a same-origin, async-first, in-page OSS runner emerges that renders custom output.
