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
// Two callers run this:
//   1. The `next build` prebuild step (prebuild-search-index.mjs), gated to
//      Vercel/deploy so a plain `verify` docs build stays network-free.
//   2. The `search-relevance` job in .github/workflows/verify.yml, directly and
//      up front — behind an actions/cache of MODEL_DIR, so the normal case is a
//      restored copy and this is a no-op. That job then runs the index build and
//      the eval with VENDORED_EMBED_MODEL set, which locks embed.ts onto this
//      directory with allowRemoteModels=false. Net effect: the only step in that
//      job that may touch the network is this one, it is cached, and it retries
//      — the eval itself can no longer reach the CDN at all, so it cannot flake
//      on one (PR #758 died exactly that way; see withRetry below).
// Locally, populate the same directory by hand to test the route with
// allowRemoteModels=false:
//   pnpm --filter @stitchapi/docs fetch:embed-model
import {
    EMBED_DTYPE,
    EMBED_MODEL,
    MODEL_DIR,
} from '../lib/search-index/config';

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

// A cold vendor pulls ~83 MB from the HuggingFace CDN, which rate-limits (429)
// when several runners ask at once — four dependabot runs starting inside 40
// seconds is enough, and that is precisely how PR #758's `search-relevance` job
// died (run 33160105565: `Error (429) ... resolve/main/onnx/model.onnx`, after
// the index had already chunked 140 pages). A 429 is transient and this download
// is idempotent — transformers.js checks MODEL_DIR per file before fetching, so
// a retry re-uses whatever already landed and asks only for the rest. Retry with
// backoff rather than failing a required check on someone else's traffic burst.
const ATTEMPTS = 4;
const BACKOFF_MS = [2_000, 8_000, 20_000];

async function withRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await run();
        } catch (error) {
            if (attempt >= ATTEMPTS) throw error;
            const waitMs = BACKOFF_MS[attempt - 1] ?? 20_000;
            const why = error instanceof Error ? error.message : String(error);
            console.warn(
                `[fetch-embed-model] ${label} failed ` +
                    `(attempt ${attempt}/${ATTEMPTS}): ${why}`,
            );
            console.warn(`[fetch-embed-model] retrying in ${waitMs / 1000}s…`);
            await new Promise((r) => setTimeout(r, waitMs));
        }
    }
}

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
    const extractor = await withRetry('model download', () =>
        pipeline('feature-extraction', EMBED_MODEL, { dtype: EMBED_DTYPE }),
    );
    // Force one real inference, not just pipeline construction: this script's
    // only job is making sure nothing is fetched at request time, so it needs
    // to touch whatever files a real embed call touches — not just the ones
    // pipeline() itself happens to load eagerly.
    await withRetry('warm-up inference', () =>
        extractor('warm the vendored cache', {
            pooling: 'mean',
            normalize: true,
        }),
    );

    const repoDir = resolve(modelDir, EMBED_MODEL);
    const bytes = dirSize(repoDir);
    console.log(
        `[fetch-embed-model] vendored ${(bytes / (1024 * 1024)).toFixed(1)} MB at ${repoDir}`,
    );
}

await main();
