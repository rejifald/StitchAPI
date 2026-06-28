# @stitchapi/completions-plugin

Private, ships-nothing build tool for the docs **playground**. A webpack plugin
that generates the CodeMirror completions map from StitchAPI's own TypeScript
source at build time, so the playground's autocomplete never drifts from the
real API.

**Discovery rule.** For every exported `*Config` interface in a package's
`src/**/*.ts`, if the derived function name (`StitchConfig → stitch`) is also
exported from `src/index.ts`, it becomes a completion entry automatically. A new
primitive shows up in the playground the moment it ships — no hand-maintained
list.

## Usage

Wire `PlaygroundCompletionsPlugin` into the docs app's webpack config
(`apps/docs/next.config.mjs`), pointing it at the packages to scan and the
generated output file:

```js
import { PlaygroundCompletionsPlugin } from '@stitchapi/completions-plugin';

new PlaygroundCompletionsPlugin({
    packages: [resolve(repoRoot, 'packages/core')],
    outputFile: '/abs/path/to/playground-completions.generated.ts',
});
```

The plugin regenerates the map on webpack's `beforeCompile` hook. If generation
throws it logs and continues, leaving the last good file in place rather than
failing the build.

The same generator is exposed directly as `generatePlaygroundCompletions(opts)`
for the standalone `gen:completions` script the CI drift guard runs.

## Develop

```sh
pnpm --filter @stitchapi/completions-plugin test          # node:test codegen suite
```

CI regenerates the committed completions artifact and fails if it drifted (see
the `verify` job in [`.github/workflows/verify.yml`](../../.github/workflows/verify.yml)).

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
