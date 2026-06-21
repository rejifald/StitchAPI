import {
    HAND_MAINTAINED_SECTIONS,
    type Section,
    pages,
    sections,
} from '../content.manifest';

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The anti-drift gate the manifest header promises. `content.manifest.ts` is the
// source of truth for the docs IA, but pages were being added straight into the
// per-folder `meta.json` files, so the manifest silently rotted and a stray
// `gen:docs` would have deleted real pages. These tests fail the moment the
// manifest and the on-disk content disagree.
//
// Byte-level idempotency (re-running `gen:docs` produces no diff, including
// Prettier formatting) is enforced by the CI gate in .github/workflows/verify.yml
// that runs the real generator and `git diff --exit-code`. The
// "matches what the manifest would generate" test below is the formatting-
// independent semantic half of that, runnable in `pnpm test`.

const DOCS_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const CONTENT = resolve(DOCS_ROOT, 'content', 'docs');

interface MetaJson {
    title: string;
    description?: string;
    icon?: string;
    pages: string[];
}

/** Absolute paths of every file ending in `suffix` under `dir`. */
function walk(dir: string, suffix: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full, suffix));
        else if (entry.name.endsWith(suffix)) out.push(full);
    }
    return out;
}

/** content/docs-relative manifest path for an .mdx file: posix, no extension. */
const toManifestPath = (absMdx: string): string =>
    relative(CONTENT, absMdx)
        .split(sep)
        .join('/')
        .replace(/\.mdx$/, '');

const isUnderHandMaintained = (p: string): boolean =>
    [...HAND_MAINTAINED_SECTIONS].some((h) => p === h || p.startsWith(`${h}/`));

const parentOf = (p: string): string =>
    p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const baseOf = (p: string): string =>
    p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;

// Mirror of generate-skeleton.mjs's childrenOf. Kept honest by the CI `gen:docs`
// diff gate, which runs the real generator — if this drifts from it, that gate
// reds. (Can't import the generator directly: it's an .mjs whose `.ts`-extension
// import would trip `tsc`'s allowImportingTsExtensions in `check:types`.)
function childrenOf(folderPath: string): string[] {
    const subfolders = sections
        .filter((s) => s.path !== '' && parentOf(s.path) === folderPath)
        .map((s) => baseOf(s.path));
    const leaves = pages
        .filter(
            (p) =>
                parentOf(p.path) === folderPath && baseOf(p.path) !== 'index',
        )
        .map((p) => baseOf(p.path));
    return [...subfolders, ...leaves];
}

const metaPathFor = (section: Section): string =>
    section.path
        ? join(CONTENT, section.path, 'meta.json')
        : join(CONTENT, 'meta.json');

describe('content manifest ↔ content/docs two-way sync', () => {
    const diskPages = walk(CONTENT, '.mdx').map(toManifestPath);
    const manifestPaths = new Set(pages.map((p) => p.path));

    it('lists every .mdx on disk (except hand-maintained sections)', () => {
        const undocumented = diskPages
            .filter((p) => !manifestPaths.has(p) && !isUnderHandMaintained(p))
            .sort();
        expect(
            undocumented,
            `undocumented pages — add to content.manifest.ts:\n${undocumented.join('\n')}`,
        ).toEqual([]);
    });

    it('has a file on disk for every manifest page', () => {
        const orphans = pages
            .filter((p) => !existsSync(join(CONTENT, `${p.path}.mdx`)))
            .map((p) => p.path)
            .sort();
        expect(
            orphans,
            `manifest entries with no .mdx file:\n${orphans.join('\n')}`,
        ).toEqual([]);
    });

    it('never lists a page that lives under a hand-maintained section', () => {
        const stray = pages
            .filter((p) => isUnderHandMaintained(p.path))
            .map((p) => p.path);
        expect(stray).toEqual([]);
    });

    it('has an existing folder for every manifest section', () => {
        const missing = sections
            .map((s) => (s.path ? join(CONTENT, s.path) : CONTENT))
            .filter((dir) => !existsSync(dir));
        expect(missing).toEqual([]);
    });

    it('declares a section for every folder that owns a meta.json', () => {
        const declared = new Set(sections.map((s) => s.path));
        const undeclared = walk(CONTENT, 'meta.json')
            .map((f) => relative(CONTENT, f).split(sep).slice(0, -1).join('/'))
            .filter((p) => !declared.has(p) && !HAND_MAINTAINED_SECTIONS.has(p))
            .sort();
        expect(
            undeclared,
            `folders with a meta.json but no section entry:\n${undeclared.join('\n')}`,
        ).toEqual([]);
    });
});

describe('committed meta.json is what the manifest would generate', () => {
    it('every generator-owned meta.json matches the manifest (title, order, blurb)', () => {
        for (const section of sections) {
            if (HAND_MAINTAINED_SECTIONS.has(section.path)) continue;
            const file = metaPathFor(section);
            const actual: unknown = JSON.parse(readFileSync(file, 'utf8'));
            const expected: MetaJson = {
                title: section.title,
                ...(section.description
                    ? { description: section.description }
                    : {}),
                ...(section.icon ? { icon: section.icon } : {}),
                pages: childrenOf(section.path),
            };
            expect(
                actual,
                `stale meta.json (re-run \`pnpm gen:docs\`): ${relative(CONTENT, file)}`,
            ).toEqual(expected);
        }
    });

    it('leaves hand-maintained sections out of generation but on disk', () => {
        for (const path of HAND_MAINTAINED_SECTIONS) {
            expect(existsSync(join(CONTENT, path, 'meta.json'))).toBe(true);
        }
    });
});
