// Build the semantic search index as a `next build` step — but ONLY at deploy
// (Vercel) or when explicitly forced, so GitHub CI's `verify` build stays fast
// and network-free (no ~90 MB model download). Locally, run
// `pnpm --filter @stitchapi/docs build:search-index` by hand to populate
// apps/docs/.search-index/ for testing the route.
//
// Also vendors the embedding model itself (fetch-embed-model.mts) before
// building the index — build-search-index.ts embeds every chunk with the SAME
// model, so this doubles as the deploy-time correctness check for the vendored
// copy: a missing/corrupt model file fails this step (and the whole build)
// loudly, instead of failing quietly at the first production search_docs call.
// See lib/search-index/embed.ts for the runtime (localModelPath /
// allowRemoteModels) side of this P3 cold-start fix.
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

// The model must land before EITHER of the other two steps: build-search-
// index.ts's embed() call runs under the same Vercel-only localModelPath lock-
// in as the runtime route (see embed.ts), so it needs the vendored copy to
// already exist. `.source` (fumadocs collections) must exist before the index
// build reads getText('processed'); generate it, then embed + persist the dump.
const steps = [
    ['node', ['--import', 'tsx/esm', resolve(here, 'fetch-embed-model.mts')]],
    ['pnpm', ['exec', 'fumadocs-mdx']],
    ['node', ['--import', 'tsx/esm', resolve(here, 'build-search-index.mjs')]],
];
for (const [bin, args] of steps) {
    const result = spawnSync(bin, args, { cwd: appRoot, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
}
