# StitchAPI examples

Small, self-contained, runnable examples of the `stitchapi` core library and its
integrations.

## [`basic-typed-stitch.ts`](basic-typed-stitch.ts)

A basic, typed `stitch` with an `output` schema, run **offline**. It shows:

-   **Typed output inference** — the call's return type is inferred from the
    `output` schema; no generic or cast.
-   **Runtime validation** — an off-contract (drifted) response is _rejected_
    instead of leaking an `undefined` downstream.
-   **Pluggable transport / testability** — a tiny **mock adapter** is injected, so
    the example is deterministic and needs no network. That same injection point is
    how you unit-test a stitch.

### Run it

From the repository root (uses [`tsx`](https://github.com/privatenumber/tsx), which
is already a dev dependency of the workspace):

```sh
pnpm exec tsx examples/basic-typed-stitch.ts
```

Expected output:

```
Fetched user #42: Ada Lovelace <ada@example.com>
Drift caught: an off-contract response was rejected. ✅

examples/basic-typed-stitch OK
```

> The example imports `stitchapi` from the workspace. If you're running it from a
> standalone copy outside this monorepo, install the package first
> (`npm i stitchapi zod`) and run the file with your preferred TypeScript runner.

## [`openharness/`](openharness/) — a stitch as an agent tool

A stitch dropped into an [OpenHarness](https://github.com/MaxGfeller/open-harness)
agent as a tool, through the
[`@stitchapi/vercel-ai`](https://stitchapi.dev/docs/integrations/vercel-ai) adapter:
the model calls a capability and gets back schema-validated data. Runs **offline**
(mock transport + mock model), so no network and no API key are needed.

Because it depends on two external packages (`@openharness/core`, `ai`), it lives in
its own directory with its own `package.json` rather than as a loose file:

```sh
cd openharness && npm install && npm start
```

See [`openharness/README.md`](openharness/README.md) for the walkthrough.
