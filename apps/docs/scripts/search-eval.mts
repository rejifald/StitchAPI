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

// --- No-regression ratchet (CI: `--assert`) --------------------------------
// The gate is deliberately fuzzy-tolerant: embeddings are deterministic in a
// single build, but the ONNX model can differ by ~1e-6 across architectures
// (arm64 dev vs the x64 CI runner), enough to flip a borderline rank by one. So
// the hard gate is generous — it catches a page falling OUT of reach (the
// >8/>30 regressions this PR fixed), not a ±1 wobble at the edge — while the
// TARGET below is the standard every query is actually tuned to.
const ASSERT = process.argv.includes('--assert');
const TARGET_RANK = 3; // what we tune for; queries past it are reported, not failed
const HARD_MAX_RANK = 5; // fail if any expected page ranks worse than this (or is missing)
const MIN_RELEVANCE_AT_1 = 0.84; // floor; current 0.920 (25-query golden)
const MIN_MRR = 0.9; // floor; current 0.953

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
    const topT = outcomes.filter(
        (o) => o.rank >= 1 && o.rank <= TARGET_RANK,
    ).length;
    const mrr =
        outcomes.reduce((s, o) => s + (o.rank > 0 ? 1 / o.rank : 0), 0) / n;
    const rel1Frac = rel1 / n;

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
        `Relevance@1: ${rel1Frac.toFixed(3)}  (${rel1}/${n})` +
            `   Top-${TARGET_RANK}: ${(topT / n).toFixed(3)}  (${topT}/${n})` +
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

    if (ASSERT) assertNoRegression(outcomes, rel1Frac, mrr);
}

/**
 * Hard no-regression gate for CI (`--assert`). Fails (non-zero exit) when a
 * documented question can no longer find its page within reach (`HARD_MAX_RANK`),
 * or when aggregate quality drops below the committed floors. Queries between the
 * TARGET and the hard bound are reported, not failed — see the constants above.
 */
function assertNoRegression(
    outcomes: Outcome[],
    rel1Frac: number,
    mrr: number,
): void {
    const failures: string[] = [];

    for (const o of outcomes) {
        if (o.rank < 1 || o.rank > HARD_MAX_RANK) {
            failures.push(
                `rank ${fmtRank(o)} > #${HARD_MAX_RANK}  ${o.expect}  —  “${o.query}”`,
            );
        }
    }
    if (rel1Frac < MIN_RELEVANCE_AT_1) {
        failures.push(
            `Relevance@1 ${rel1Frac.toFixed(3)} < floor ${MIN_RELEVANCE_AT_1}`,
        );
    }
    if (mrr < MIN_MRR) {
        failures.push(`MRR ${mrr.toFixed(3)} < floor ${MIN_MRR}`);
    }

    const offTarget = outcomes.filter(
        (o) => o.rank < 1 || o.rank > TARGET_RANK,
    ).length;
    if (offTarget) {
        console.log(
            `note: ${offTarget} query(ies) outside top-${TARGET_RANK} but within ` +
                `the #${HARD_MAX_RANK} gate — tune toward #1 when a natural edit allows.`,
        );
    }

    if (failures.length) {
        console.error('\n✗ search relevance regressed:');
        for (const f of failures) console.error(`  - ${f}`);
        console.error('');
        process.exitCode = 1;
    } else {
        console.log(
            `✓ ratchet OK: every query ≤ #${HARD_MAX_RANK}, ` +
                `Relevance@1 ≥ ${MIN_RELEVANCE_AT_1}, MRR ≥ ${MIN_MRR}.`,
        );
    }
}

run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
