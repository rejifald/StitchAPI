// Bootstrap for the build-time search index (search_docs P1). Runs the fumadocs
// `source` outside Next, which plain `node` can't do alone:
//
//   1. Launched via `node --import tsx/esm` (see the build:search-index npm
//      script) so the generated `.source/*.ts` load as ESM — their top-level
//      `await` works — with the `collections/*` / `@/*` tsconfig path aliases and
//      the `?collection=…` query strings on the MDX imports preserved.
//   2. fumadocs-mdx/node `register()` — a Node module hook so those modules can
//      import their `*.mdx?collection=…` content the way webpack does during
//      `next build`, honoring the `docs` collection's `includeProcessedMarkdown`
//      (what getText('processed') reads).
//
// Keeping this here means the app itself stays plain CJS — only this script opts
// into the richer loaders.
import { register } from 'fumadocs-mdx/node';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Must precede any import that pulls in `.source`. Point it at source.config.ts
// so the loader applies the `docs` collection's `includeProcessedMarkdown`.
register({ configPath: resolve(appRoot, 'source.config.ts') });

const { main } = await import('./build-search-index.ts');
await main();
