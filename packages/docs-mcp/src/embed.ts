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
// `@huggingface/transformers` is an OPTIONAL peer, imported dynamically below and never at module
// load. It is optional because it is unfixably vulnerable in transitive form: it pins
// `onnxruntime-node` exactly (which requires `adm-zip ^0.5.16`, disjoint from the patched `0.6.0`)
// and wants `sharp ^0.34.5` (disjoint from the patched `0.35.x`), so a plain
// `npm i @stitchapi/docs-mcp` used to resolve five HIGH advisories that no dependency range in
// this package could move. As an optional peer it is not installed unless asked for, and search
// degrades to BM25 (see search.ts) rather than failing.
import { EMBED_DTYPE, EMBED_MODEL } from './config';

import { homedir } from 'node:os';
import { join } from 'node:path';

// Structural shapes for the optional dependency, so this module type-checks whether or not
// `@huggingface/transformers` is installed — a hard `import type` from an absent optional peer is
// itself a compile error in a consumer's tree.
interface Tensor {
    tolist(): unknown;
}
type FeatureExtractionPipeline = (
    texts: string[],
    opts: { pooling: 'mean'; normalize: boolean },
) => Promise<Tensor>;
interface TransformersModule {
    env: { cacheDir?: string };
    pipeline: (
        task: 'feature-extraction',
        model: string,
        opts: { dtype: string },
    ) => Promise<FeatureExtractionPipeline>;
}

function cacheRoot(): string {
    // XDG_CACHE_HOME (Linux/macOS convention) → LOCALAPPDATA (Windows) → ~/.cache.
    const base =
        process.env['XDG_CACHE_HOME'] ||
        process.env['LOCALAPPDATA'] ||
        join(homedir(), '.cache');
    return join(base, 'stitchapi-docs-mcp', 'transformers');
}

const BATCH_SIZE = 32;

let extractor: Promise<FeatureExtractionPipeline | undefined> | undefined;

/**
 * Load `@huggingface/transformers` if the consumer installed the optional peer, else `undefined`.
 * The specifier is built at runtime so a bundler cannot hoist it into a hard requirement, and only
 * a genuine "module not found" is treated as absence — any other failure (a corrupt install, a
 * native binding that will not load) still throws, because silently degrading to BM25 there would
 * hide a real fault behind quietly worse results.
 */
async function loadTransformers(): Promise<TransformersModule | undefined> {
    const specifier = '@huggingface/transformers';
    try {
        return (await import(specifier)) as TransformersModule;
    } catch (e) {
        if (isModuleNotFound(e)) return undefined;
        throw e;
    }
}

/**
 * Is this "the package is not installed", as opposed to "it is installed and broken"?
 *
 * Checks the whole `cause` CHAIN, not just the top-level error: every loader between us and Node —
 * a bundler, `tsx`, a test runner's module mocker — wraps the original resolution failure in its
 * own error, which strips `.code` off the value we actually catch. The message check is the
 * fallback for wrappers that do not preserve `cause` either.
 */
function isModuleNotFound(e: unknown): boolean {
    for (let cur = e, depth = 0; cur && depth < 8; depth++) {
        const err = cur as NodeJS.ErrnoException & { cause?: unknown };
        if (
            err.code === 'ERR_MODULE_NOT_FOUND' ||
            err.code === 'MODULE_NOT_FOUND'
        )
            return true;
        if (
            typeof err.message === 'string' &&
            /Cannot find (package|module) ['"]?@huggingface\/transformers/.test(
                err.message,
            )
        )
            return true;
        cur = err.cause;
    }
    return false;
}

/**
 * Lazily load (and cache) the feature-extraction pipeline, or `undefined` when the optional peer
 * is not installed. This process is long-lived (a stdio server, not a per-request serverless
 * function like the hosted route), so a transient failure — e.g. a network blip while fetching
 * the model into the cache dir on first use — must not wedge every later search_docs call: reset
 * the cache on rejection so the next call retries instead of replaying the same stale rejection
 * forever.
 */
export function getEmbedder(): Promise<FeatureExtractionPipeline | undefined> {
    if (!extractor) {
        extractor = loadTransformers()
            .then(async (mod) => {
                if (!mod) return undefined;
                mod.env.cacheDir = cacheRoot();
                return mod.pipeline('feature-extraction', EMBED_MODEL, {
                    dtype: EMBED_DTYPE,
                });
            })
            .catch((e: unknown) => {
                extractor = undefined;
                throw e;
            });
    }
    return extractor;
}

/** Embed texts into mean-pooled, L2-normalized vectors, batched. Returns `undefined` when the
 *  optional `@huggingface/transformers` peer is not installed — callers fall back to BM25. */
export async function embed(
    texts: string[],
    onProgress?: (done: number, total: number) => void,
): Promise<number[][] | undefined> {
    if (texts.length === 0) return [];
    const run = await getEmbedder();
    if (!run) return undefined;
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const output = await run(batch, { pooling: 'mean', normalize: true });
        vectors.push(...(output.tolist() as number[][]));
        onProgress?.(vectors.length, texts.length);
    }
    return vectors;
}

/** Embed a single text (the query path — search.ts). `undefined` when the optional peer is absent,
 *  which `searchDocs` reads as "run BM25 only". */
export async function embedOne(text: string): Promise<number[] | undefined> {
    const vectors = await embed([text]);
    if (vectors === undefined) return undefined;
    const [vector] = vectors;
    if (!vector) throw new Error('embedOne: embed() returned no vectors');
    return vector;
}
