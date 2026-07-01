// Local-open text embeddings via transformers.js. Shared by the build pipeline
// (P1, embeds every chunk) and, later, the retrieval route (P2, embeds the
// query). The model loads lazily and is reused across calls.

import {
    env,
    pipeline,
    type FeatureExtractionPipeline,
} from '@huggingface/transformers';

import { EMBED_DTYPE, EMBED_MODEL } from './config';

// On Vercel the deployed node_modules (the default model cache dir) is read-only,
// so point the cache at the function's writable /tmp. The model is then fetched
// on the first request per warm instance — the cold-start cost the proposal's §6
// flags as the P3 watch-item (mitigations: bundle the model, a smaller/quantized
// model, edge runtime, or keep-warm — chosen after a real Vercel measurement).
if (process.env.VERCEL) {
    env.cacheDir = '/tmp/.transformers-cache';
}

// Embed in modest batches: one call per chunk is slow, but one call for the
// whole corpus builds a single enormous tensor that thrashes memory. 32 balances
// throughput against footprint.
const BATCH_SIZE = 32;

let extractor: Promise<FeatureExtractionPipeline> | undefined;

/** Lazily load (and cache) the feature-extraction pipeline. */
export function getEmbedder(): Promise<FeatureExtractionPipeline> {
    if (!extractor) {
        extractor = pipeline('feature-extraction', EMBED_MODEL, {
            dtype: EMBED_DTYPE,
        });
    }
    return extractor;
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
