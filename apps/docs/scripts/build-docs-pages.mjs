// Bootstrap for build-docs-pages.ts — identical rationale to
// build-search-index.mjs (see that file's header): `node --import tsx/esm` plus
// fumadocs-mdx/node `register()` are needed so the generated `.source/*.ts`
// loads as ESM outside Next, with `?collection=…` MDX imports resolved.
import { register } from 'fumadocs-mdx/node';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

register({ configPath: resolve(appRoot, 'source.config.ts') });

const { main } = await import('./build-docs-pages.ts');
await main();
