// Prebuild step (npm lifecycle `prebuild` → `build`): produces and copies in
// the docs snapshot this package ships. Freshness is deliberately tied to
// *when this package is built* — a lockstep release rebuilds every
// packages/*/ package right before publishing (see .github/workflows/npm-publish.yml
// `publish-npm` job), so `@stitchapi/docs-mcp` bundles whatever apps/docs's
// content looked like on the commit that release was cut from. No separate
// publish cadence, no live fetch at runtime — see README.md "Keeping docs
// fresh".
//
// Runs apps/docs's own build:mcp-bundle (build:search-index + build:docs-pages)
// rather than re-implementing fumadocs/chunking/embedding here, so there is
// exactly one place that logic lives.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const appsDocsDir = resolve(pkgRoot, '..', '..', 'apps', 'docs');
const searchIndexDir = join(appsDocsDir, '.search-index');
const dataDir = join(pkgRoot, 'data');

const ARTIFACTS = ['docs-index.json', 'manifest.json', 'docs-pages.json'];

// This script only runs from a full monorepo checkout (the CI publish job in
// .github/workflows/npm-publish.yml, or a local `pnpm --filter
// @stitchapi/docs-mcp build`) — never from an npm install, which ships the
// bundle already built. Check for apps/docs up front so a sparse checkout or a
// package moved/extracted standalone fails with a clear message instead of an
// opaque `spawnSync pnpm ENOENT` that reads like "pnpm isn't installed".
if (!existsSync(appsDocsDir)) {
    throw new Error(
        `[docs-mcp] expected apps/docs at ${appsDocsDir}, but it doesn't exist. ` +
            `This build step only runs from a full StitchAPI monorepo checkout — ` +
            `it isn't meant to run from an installed npm package (which ships the ` +
            `bundle prebuilt).`,
    );
}

console.log('[docs-mcp] building apps/docs search index + page bundle…');
execFileSync(
    'pnpm',
    ['--filter', '@stitchapi/docs', 'run', 'build:mcp-bundle'],
    {
        cwd: appsDocsDir,
        stdio: 'inherit',
    },
);

mkdirSync(dataDir, { recursive: true });
for (const file of ARTIFACTS) {
    const src = join(searchIndexDir, file);
    if (!existsSync(src)) {
        throw new Error(
            `[docs-mcp] expected build:mcp-bundle to produce ${src}, but it's missing`,
        );
    }
    copyFileSync(src, join(dataDir, file));
    console.log(`[docs-mcp] bundled ${file}`);
}
