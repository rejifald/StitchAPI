#!/usr/bin/env node
// Keep every *advertised* bundle size in sync with the *measured* one.
//
// The bundle size is a selling point, so it is quoted in several human-facing
// places — both READMEs, two docs pages, the homepage metrics band, and the
// agent-facing llms.txt preamble. Each quote is a hand-typed number, and a
// hand-typed number drifts: the gate
// (packages/core/scripts/bundle-size.mjs) trims the entry to 20.7 kB while a
// README still brags "~24 kB", or someone bumps the budget and forgets the prose.
//
// This makes the gate the single source of truth and fails the build when any
// quote disagrees with it. The advertised figure is the *rounded* gzip size
// (`~21 kB`) — the `~` plus rounding means the number only changes when it
// genuinely should, so this does not churn on every byte.
//
// Two modes, one script:
//   • measured  — when packages/core/lib is built (CI `size` job, `pnpm size`),
//                 run the real measurement and assert each file quotes it.
//   • consensus — when lib is not built (lefthook pre-commit, no build step),
//                 fall back to asserting every file agrees with the others, so a
//                 partial edit ("changed the README, forgot the docs") still trips.
//
// Invoked from:
//   - `pnpm check:size-docs`           — verify.yml `size` job (after the build)
//   - lefthook pre-commit `size-docs`  — when an advertising file is staged
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Every place that advertises the gzipped bundle size. `allow` lists numbers
// that legitimately appear alongside the gzip figure but are NOT it (e.g. the
// core README also cites raw and brotli sizes) so the check ignores them.
const FILES = [
    { rel: 'README.md', allow: [] },
    { rel: 'packages/core/README.md', allow: [64, 20] },
    {
        rel: 'apps/docs/content/docs/getting-started/installation.mdx',
        allow: [],
    },
    { rel: 'apps/docs/content/docs/concepts/principles.mdx', allow: [] },
    { rel: 'apps/docs/app/(home)/components/metrics.tsx', allow: [] },
    // The llms.txt / llms-full.txt preamble an agent reads before the docs index.
    { rel: 'apps/docs/lib/source.ts', allow: [] },
];

// A bundle-size quote: `~21 kB`. Tolerates the separators used across markdown,
// HTML prose, and shields.io badge URLs (` `, `&nbsp;`, `%20`).
const TOKEN = /~\s*(\d+)\s*kB/g;

const eqSet = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);
const sortedUnique = (nums) => [...new Set(nums)].sort((a, b) => a - b);
const fmt = (nums) => nums.map((n) => `~${n} kB`).join(' / ');

/** The two rounded gzip figures, or null if core/lib is not built. */
function measure() {
    try {
        const out = execFileSync(
            'node',
            [join(repoRoot, 'packages/core/scripts/bundle-size.mjs'), '--json'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const rows = JSON.parse(out);
        const kb = (re) => {
            const row = rows.find((r) => re.test(r.name));
            return row ? Math.round(row.gzip / 1024) : null;
        };
        const entry = kb(/whole entry/i);
        const imported = kb(/import \{ stitch \}/i);
        if (entry == null || imported == null) return null;
        return sortedUnique([entry, imported]);
    } catch {
        return null; // lib not built — caller falls back to consensus mode
    }
}

/** The bundle-size numbers quoted in one file, minus its allowlist. */
function quoted({ rel, allow }) {
    const text = readFileSync(join(repoRoot, rel), 'utf8').replace(
        /&nbsp;|%20/g,
        ' ',
    );
    const nums = [...text.matchAll(TOKEN)].map((m) => Number(m[1]));
    return sortedUnique(nums.filter((n) => !allow.includes(n)));
}

const files = FILES.map((f) => ({ ...f, nums: quoted(f) }));
const expected = measure();
const failures = [];
let truth;

if (expected) {
    truth = expected;
} else {
    // Consensus: the figure the most files agree on is the reference.
    const tally = new Map();
    for (const f of files) {
        const key = f.nums.join(',');
        tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    const ref = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    truth = ref ? ref.split(',').filter(Boolean).map(Number) : [];
}

for (const f of files) {
    if (!eqSet(f.nums, truth)) {
        failures.push(`  ${f.rel} — quotes ${fmt(f.nums) || '(none)'}`);
    }
}

const source = expected ? 'measured' : 'consensus';

if (failures.length) {
    console.error(
        `\n✗ Advertised bundle size has drifted (source: ${source} = ${fmt(truth)}).\n` +
            failures.join('\n') +
            `\n\n  Every quote must read ${fmt(truth)}. Update the file(s) above, or\n` +
            `  if the bundle genuinely changed, re-measure with \`pnpm --filter stitchapi size\`\n` +
            `  and update all advertised numbers together.\n`,
    );
    process.exit(1);
}

console.log(
    `✓ Advertised bundle size in sync across ${files.length} files (${source}: ${fmt(truth)}).`,
);
