// Retrieval-quality harness for search_docs (the hosted hybrid BM25+vector docs
// search). Loads the golden query set (test/search-golden.json), runs each query
// through the SAME searchDocs() the site + MCP serve, and reports how well the
// expected page ranks:
//
//   Relevance@1 — fraction of queries whose expected page is the #1 result
//   MRR         — mean reciprocal rank of the expected page
//
// Rank is measured over DISTINCT pages in hit order (the search dialog and MCP
// dedupe section hits to one entry per page, so page rank is what a user sees).
//
// Run from the repo root, against the locally-built index:
//   pnpm --filter @stitchapi/docs run build:search-index   # once per content change
//   node --import tsx apps/docs/scripts/search-eval.mts
//
// This reads only content — it never touches the index build, the schema, or the
// hybrid weights. Tune the .mdx, rebuild, re-run, keep the win.
import { searchDocs } from '../lib/search-index/search';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface GoldenCase {
    query: string;
    expect: string; // slug, e.g. "guides/resilience/throttle"
}

// The limit the product serves with; the headline metric is measured here so it
// stays comparable across iterations. A deeper pass only locates where a missing
// page actually sits, for diagnosis.
const METRIC_LIMIT = Number(process.env.LIMIT ?? 8);
const DIAG_LIMIT = 30;

const here = dirname(fileURLToPath(import.meta.url));
const golden: GoldenCase[] = JSON.parse(
    readFileSync(resolve(here, '..', 'test', 'search-golden.json'), 'utf8'),
);

/** `/docs/guides/x` (or `/docs/guides/x#a`) → `guides/x`; slug passes through. */
function toSlug(pageUrlOrSlug: string): string {
    return pageUrlOrSlug
        .split(/[#?]/)[0]
        .replace(/^\/+/, '')
        .replace(/^docs\//, '')
        .replace(/\/$/, '');
}

/** Distinct page slugs in hit order (dedupe section hits, keep first-seen). */
async function rankedPages(query: string, limit: number): Promise<string[]> {
    const hits = await searchDocs(query, { limit });
    const seen = new Set<string>();
    const pages: string[] = [];
    for (const hit of hits) {
        const slug = toSlug(hit.pageUrl);
        if (!seen.has(slug)) {
            seen.add(slug);
            pages.push(slug);
        }
    }
    return pages;
}

interface Outcome {
    query: string;
    expect: string;
    rank: number; // 1-based page rank within METRIC_LIMIT hits; 0 = not found
    deepRank: number; // rank within DIAG_LIMIT hits; 0 = still not found
    pages: string[]; // distinct pages within METRIC_LIMIT, for diagnosis
}

async function evaluate(c: GoldenCase): Promise<Outcome> {
    const pages = await rankedPages(c.query, METRIC_LIMIT);
    const rank = pages.indexOf(c.expect) + 1;
    let deepRank = rank;
    if (rank === 0) {
        const deep = await rankedPages(c.query, DIAG_LIMIT);
        deepRank = deep.indexOf(c.expect) + 1;
    }
    return { query: c.query, expect: c.expect, rank, deepRank, pages };
}

function fmtRank(o: Outcome): string {
    if (o.rank > 0) return `#${o.rank}`;
    if (o.deepRank > 0) return `>${METRIC_LIMIT} (deep #${o.deepRank})`;
    return `>${DIAG_LIMIT}`;
}

async function run(): Promise<void> {
    console.log(
        `\nsearch-eval · ${golden.length} queries · metric limit ${METRIC_LIMIT}\n`,
    );

    const outcomes: Outcome[] = [];
    for (let i = 0; i < golden.length; i++) {
        const o = await evaluate(golden[i]);
        outcomes.push(o);
        const mark = o.rank === 1 ? '✓' : o.rank > 0 ? '·' : '✗';
        const n = String(i + 1).padStart(2, ' ');
        console.log(`${mark} [${n}] ${fmtRank(o).padEnd(18)} ${o.expect}`);
        console.log(`        “${o.query}”`);
        if (o.rank !== 1) {
            const top = o.pages
                .slice(0, 6)
                .map((p, j) => `${j + 1}. ${p === o.expect ? `» ${p} «` : p}`)
                .join('   ');
            console.log(`        top: ${top || '(no hits)'}`);
        }
    }

    const n = outcomes.length;
    const rel1 = outcomes.filter((o) => o.rank === 1).length;
    const top3 = outcomes.filter((o) => o.rank >= 1 && o.rank <= 3).length;
    const mrr =
        outcomes.reduce((s, o) => s + (o.rank > 0 ? 1 / o.rank : 0), 0) / n;

    // Worst-first, so the loop's "pick the worst query" is a glance away.
    const worst = [...outcomes]
        .filter((o) => o.rank !== 1)
        .sort((a, b) => {
            const ar = a.rank || a.deepRank || 999;
            const br = b.rank || b.deepRank || 999;
            return br - ar;
        });

    console.log(`\n${'─'.repeat(60)}`);
    console.log(
        `Relevance@1: ${(rel1 / n).toFixed(3)}  (${rel1}/${n})` +
            `   Top-3: ${(top3 / n).toFixed(3)}  (${top3}/${n})` +
            `   MRR: ${mrr.toFixed(3)}`,
    );
    if (worst.length) {
        console.log(`\nNot #1 (worst first):`);
        for (const o of worst) {
            console.log(
                `  ${fmtRank(o).padEnd(18)} ${o.expect}  —  “${o.query}”`,
            );
        }
    } else {
        console.log(`\nAll queries rank #1. ✓`);
    }
    console.log('');
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
