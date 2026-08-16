// Local-open text embeddings via transformers.js. Shared by the build pipeline
// (P1, embeds every chunk) and, later, the retrieval route (P2, embeds the
// query). The model loads lazily and is reused across calls.
//
// @huggingface/transformers itself is imported lazily too (inside
// loadEmbedder(), not at module top level) — not just the pipeline it builds.
// Its Node bundle has an unconditional top-level `import sharp from 'sharp'`
// (pulled in for image pipelines search_docs/get_doc never use). A static
// top-level import here would mean any sharp load failure — missing native
// binary, ERR_DLOPEN_FAILED, whatever — throws while THIS MODULE is being
// evaluated, i.e. at route-module load, which fails the whole /api/mcp route
// (get_doc and the MCP handshake included, neither of which touches
// embeddings) for the rest of that warm instance's life. That is exactly what
// the Jul 31–Aug 10 2026 outage was: ~946 "Failed to load external module
// @huggingface/transformers" errors, one per request, because a module-load
// failure doesn't stay scoped to the request that triggered it. Deferring the
// import to first call scopes a load failure to the one search_docs call that
// needed it — get_doc and initialize keep working, and the failed call just
// surfaces a rejected promise, same as any other runtime error here.
import { EMBED_DTYPE, EMBED_MODEL, MODEL_DIR } from './config';

import type { FeatureExtractionPipeline } from '@huggingface/transformers';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Embed in modest batches: one call per chunk is slow, but one call for the
// whole corpus builds a single enormous tensor that thrashes memory. 32 balances
// throughput against footprint.
const BATCH_SIZE = 32;

/** apps/docs/<MODEL_DIR> — the vendored copy scripts/fetch-embed-model.mts
 * populates at build time (see next.config.mjs's outputFileTracingIncludes for
 * how it reaches the deployed function). */
function modelDirPath(): string {
    // this file: apps/docs/lib/search-index/embed.ts → apps/docs/<MODEL_DIR>
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', '..', MODEL_DIR);
}

let extractor: Promise<FeatureExtractionPipeline> | undefined;

/** Lazily load (and cache) the feature-extraction pipeline. See the module
 * header for why the @huggingface/transformers import itself is deferred here
 * too, not just the pipeline construction. */
export function getEmbedder(): Promise<FeatureExtractionPipeline> {
    if (!extractor) {
        extractor = loadEmbedder().catch((error: unknown) => {
            // Memoizing the *rejection* would give back exactly what deferring
            // the import bought. Per the module header, a failed
            // @huggingface/transformers load is scoped to the one call that
            // needed it — but parking that rejected promise in `extractor`
            // re-widens it to every later query on this warm instance, with
            // nothing to dislodge it but a recycle. That is the module-load
            // failure mode again by another route. Drop the slot so the next
            // call retries.
            extractor = undefined;
            throw error;
        });
    }
    return extractor;
}

async function loadEmbedder(): Promise<FeatureExtractionPipeline> {
    const { env, pipeline } = await import('@huggingface/transformers');

    if (process.env.VERCEL) {
        // The deployed node_modules (the default model cache dir) is read-only,
        // so point the cache dir at the function's writable /tmp. Belt-and-
        // braces: nothing should actually write here once localModelPath
        // (below) resolves every file from disk, but a local hit never
        // attempts a cache write either way — see the transformers.js hub.js
        // loadResourceFile: caching only applies to a fetched Response, never
        // to a local FileResponse.
        env.cacheDir = '/tmp/.transformers-cache';
        // Serve the model from the copy scripts/fetch-embed-model.mts vendors
        // at build time instead of the HuggingFace CDN. Was: a ~90 MB fetch on
        // the first search per warm instance, sometimes past the 60s
        // maxDuration ceiling — the P3 cold-start watch-item this resolves.
        env.localModelPath = modelDirPath();
        // Fail loudly the first time this is called if the vendored copy is
        // missing or incomplete (transformers.js throws with the missing
        // path), instead of silently falling back to that slow CDN fetch in
        // production. build-search-index.ts calls this same path at build
        // time (see prebuild-search-index.mjs), so a broken vendor copy fails
        // the deploy, not just the first production request.
        env.allowRemoteModels = false;
    }

    return pipeline('feature-extraction', EMBED_MODEL, { dtype: EMBED_DTYPE });
}

/** Embed texts into mean-pooled, L2-normalized vectors, batched. */
export async function embed(
    texts: string[],
    onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
    if (texts.length === 0) return [];
    const run = await getEmbedder();
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const output = await run(batch, { pooling: 'mean', normalize: true });
        vectors.push(...(output.tolist() as number[][]));
        onProgress?.(vectors.length, texts.length);
    }
    return vectors;
}

/** Embed a single text. */
export async function embedOne(text: string): Promise<number[]> {
    const [vector] = await embed([text]);
    return vector;
}
