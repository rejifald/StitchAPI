// Generate the docs skeleton from content.manifest.ts.
//
// Emits, under content/docs:
//   - one folder + meta.json per section (sidebar label, icon, ordered children)
//   - one stub .mdx per page, carrying its template's required headings
//
// Safe to re-run: existing .mdx files are left untouched (never clobbers edits);
// meta.json is always rewritten (it is derived). The scaffold's stock
// index.mdx / test.mdx are removed on first run.
//
// Run: node scripts/generate-skeleton.mjs   (from apps/docs)
import { pages, sections } from '../content.manifest.ts';

import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CONTENT = resolve(here, '..', 'content', 'docs');

const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p) => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p);
const yaml = (s) => JSON.stringify(s); // JSON strings are valid YAML double-quoted scalars

// Per-kind stub: an optional lead line + the template's required headings.
// Plain markdown only (no MDX comments / JSX) so Prettier and the MDX build
// stay happy, and no `ts twoslash` blocks so the build doesn't typecheck a stub.
const TEMPLATES = {
    landing: {
        lead: 'Stub — orient the reader and link into this section.',
        headings: [],
    },
    tutorial: {
        lead: 'Stub — what the reader will achieve, then the steps.',
        headings: ['Steps'],
    },
    concept: {
        lead: 'Stub — what it is, in one or two sentences.',
        headings: ["Why it's shaped this way", 'How it relates', 'See also'],
    },
    guide: {
        lead: 'Stub — what this does and when you reach for it.',
        headings: ['Example', 'Options', 'See also'],
    },
    reference: {
        lead: 'Stub — what this page documents.',
        headings: ['Signature', 'See also'],
    },
    error: {
        lead: null,
        headings: [
            "What you'll see",
            'Why it happens',
            'How to fix',
            'Related',
        ],
    },
};

function stubBody(kind) {
    const t = TEMPLATES[kind] ?? TEMPLATES.guide;
    const parts = [];
    if (t.lead) parts.push(`${t.lead} See AUTHORING.md.`);
    for (const h of t.headings) parts.push(`## ${h}\n\nStub.`);
    return `${parts.join('\n\n')}\n`;
}

function stub(p) {
    return `---\ntitle: ${yaml(p.title)}\ndescription: ${yaml(p.description)}\n---\n\n${stubBody(p.kind)}`;
}

// Ordered immediate children of a folder (subfolders first, then leaf pages),
// excluding the folder's own index — that is the folder's landing page.
function childrenOf(folderPath) {
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

// 1. Drop scaffold cruft so the manifest's `index` can take over the docs home.
const stockIndex = join(CONTENT, 'index.mdx');
if (
    existsSync(stockIndex) &&
    /Hello World|start writing/.test(readFileSync(stockIndex, 'utf8'))
) {
    rmSync(stockIndex);
}
const stockTest = join(CONTENT, 'test.mdx');
if (existsSync(stockTest)) rmSync(stockTest);

// Sections whose meta.json is HAND-MAINTAINED and intentionally NOT derived
// from the manifest. The generator skips them — rewriting would clobber edits.
//
// `integrations`: its sidebar is hand-curated to mirror the README package
// table (21 pages today, each added one-per-PR straight into its meta.json) and
// the manifest deliberately carries only a single `integrations/nestjs` entry.
// `childrenOf()` emits a flat `pages` array and cannot express Fumadocs
// `---Group---` separators, so the generator could never reproduce this layout —
// it leaves the file alone instead. Keep this paired with the note on the
// `integrations` entry in content.manifest.ts.
const HAND_MAINTAINED_SECTIONS = new Set(['integrations']);

// 2. meta.json per section (rewritten from the manifest — it is derived —
//    except hand-maintained sections, which are left untouched).
let metaWritten = 0;
for (const s of sections) {
    if (HAND_MAINTAINED_SECTIONS.has(s.path)) continue;
    const dir = s.path ? join(CONTENT, s.path) : CONTENT;
    mkdirSync(dir, { recursive: true });
    const meta = { title: s.title };
    if (s.icon) meta.icon = s.icon;
    meta.pages = childrenOf(s.path);
    writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 4)}\n`);
    metaWritten += 1;
}

// 3. Stub .mdx per page (only if absent — never clobber written content).
let created = 0;
let skipped = 0;
for (const p of pages) {
    const file = join(CONTENT, `${p.path}.mdx`);
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
        skipped += 1;
        continue;
    }
    writeFileSync(file, stub(p));
    created += 1;
}

console.log(
    `skeleton: ${metaWritten} meta.json, ${created} stub(s) created, ${skipped} existing page(s) kept`,
);
