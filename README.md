<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/baner_dark.png" />
    <img alt="StitchAPI — turn any API into a typed, resilient function" src="docs/media/baner_light.png" width="100%" />
  </picture>
</p>

<p align="center">
  <strong>API stitching:</strong> turn any API into a typed, resilient <strong>function</strong>. Declare an endpoint once — its types, auth, and resilience — and call it like a local function. No server, no codegen, no config files. The same definition answers to your code, the CLI, and an AI agent alike.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/stitchapi?activeTab=dependencies"><img alt="Dependencies: 0" src="https://img.shields.io/badge/dependencies-0-brightgreen" /></a>
  <img alt="npm bundle size (minified + gzipped)" src="https://img.shields.io/bundlephobia/minzip/stitchapi" />
  <img alt="Bundle: ~22 kB min+gzip" src="https://img.shields.io/badge/min%2Bgzip-~22%20kB-2563EB" />
</p>

<p align="center">
  <strong>Zero runtime dependencies · ~22&nbsp;kB min+gzip</strong> — a typical <code>import { stitch }</code> tree-shakes to ~18&nbsp;kB, and with no transitive tree there is nothing else to install or audit. The size is an <a href="packages/core/scripts/bundle-size.mjs">enforced budget in CI</a>, not an aspiration.
</p>

> [!NOTE]
>
> **StitchAPI is at `1.0.0-rc.1`.** The core runtime is feature-complete, zero-dependency, covered by a green test gate, and already running in production in two projects. We're validating in the wild before stamping a stable `1.0.0` — pin an exact version and expect only small, documented changes. Feedback is very welcome.

---

# StitchAPI — monorepo

This repository is a [pnpm](https://pnpm.io) workspace.

| Package                      | Path            | Description                                                       |
| ---------------------------- | --------------- | ----------------------------------------------------------------- |
| [`stitchapi`](packages/core) | `packages/core` | The published library — the `stitch` runtime, CLI, auth, tracing. |

Design notes, overview, and feature lenses live in [`docs/`](docs).

## Develop

```sh
corepack enable          # use the pinned pnpm
pnpm install             # install the whole workspace
pnpm build               # build every package (currently: core)
pnpm test                # run the test suites
pnpm check:format        # prettier across the repo
```

Scope work to one package with a filter, e.g. `pnpm --filter stitchapi test`.

`pnpm --filter stitchapi size` checks the core entry against its bundle-size
budget (`packages/core/scripts/bundle-size.mjs`) — the same gate CI enforces, so
a change that grows the bundle past its ceiling fails unless the budget is
raised deliberately in the same PR.

The published library's own README is in [`packages/core/README.md`](packages/core/README.md).
