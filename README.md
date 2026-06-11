# StitchAPI — monorepo

This repository is a [pnpm](https://pnpm.io) workspace.

| Package                             | Path                  | Description                                                       |
| ----------------------------------- | --------------------- | ----------------------------------------------------------------- |
| [`stitchapi`](packages/core)        | `packages/core`       | The published library — the `stitch` runtime, CLI, auth, tracing. |
| `@stitchapi/playground` _(private)_ | `packages/playground` | Live, in-repo SSE playground that streams `stitch` event demos.   |

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

The published library's own README is in [`packages/core/README.md`](packages/core/README.md).
