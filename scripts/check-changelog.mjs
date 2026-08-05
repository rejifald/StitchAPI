#!/usr/bin/env node
// Structural guard for CHANGELOG.md.
//
// This exists because the same defect has now shipped twice. A branch cut from an
// older `main` writes its entry under a `### Added` (or `### Fixed`) heading that
// its base did not have yet; by merge time `main` HAS that heading, but the two
// live at different offsets, so git merges both cleanly and Unreleased ends up with
// TWO of the same section. #597 did it to `Fixed` (repaired by #598), and #620 did
// it to `Added` — grafting a second `### Added` between `Changed` and `Fixed`.
// Nothing failed either time: the entry text is fine, only its placement is wrong,
// and no existing check reads the changelog's SHAPE. `check:release` only asserts
// that a `## [version]` heading exists at publish time.
//
// The cost of missing it is a released changelog whose reader has to know to scroll
// past `Changed` and `Fixed` to find the rest of what was added.
//
// Checks:
//   1. Duplicate subsection — no two `###` headings with the SAME TEXT inside one
//      `## [...]` release block. Compared verbatim, not by stem, because several
//      historical releases deliberately carry more than one `Added` split by theme
//      (`### Added — the integration ecosystem` alongside `### Added — a published
//      testing story` in 1.0.0-rc.3). Those are distinct headings and stay legal;
//      two bare `### Added`s are not.
//   2. Subsection order — the Keep a Changelog order (Added, Changed, Deprecated,
//      Removed, Fixed, Security) within `## [Unreleased]`. Scoped to Unreleased
//      because that is the only block PRs still write to; published blocks are
//      frozen history and several predate the convention. Headings outside the
//      canonical set (`Notes`, `CI / release hardening`) are not ordered against
//      anything — they only have to not duplicate.
//
// Fenced code blocks are skipped, so a `###` inside a ```ts sample is not a heading.
//
// Exit code is 1 if any check fails. Run via `pnpm check:changelog`. Takes an
// optional path so the rules can be exercised against another revision of the file
// (`git show <ref>:CHANGELOG.md > /tmp/old.md && node scripts/check-changelog.mjs /tmp/old.md`).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
const PATH = target ? resolve(target) : join(ROOT, 'CHANGELOG.md');
const FILE = target ?? 'CHANGELOG.md';

/** Keep a Changelog 1.1.0 section order. */
const CANONICAL = [
    'Added',
    'Changed',
    'Deprecated',
    'Removed',
    'Fixed',
    'Security',
];

/**
 * The canonical stem of a heading, so `Added — the integration ecosystem` ranks as
 * `Added`. Returns null for a heading outside the canonical set.
 */
function stemOf(text) {
    const stem = text.split(' — ')[0].trim();
    return CANONICAL.includes(stem) ? stem : null;
}

/**
 * Parse CHANGELOG.md into release blocks. A block is one `## ` heading and the
 * `### ` headings under it, each with the 1-based line it sits on. Lines inside a
 * fenced code block are not headings — entries embed ```ts migration samples, and
 * the fences are indented under a list item.
 */
function parseBlocks(body) {
    const blocks = [];
    let fenced = false;
    body.split('\n').forEach((line, i) => {
        if (/^\s*```/.test(line)) {
            fenced = !fenced;
            return;
        }
        if (fenced) return;
        if (/^##\s/.test(line)) {
            blocks.push({
                title: line.replace(/^##\s+/, '').trim(),
                line: i + 1,
                sections: [],
            });
        } else if (/^###\s/.test(line) && blocks.length) {
            blocks[blocks.length - 1].sections.push({
                text: line.replace(/^###\s+/, '').trim(),
                line: i + 1,
            });
        }
    });
    return blocks;
}

const failures = [];
const fail = (msg) => failures.push(msg);

const body = readFileSync(PATH, 'utf8');
const blocks = parseBlocks(body);

if (blocks.length === 0) {
    fail(
        `${FILE}: no "## [version]" release blocks found — is the file intact?`,
    );
}

// 1. Duplicate subsection headings within a release block ----------------------
let sectionCount = 0;
for (const block of blocks) {
    const seen = new Map(); // heading text -> first line it appeared on
    for (const section of block.sections) {
        sectionCount++;
        const first = seen.get(section.text);
        if (first === undefined) {
            seen.set(section.text, section.line);
            continue;
        }
        fail(
            `${FILE}:${section.line}: duplicate "### ${section.text}" under "## ${block.title}" ` +
                `(already open at ${FILE}:${first}). Merge these entries into the section at ` +
                `line ${first} and delete this heading — one section per kind, per release.`,
        );
    }
}

// 2. Keep a Changelog subsection order, within [Unreleased] --------------------
const unreleased = blocks.find((b) => /^\[?Unreleased\]?/i.test(b.title));
if (unreleased) {
    let highest = { rank: -1, text: null };
    for (const section of unreleased.sections) {
        const stem = stemOf(section.text);
        if (stem === null) continue; // `Notes` and friends are unordered
        const rank = CANONICAL.indexOf(stem);
        if (rank < highest.rank) {
            fail(
                `${FILE}:${section.line}: "### ${section.text}" comes after "### ${highest.text}" ` +
                    `under "## ${unreleased.title}". Keep a Changelog order is ` +
                    `${CANONICAL.join(' → ')}.`,
            );
        } else {
            highest = { rank, text: section.text };
        }
    }
}

// ---- report ------------------------------------------------------------------
for (const m of failures) console.error(`  ✗ ${m}`);

if (failures.length) {
    console.error(
        `\ncheck:changelog FAILED (${failures.length} problem${failures.length > 1 ? 's' : ''}).`,
    );
    process.exit(1);
}
console.log(
    `  ✓ ${FILE}: ${sectionCount} subsection(s) across ${blocks.length} release block(s) — no duplicates, Unreleased in Keep a Changelog order`,
);
console.log('\ncheck:changelog passed.');
