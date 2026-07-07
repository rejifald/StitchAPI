// Local-only text embeddings via transformers.js — no network per query, no
// third-party call. The same model embeds both the bundled index (built ahead
// of time in apps/docs) and the incoming query, so hybrid search only works if
// this stays byte-for-byte aligned with apps/docs/lib/search-index/embed.ts's
// model + dtype (see config.ts's header comment).
//
// Unlike the hosted route (which points the cache at Vercel's writable /tmp,
// re-downloading the ~90MB model on every cold instance), this points it at a
// stable, persistent OS cache directory: the model downloads once per machine,
// then every later launch — `npx` or otherwise — reuses it, with zero network
// calls after that first run.
import { EMBED_DTYPE, EMBED_MODEL } from './config';

import {
    type FeatureExtractionPipeline,
    env,
    pipeline,
} from '@huggingface/transformers';
import { homedir } from 'node:os';
import { join } from 'node:path';

function cacheRoot(): string {
    // XDG_CACHE_HOME (Linux/macOS convention) → LOCALAPPDATA (Windows) → ~/.cache.
    const base =
        process.env['XDG_CACHE_HOME'] ||
        process.env['LOCALAPPDATA'] ||
        join(homedir(), '.cache');
    return join(base, 'stitchapi-docs-mcp', 'transformers');
}

env.cacheDir = cacheRoot();

const BATCH_SIZE = 32;

let extractor: Promise<FeatureExtractionPipeline> | undefined;

/**
 * Lazily load (and cache) the feature-extraction pipeline. This process is
 * long-lived (a stdio server, not a per-request serverless function like the
 * hosted route), so a transient failure — e.g. a network blip while fetching
 * the model into the cache dir on first use — must not wedge every later
 * search_docs call: reset the cache on rejection so the next call retries
 * instead of replaying the same stale rejection forever.
 */
export function getEmbedder(): Promise<FeatureExtractionPipeline> {
    if (!extractor) {
        extractor = pipeline('feature-extraction', EMBED_MODEL, {
            dtype: EMBED_DTYPE,
        }).catch((e: unknown) => {
            extractor = undefined;
            throw e;
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

/** Embed a single text (the query path — search.ts). */
export async function embedOne(text: string): Promise<number[]> {
    const [vector] = await embed([text]);
    if (!vector) throw new Error('embedOne: embed() returned no vectors');
    return vector;
}
