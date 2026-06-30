// Build-time semantic search index (search_docs P1).
//
// Iterates the SAME pages and processed markdown that feed llms.txt
// (`source.getPages()` → `page.data.getText('processed')`), splits each page
// into H2/H3 section chunks, embeds them locally, and persists an Orama index
// (text fields for BM25 + a vector field) as an uncommitted build artifact under
// apps/docs/.search-index/. No serving here — the P2 route restores this dump.
//
// Run from apps/docs:  pnpm run build:search-index
// The npm wrapper runs `fumadocs-mdx` first so `.source` — and thus
// `getText('processed')` — exists, then launches scripts/build-search-index.mjs,
// which runs this module via tsx (ESM, so the generated source's top-level await
// works) with the fumadocs-mdx Node loader registered to import the MDX content.
//
// See docs/proposals/search-docs.md §3, §9 (P1).
import {
    type DocChunk,
    chunkPage,
    embeddingInput,
} from '../lib/search-index/chunk';
import {
    EMBED_DIM,
    EMBED_MODEL,
    INDEX_DIR,
    INDEX_FILE,
    MANIFEST_FILE,
    ORAMA_SCHEMA,
} from '../lib/search-index/config';
import { embed, embedOne } from '../lib/search-index/embed';
import { source } from '../lib/source';

import { create, insertMultiple } from '@orama/orama';
import { persist } from '@orama/plugin-data-persistence';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(appRoot, INDEX_DIR);

// In-process determinism: a tiny epsilon to absorb float noise while still
// failing if the same text ever embeds to a meaningfully different vector.
const DETERMINISM_EPSILON = 1e-9;

export async function main(): Promise<void> {
    // 1. Chunk every page from the processed markdown — the llms.txt source.
    const pages = source.getPages();
    const chunks: DocChunk[] = [];
    for (const page of pages) {
        const processed = await page.data.getText('processed');
        chunks.push(
            ...chunkPage({
                url: page.url,
                title: page.data.title,
                processed,
            }),
        );
    }
    console.log(
        `[search-index] ${pages.length} pages → ${chunks.length} chunks`,
    );
    if (chunks.length === 0) {
        throw new Error(
            '[search-index] no chunks produced — run `fumadocs-mdx` first so .source exists',
        );
    }

    // 2. Determinism gate: the same text must embed to the same vector, or the
    //    index is not reproducible build-to-build.
    const sample = embeddingInput(chunks[0]);
    const first = await embedOne(sample);
    const second = await embedOne(sample);
    const maxDiff = first.reduce(
        (max, value, i) => Math.max(max, Math.abs(value - second[i])),
        0,
    );
    if (first.length !== EMBED_DIM) {
        throw new Error(
            `[search-index] expected ${EMBED_DIM}-dim vectors, got ${first.length}`,
        );
    }
    if (maxDiff > DETERMINISM_EPSILON) {
        throw new Error(
            `[search-index] embeddings not deterministic (maxDiff ${maxDiff})`,
        );
    }
    console.log(
        `[search-index] embeddings deterministic ✓ (dim ${first.length}, maxDiff ${maxDiff}, model ${EMBED_MODEL})`,
    );

    // 3. Embed every chunk (batched, with progress).
    const vectors = await embed(chunks.map(embeddingInput), (done, total) => {
        if (done === total || done % 96 === 0) {
            console.log(`[search-index] embedded ${done}/${total} chunks`);
        }
    });

    // 4. Build the Orama index (BM25 text fields + a vector field) and persist.
    const db = create({ schema: ORAMA_SCHEMA });
    await insertMultiple(
        db,
        chunks.map((chunk, i) => ({ ...chunk, embedding: vectors[i] })),
    );
    const dump = await persist(db, 'json');

    mkdirSync(outDir, { recursive: true });
    // persist('json') returns a string; the wider type also allows binary
    // formats, so narrow to something writeFileSync accepts.
    const serialized =
        typeof dump === 'string'
            ? dump
            : dump instanceof ArrayBuffer
              ? Buffer.from(dump)
              : dump;
    writeFileSync(join(outDir, INDEX_FILE), serialized);
    writeFileSync(
        join(outDir, MANIFEST_FILE),
        `${JSON.stringify(
            {
                model: EMBED_MODEL,
                dim: EMBED_DIM,
                pages: pages.length,
                chunks: chunks.length,
            },
            null,
            2,
        )}\n`,
    );
    console.log(
        `[search-index] wrote ${join(INDEX_DIR, INDEX_FILE)} (${chunks.length} chunks)`,
    );
}

// Executed by scripts/build-search-index.mjs (a jiti bootstrap), which awaits
// main() and sets a non-zero exit code on failure.
