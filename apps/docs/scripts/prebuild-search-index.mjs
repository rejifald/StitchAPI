// Build the semantic search index as a `next build` step — but ONLY at deploy
// (Vercel) or when explicitly forced, so GitHub CI's `verify` build stays fast
// and network-free (no ~90 MB model download). Locally, run
// `pnpm --filter @stitchapi/docs build:search-index` by hand to populate
// apps/docs/.search-index/ for testing the route.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.VERCEL && !process.env.BUILD_SEARCH_INDEX) {
    console.log(
        '[search-index] skipped — set VERCEL or BUILD_SEARCH_INDEX to build it (deploy only).',
    );
    process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');

// `.source` (fumadocs collections) must exist before the index build reads
// getText('processed'); generate it, then embed + persist the dump.
const steps = [
    ['pnpm', ['exec', 'fumadocs-mdx']],
    ['node', ['--import', 'tsx/esm', resolve(here, 'build-search-index.mjs')]],
];
for (const [bin, args] of steps) {
    const result = spawnSync(bin, args, { cwd: appRoot, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
}
