// Vendors EMBED_MODEL's files into MODEL_DIR (see lib/search-index/config.ts)
// so the deployed /api/search-docs and /api/mcp functions never fetch them from
// the HuggingFace CDN at request time — the P3 cold-start fix (see
// lib/search-index/embed.ts for the localModelPath / allowRemoteModels=false
// runtime side, and next.config.mjs's outputFileTracingIncludes for how this
// directory reaches the deployed function).
//
// Downloads through transformers.js's OWN resolution — env.cacheDir pointed at
// MODEL_DIR, remote models left enabled (the default) — rather than hand-
// listing filenames. transformers.js's FileCache key (`<repo>/<file>`,
// relative to cacheDir) and its runtime localModelPath lookup
// (`<localModelPath>/<repo>/<file>`) resolve to the identical relative layout,
// so whatever lands here from a normal download is exactly what embed.ts's
// localModelPath finds later — no manual file list to keep in sync with the
// model repo.
//
// Idempotent: transformers.js checks MODEL_DIR for each file before fetching
// it (its usual on-disk cache check), so a rerun with the files already
// present costs nothing — no network, no re-write. That also means this is
// safe to run on every Vercel build: after the first deploy it's a fast no-op
// unless the model repo actually changes.
//
// Run as a `next build` prebuild step — see prebuild-search-index.mjs, which
// gates this the same as the search-index build (Vercel/deploy only, so
// GitHub CI's `verify` build stays network-free). Locally, run by hand to
// populate the same directory for testing the route with
// allowRemoteModels=false:
//   pnpm --filter @stitchapi/docs exec node --import tsx/esm scripts/fetch-embed-model.mts
import { EMBED_DTYPE, EMBED_MODEL, MODEL_DIR } from '../lib/search-index/config';

import { env, pipeline } from '@huggingface/transformers';
import { readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelDir = resolve(appRoot, MODEL_DIR);

// Point the cache at the vendor dir directly — downloaded files land at
// exactly the path embed.ts's localModelPath will read from later (see the
// header above). Remote models stay enabled (the default): this script's only
// job is to make sure nothing is fetched at *request* time, so a build-time
// fetch here is expected and fine.
env.cacheDir = modelDir;

/** Recursively sum file sizes under `dir` (small tree — a handful of model
 * files: config, tokenizer, ONNX weights). */
function dirSize(dir: string): number {
    let total = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        total += entry.isDirectory() ? dirSize(full) : statSync(full).size;
    }
    return total;
}

async function main(): Promise<void> {
    console.log(
        `[fetch-embed-model] ${EMBED_MODEL} (${EMBED_DTYPE}) → ${MODEL_DIR}`,
    );
    const extractor = await pipeline('feature-extraction', EMBED_MODEL, {
        dtype: EMBED_DTYPE,
    });
    // Force one real inference, not just pipeline construction: this script's
    // only job is making sure nothing is fetched at request time, so it needs
    // to touch whatever files a real embed call touches — not just the ones
    // pipeline() itself happens to load eagerly.
    await extractor('warm the vendored cache', {
        pooling: 'mean',
        normalize: true,
    });

    const repoDir = resolve(modelDir, EMBED_MODEL);
    const bytes = dirSize(repoDir);
    console.log(
        `[fetch-embed-model] vendored ${(bytes / (1024 * 1024)).toFixed(1)} MB at ${repoDir}`,
    );
}

await main();
