# ADR 0001 — Package naming & distribution model

- **Status:** Accepted
- **Date:** 2026-06-12
- **Tags:** packaging, npm, public-api, plugins

## Context

StitchAPI ships from a pnpm monorepo (`packages/*`, `apps/*`). The core library is
published to npm as **`stitchapi`** (unscoped), currently v0.7.0, exposing a `stitch`
bin. The repo also contains private, unpublished workspace packages under the
`@stitchapi/*` scope (`@stitchapi/workspace`, `@stitchapi/docs`).

We plan to grow an ecosystem around core: request/response **transformers**,
framework **adapters** (e.g. React), observability sinks, and other **plugins** —
first-party now, potentially third-party later. Several of these will carry their
own (sometimes heavy or optional) dependencies, and adapters need framework peer
dependencies.

A naming drift had crept into the docs: authored examples and the Twoslash sandbox
imported from `@stitchapi/core` — a name that is **not published** and does not match
the workspace package (`stitchapi`). `apps/docs` already depends on `stitchapi`
(`workspace:*`) and `apps/docs/AUTHORING.md` already mandates importing the published
entry point `stitchapi`, so the drift contradicted the project's own standard. This
forced the question: what is our canonical naming and distribution convention as we
add plugins?

## Decision

1. **Core stays `stitchapi`** (unscoped). We do **not** rename it to `@stitchapi/core`.
   The thing users reach for most keeps the cleanest name, and it reads with the
   `stitch` verb / `stitch` bin.

2. **First-party plugins, adapters, and transformers are published as separate
   scoped packages: `@stitchapi/<name>`** — e.g. `@stitchapi/react`,
   `@stitchapi/transform-xml`, `@stitchapi/otlp`. Each is independently versioned and
   pulls its own dependencies, keeping core lean.

3. **Community / third-party plugins use the unscoped `stitchapi-plugin-<name>`
   convention** (the `eslint-plugin-*` / `vite-plugin-*` pattern). The `@stitchapi/*`
   scope is reserved for first-party packages only.

4. **Plugins declare `stitchapi` as a `peerDependency`** (not a regular dependency),
   so every plugin binds to the single core instance the application installs. This is
   mandatory for a plugin host: it prevents two physical copies of core from loading
   and splitting the plugin registry / breaking `instanceof`.

5. **No `@stitchapi/core` alias.** We do not publish `@stitchapi/core` as a re-export
   or duplicate of `stitchapi`. The `@stitchapi` scope is owned, so the name cannot be
   squatted; an `npm i @stitchapi/core` simply 404s, which is an adequate "wrong name"
   signal. (If users are observed tripping over it, we may publish `@stitchapi/core`
   **once** as a deprecated, no-op signpost whose deprecation message points to
   `stitchapi` — never a working re-export.)

6. **Subpath exports are for in-package code splitting, not for plugins.** Use them
   for dependency-free helpers within a package (e.g. `stitchapi/testing`) and for
   grouping lightweight, dependency-free built-in transformers inside a single package
   (e.g. `@stitchapi/transformers/json`). Any transformer/plugin that carries its own
   dependency gets its own `@stitchapi/<name>` package instead.

7. **Directory name ≠ package name.** `packages/core/` publishes `stitchapi`; this is
   intentional and fine.

## Consequences

**Positive**

- Cleanest install/import for the 90% path: `npm i stitchapi`,
  `import { stitch } from 'stitchapi'`.
- Lean core: a plugin's (often heavy/optional) dependencies are installed only when
  that plugin is.
- One core identity: the `peerDependency` rule keeps a single physical core module,
  avoiding dual-instance bugs in an extensible / registry-based library.
- Owned namespace: `@stitchapi/*` can only be published by us → supply-chain trust (a
  scoped plugin is provably first-party) and a browsable family on npm.
- No breaking change to the already-published `stitchapi` package.

**Accepted trade-offs**

- The surface is intentionally "mixed": unscoped core (`stitchapi`) alongside scoped
  plugins (`@stitchapi/react`). This is cosmetic and follows established precedent
  (`vite` + `@vitejs/plugin-*`, `rollup` + `@rollup/plugin-*`, `astro` + `@astrojs/*`,
  `svelte` + `@sveltejs/*`). The asymmetry encodes meaning: bare = the library,
  scoped = its official add-ons.

**Required follow-ups**

- Docs and the Twoslash sandbox import `stitchapi` (Twoslash type-checks every
  ` ```ts twoslash ` block against the real workspace `stitchapi`). The pre-existing
  `@stitchapi/core` drift was swept to `stitchapi`: content pages in PR #39, and the
  sandbox runtime + contracts alongside this ADR.
- Before publishing the first `@stitchapi/*` plugin, **register / confirm ownership of
  the npm org (scope) `stitchapi`** — the unscoped `stitchapi` package alone does not
  reserve the scope.

## Alternatives considered

- **A. Scope everything: `@stitchapi/core` + `@stitchapi/react` (Babel model).** Fully
  symmetric, but a breaking rename of a published package, worse ergonomics on the
  primary path, and it loses the "bare name = the main thing" signal. Babel is the lone
  major ecosystem that scopes core, and it is widely regarded as friction. Rejected.
- **B. Subpath monolith: `stitchapi/react` + `stitchapi/transform-xml`.** One install,
  but every consumer downloads every plugin's dependencies (transformers often wrap
  parser libs), per-subpath peer deps aren't expressible, and third parties can't
  extend it. Rejected for plugins; retained for in-package dependency-free helpers
  (decision 6).
- **C. All-unscoped: `stitchapi` + `stitchapi-react`.** Internally consistent and keeps
  core ergonomics, but gives up the owned namespace (typosquat / malware risk, no scope
  page). Rejected for first-party; adopted as the **community** convention
  (`stitchapi-plugin-*`, decision 3).
- **D. `@stitchapi/core` as an alias alongside `stitchapi`.** Reintroduces the naming
  ambiguity we are resolving, imposes a permanent dual-publish / version-skew tax, and
  — for a plugin host — invites dual-instance / identity bugs when app and plugins
  resolve different specifiers. Rejected.
