#!/usr/bin/env node
// Generate the README generated regions: the "metrics badges" block and the
// "packages"/"integrations" tables. Drift *verification* lives in yakir now (the
// readme-badges / readme-packages / core-integrations tethers, yakir.json).
//
//   pnpm gen:readme              # rewrite the blocks from the committed snapshot
//   node scripts/gen-readme-metrics.mjs --emit <region>
//                                # print one region's inner content (yakir's check path)
//   node scripts/gen-readme-metrics.mjs --refresh
//                                # refresh the snapshot from fallow + coverage, then rewrite
//
// The README carries a generated badge row between yakir region markers
// `<!-- yakir:readme-badges -->` / `<!-- /yakir:readme-badges -->`: the
// StandWithUkraine badge plus three self-describing metric badges (code health,
// test coverage, license). Each metric badge is a static shields.io URL with the
// value baked into the URL — nothing phones home; the number, already public in
// this file, is all that travels (GitHub's camo proxies the image).
//
// Two of the three metrics come from heavy tools whose output is gitignored:
//   • code health — fallow's maintainability score (`.metrics/fallow.json`,
//     written by `fallow --format json --score`).
//   • coverage    — Vitest line/branch totals (`packages/<pkg>/coverage/
//     coverage-summary.json`, from the `json-summary` reporter).
// `--refresh` snapshots both into the committed `scripts/readme-metrics.snapshot.json`
// so the yakir drift check (which runs `--emit` and compares to the committed region)
// never has to run a tool: `--emit` renders from the snapshot. Refresh the numbers
// with `pnpm metrics` (runs fallow + coverage, then `--refresh`). The license is a
// static fact read straight from the root package.json.
//
// The block is `<p align="center">` HTML (one badge per line) to match the rest
// of the README hero and stay prettier-stable: prettier does not reflow these
// single-line tags, so `--emit`, the committed region, and `prettier --check` all
// agree.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = resolve(repoRoot, 'README.md');
const corePath = resolve(repoRoot, 'packages/core/README.md');
const snapshotPath = resolve(repoRoot, 'scripts/readme-metrics.snapshot.json');
const fallowJsonPath = resolve(repoRoot, '.metrics/fallow.json');

// Region markers are yakir's canonical syntax (`<!-- yakir:NAME -->`), so each block
// is a yakir tether: the region vs. this generator's `--emit NAME` output. Drift is
// caught by `yakir check` (drift.yml) — see yakir.json. Keep the NAMEs in sync there.
const BADGES_START = '<!-- yakir:readme-badges -->';
const BADGES_END = '<!-- /yakir:readme-badges -->';

// The full workspace package table (root README).
const PACKAGES_START = '<!-- yakir:readme-packages -->';
const PACKAGES_END = '<!-- /yakir:readme-packages -->';

// The integration packages, minus core (packages/core/README.md, the npm page).
const INTEGRATIONS_START = '<!-- yakir:core-integrations -->';
const INTEGRATIONS_END = '<!-- /yakir:core-integrations -->';

// Package groups, in display order. Each publishable package is placed by its
// directory name; anything unmatched falls to "Other" (so a new package still
// appears — the drift guard will flag it — and you give it a home with one line
// here). Within a group, packages sort alphabetically.
const GROUP_ORDER = [
    { id: 'core', title: 'Core' },
    { id: 'server', title: 'Server frameworks' },
    { id: 'client', title: 'Client & UI bindings' },
    { id: 'data', title: 'Data-fetching libraries' },
    { id: 'store', title: 'State stores' },
    { id: 'auth', title: 'Auth' },
    { id: 'ai', title: 'AI' },
    { id: 'observability', title: 'Observability' },
    { id: 'surface', title: 'Surfaces' },
    { id: 'fingerprint', title: 'Cache fingerprint adapters' },
    { id: 'other', title: 'Other' },
];

const GROUP_BY_DIR = {
    core: 'core',
    express: 'server',
    fastify: 'server',
    hono: 'server',
    nest: 'server',
    next: 'server',
    elysia: 'server',
    angular: 'client',
    expo: 'client',
    react: 'client',
    'react-native': 'client',
    solid: 'client',
    svelte: 'client',
    vue: 'client',
    'query-core': 'client',
    'rtk-query': 'data',
    swr: 'data',
    'cloudflare-kv': 'store',
    'deno-kv': 'store',
    redis: 'store',
    'aws-sigv4': 'auth',
    'vercel-ai': 'ai',
    pino: 'observability',
    sentry: 'observability',
    shell: 'surface',
    download: 'surface',
};

function groupFor(dir) {
    if (GROUP_BY_DIR[dir]) return GROUP_BY_DIR[dir];
    if (/^fingerprint-/.test(dir)) return 'fingerprint';
    return 'other';
}

const STAND_WITH_UKRAINE =
    '<a href="https://stand-with-ukraine.pp.ua"><img alt="StandWithUkraine" src="https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg" /></a>';

// --- shields.io static-badge encoding ---------------------------------------
// Field separator is `-`, so a literal `-` becomes `--` and `_` becomes `__`; a
// space becomes `_`. Parens are percent-encoded so they can't be mistaken for
// the end of the image URL.
function encodeSegment(value) {
    return encodeURIComponent(
        value.replace(/-/g, '--').replace(/_/g, '__').replace(/ /g, '_'),
    )
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
}

function badgeUrl(label, message, color) {
    return `https://img.shields.io/badge/${encodeSegment(label)}-${encodeSegment(
        message,
    )}-${color}`;
}

function gradeColor(grade) {
    switch (grade?.[0]?.toUpperCase()) {
        case 'A':
            return 'brightgreen';
        case 'B':
            return 'green';
        case 'C':
            return 'yellow';
        case 'D':
            return 'orange';
        default:
            return 'red';
    }
}

function coverageColor(pct) {
    if (pct >= 90) return 'brightgreen';
    if (pct >= 80) return 'green';
    if (pct >= 70) return 'yellowgreen';
    if (pct >= 60) return 'yellow';
    if (pct >= 50) return 'orange';
    return 'red';
}

// --- snapshot ---------------------------------------------------------------
function readSnapshot() {
    return JSON.parse(readFileSync(snapshotPath, 'utf8'));
}

function readLicense() {
    return JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
        .license;
}

/**
 * Sum every `packages/<pkg>/coverage/coverage-summary.json` (and `apps/`) into a
 * single repo-wide percentage, weighted by line/branch counts — the correct way
 * to combine coverage across independent runs (averaging per-package percentages
 * would over-weight tiny packages). Returns null when no summary exists yet.
 */
function aggregateCoverage() {
    let lc = 0;
    let lt = 0;
    let bc = 0;
    let bt = 0;
    for (const group of ['packages', 'apps']) {
        const groupDir = resolve(repoRoot, group);
        if (!existsSync(groupDir)) continue;
        for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const file = resolve(
                groupDir,
                entry.name,
                'coverage/coverage-summary.json',
            );
            if (!existsSync(file)) continue;
            const total = JSON.parse(readFileSync(file, 'utf8')).total;
            if (!total?.lines || !total.branches || total.lines.total === 0)
                continue;
            lc += total.lines.covered;
            lt += total.lines.total;
            bc += total.branches.covered;
            bt += total.branches.total;
        }
    }
    if (lt === 0) return null;
    const pct = (covered, total) => Math.round((covered / total) * 1000) / 10;
    return { lines: pct(lc, lt), branches: pct(bc, bt) };
}

/** fallow maintainability score + grade from `.metrics/fallow.json`. Null if absent. */
function readHealth() {
    if (!existsSync(fallowJsonPath)) return null;
    const hs = JSON.parse(readFileSync(fallowJsonPath, 'utf8')).health
        ?.health_score;
    if (typeof hs?.score !== 'number' || typeof hs?.grade !== 'string')
        return null;
    return { score: Math.round(hs.score), grade: hs.grade };
}

function refreshSnapshot() {
    const snapshot = readSnapshot();

    const health = readHealth();
    if (health) {
        snapshot.health = health;
    } else {
        console.warn(
            '[readme-metrics] .metrics/fallow.json not found — keeping the existing code-health score. Run `pnpm metrics` to refresh it.',
        );
    }

    const coverage = aggregateCoverage();
    if (coverage) {
        snapshot.coverage = coverage;
    } else {
        console.warn(
            '[readme-metrics] no coverage-summary.json found — keeping the existing coverage. Run `pnpm test:coverage` to refresh it.',
        );
    }

    // 4-space to match the repo's prettier config (tabWidth: 4), so a refresh
    // leaves the snapshot already-formatted.
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 4)}\n`);
    return snapshot;
}

// --- render -----------------------------------------------------------------
/** The inner badge row (no markers) — what `--emit readme-badges` prints and yakir compares. */
function badgesRow(snapshot) {
    const { health, coverage } = snapshot;
    const license = readLicense();
    const badges = [
        STAND_WITH_UKRAINE,
        `<img alt="code health: ${health.score} (${health.grade})" src="${badgeUrl(
            'code health',
            `${health.score} (${health.grade})`,
            gradeColor(health.grade),
        )}" />`,
        `<img alt="coverage: ${Math.round(coverage.lines)}% lines · ${Math.round(
            coverage.branches,
        )}% branches" src="${badgeUrl(
            'coverage',
            `${Math.round(coverage.lines)}% lines · ${Math.round(
                coverage.branches,
            )}% branches`,
            coverageColor(coverage.lines),
        )}" />`,
        `<a href="LICENSE"><img alt="license: ${license}" src="${badgeUrl(
            'license',
            license,
            'blue',
        )}" /></a>`,
    ];
    return `<p align="center">\n  ${badges.join('\n  ')}\n</p>`;
}

function renderBlock(snapshot) {
    return `${BADGES_START}\n\n${badgesRow(snapshot)}\n\n${BADGES_END}`;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splice(readme, block, start, end) {
    if (!readme.includes(start) || !readme.includes(end)) {
        throw new Error(
            `[readme-metrics] markers not found in README.md — restore the ${start} / ${end} pair.`,
        );
    }
    const region = new RegExp(
        `${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`,
    );
    return readme.replace(region, block);
}

// --- packages table ---------------------------------------------------------
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * The one-line headline of a package description: the clause before the first
 * spaced dash, trimmed to its first sentence. Keeps the table scannable while
 * the full description still lives in each package.json (and on npm).
 */
function packageHeadline(description) {
    let s = (description || '').split(/\s+[—–-]\s+/)[0].trim();
    const sentenceEnd = s.indexOf('. ');
    if (sentenceEnd !== -1) s = s.slice(0, sentenceEnd);
    // Drop the trailing "for StitchAPI" every integration repeats — in this
    // table the context is given. A meaningful tail ("for ArkType") is kept.
    return s
        .replace(/\.+$/, '')
        .replace(/\s+for (the )?StitchAPI( playground)?$/, '')
        .trim();
}

/**
 * Curated, scannable one-liner per package for the table's Description column,
 * keyed by directory slug. Hand-written so the table says what each package
 * *does* — the full npm-facing description still lives in each package.json
 * (and the per-package README links to npm). A package with no entry here falls
 * back to {@link packageHeadline}, so a newly added package still appears (the
 * drift guard flags it) — give it a line here when you do.
 */
const TABLE_DESCRIPTIONS = {
    core: 'Turn any API into a typed, resilient function',
    // Server frameworks
    express: 'Request-scoped seam on req, with SSE and error mapping',
    fastify: 'App/request seam with SSE, error and Pino-logger bridges',
    hono: 'Edge-ready seam on the request context; SSE and errors',
    elysia: 'Web-standard seam on the context; SSE and error mapping',
    nest: 'Injectable stitches wired into the Nest DI graph',
    next: 'Stream a stitch as an SSE Response in the App Router',
    // Client & UI bindings
    angular: 'Stitch lifecycle as Angular signals and an RxJS observable',
    expo: 'Streaming over expo/fetch with a secure-store token store',
    react: 'Tearing-free useStitch / useStitchStream hooks',
    'react-native': 'Streaming XHR adapter and AsyncStorage-backed store',
    solid: 'createStitch primitives reconciled into a Solid store',
    svelte: 'Stitch stores for Svelte 4 and 5 (unary + streaming)',
    vue: 'Reactive useStitch / useStitchStream composables',
    'query-core': 'Framework-agnostic reactive store behind the UI bindings',
    // Data-fetching libraries
    'rtk-query': 'Run a stitch as an RTK Query endpoint, with stream updates',
    swr: 'Run a stitch as an SWR fetcher; SWR owns caching',
    // State stores
    redis: 'Distributed throttle and shared sessions via Redis',
    'cloudflare-kv': 'Edge cache and shared sessions on Workers KV',
    'deno-kv': 'Distributed throttle and sessions on Deno KV',
    // Auth
    'aws-sigv4': 'Sign requests with AWS SigV4 (edge-safe Web Crypto)',
    // AI
    'vercel-ai': 'Expose a stitch as a model-callable tool, credential-safe',
    // Observability
    pino: 'The stitch event stream as structured Pino logs',
    sentry: 'Stitch events as Sentry breadcrumbs, with error capture',
    // Surfaces
    shell: 'Run a static local command as a stitch (injection-proof)',
    download: 'Batch file downloads with FIFO concurrency, cancel, and ETA',
    // Cache fingerprint adapters
    'fingerprint-arktype': 'Cache-fingerprint strategy for ArkType schemas',
    'fingerprint-effect': 'Cache-fingerprint strategy for Effect Schema',
    'fingerprint-typebox': 'Cache-fingerprint strategy for TypeBox schemas',
    'fingerprint-valibot': 'Cache-fingerprint strategy for Valibot schemas',
    'fingerprint-zod': 'Cache-fingerprint strategy for Zod schemas',
};

/** Every publishable workspace package (skips `private`). */
function readPackages() {
    const dir = resolve(repoRoot, 'packages');
    const pkgs = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pjPath = resolve(dir, entry.name, 'package.json');
        if (!existsSync(pjPath)) continue;
        const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
        if (pj.private) continue;
        pkgs.push({
            name: pj.name,
            slug: entry.name,
            dir: `packages/${entry.name}`,
            headline:
                TABLE_DESCRIPTIONS[entry.name] ??
                packageHeadline(pj.description),
        });
    }
    return pkgs;
}

/**
 * Render a set of packages as one grouped HTML `<table>`. HTML (not a Markdown
 * table) so prettier leaves it byte-for-byte alone — the same reason the badge
 * block is HTML — keeping `gen:readme`, `prettier --write`, and the `--check`
 * drift guard from ever fighting over Markdown column alignment. Groups follow
 * {@link GROUP_ORDER}; packages sort alphabetically within each group.
 */
function renderPackagesTable(pkgs) {
    const byGroup = new Map();
    for (const p of pkgs) {
        const id = groupFor(p.slug);
        if (!byGroup.has(id)) byGroup.set(id, []);
        byGroup.get(id).push(p);
    }
    const lines = [
        '<table>',
        '<thead><tr><th>Package</th><th>Description</th></tr></thead>',
        '<tbody>',
    ];
    for (const group of GROUP_ORDER) {
        const members = byGroup.get(group.id);
        if (!members || members.length === 0) continue;
        members.sort((a, b) => a.name.localeCompare(b.name));
        lines.push(`<tr><th colspan="2">${escapeHtml(group.title)}</th></tr>`);
        for (const p of members) {
            lines.push(
                `<tr><td><a href="${p.dir}"><code>${escapeHtml(
                    p.name,
                )}</code></a></td><td>${escapeHtml(p.headline)}</td></tr>`,
            );
        }
    }
    lines.push('</tbody>', '</table>');
    return lines.join('\n');
}

/** Root README region: the whole workspace, core included. */
function renderRootPackages() {
    const table = renderPackagesTable(readPackages());
    return `${PACKAGES_START}\n\n${table}\n\n${PACKAGES_END}`;
}

/** Core (npm) README region: the integration packages, minus core itself. */
function renderCoreIntegrations() {
    const table = renderPackagesTable(
        readPackages().filter((p) => p.name !== 'stitchapi'),
    );
    return `${INTEGRATIONS_START}\n\n${table}\n\n${INTEGRATIONS_END}`;
}

// --- main -------------------------------------------------------------------

// `--emit NAME` prints one region's inner content (no markers) to stdout — the
// drift-check path: yakir's readme tethers run it and compare it to the committed
// region (see yakir.json). Drift verification lives in yakir now, not `--check`.
const emitIdx = process.argv.indexOf('--emit');
if (emitIdx !== -1) {
    const name = process.argv[emitIdx + 1];
    const inner = {
        'readme-badges': () => badgesRow(readSnapshot()),
        'readme-packages': () => renderPackagesTable(readPackages()),
        'core-integrations': () =>
            renderPackagesTable(
                readPackages().filter((p) => p.name !== 'stitchapi'),
            ),
    }[name];
    if (!inner) {
        console.error(
            '--emit expects one of: readme-badges, readme-packages, core-integrations',
        );
        process.exit(2);
    }
    process.stdout.write(inner());
    process.exit(0);
}

const mode = process.argv.includes('--refresh') ? 'refresh' : 'write';

const snapshot = mode === 'refresh' ? refreshSnapshot() : readSnapshot();

// Each target is a README file plus the transform that splices its generated
// regions. The root README carries the badge + full-packages regions; the core
// (npm) README carries the integrations region.
const targets = [
    {
        label: 'README.md',
        path: readmePath,
        transform: (src) => {
            let out = splice(
                src,
                renderBlock(snapshot),
                BADGES_START,
                BADGES_END,
            );
            return splice(
                out,
                renderRootPackages(),
                PACKAGES_START,
                PACKAGES_END,
            );
        },
    },
    {
        label: 'packages/core/README.md',
        path: corePath,
        transform: (src) =>
            splice(
                src,
                renderCoreIntegrations(),
                INTEGRATIONS_START,
                INTEGRATIONS_END,
            ),
    },
];

let wrote = false;
for (const target of targets) {
    const src = readFileSync(target.path, 'utf8');
    const next = target.transform(src);
    if (next === src) continue;
    wrote = true;
    writeFileSync(target.path, next);
    console.log(`✓ Wrote generated content in ${target.label}.`);
}

if (!wrote) {
    console.log(
        `✓ Generated README content already current${mode === 'refresh' ? ' (snapshot refreshed)' : ''}.`,
    );
}
