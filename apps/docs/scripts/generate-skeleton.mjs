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
// Sections in HAND_MAINTAINED_SECTIONS are skipped entirely — their meta.json
// and page set are curated by hand (e.g. integrations), so they keep their
// sidebar slot via `sections` but their meta.json is never regenerated here.
//
// `meta.json` is governed by Prettier (it is NOT in .prettierignore), so the
// serializer below matches Prettier's output exactly: objects always break, and
// the `pages` array stays inline when the line fits in 80 columns and breaks one
// item per line otherwise. Keeping codegen Prettier-stable means `gen:docs` is a
// no-op on a synced tree — re-running produces no diff (enforced in CI).
//
// The meta-building helpers (childrenOf / metaForSection / serializeMeta) are
// exported and pure; importing this module runs no side effects. The file-system
// work happens in main(), which runs only when the file is executed directly.
//
// Run: node scripts/generate-skeleton.mjs   (from apps/docs)
import {
    HAND_MAINTAINED_SECTIONS,
    pages,
    sections,
} from '../content.manifest.ts';

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

const PRINT_WIDTH = 80;

const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p) => (p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p);

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
    const fm = `---\ntitle: ${JSON.stringify(p.title)}\ndescription: ${JSON.stringify(p.description)}\n---`;
    return `${fm}\n\n${stubBody(p.kind)}`;
}

// Ordered immediate children of a folder (subfolders first, then leaf pages),
// excluding the folder's own index — that is the folder's landing page.
export function childrenOf(folderPath) {
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

// The meta.json object for a section: title, then the optional description and
// icon, then the ordered children. Key order is the committed file order.
export function metaForSection(section) {
    const meta = { title: section.title };
    if (section.description) meta.description = section.description;
    if (section.icon) meta.icon = section.icon;
    meta.pages = childrenOf(section.path);
    return meta;
}

// Serialize a meta object the way Prettier would (4-space JSON; the `pages`
// array inline if it fits in PRINT_WIDTH, else one item per line). `pages` is
// always the last key, so its inline form carries no trailing comma.
export function serializeMeta(meta) {
    const entries = Object.entries(meta);
    const lines = ['{'];
    entries.forEach(([key, value], i) => {
        const tail = i < entries.length - 1 ? ',' : '';
        const k = JSON.stringify(key);
        if (Array.isArray(value)) {
            const inline = `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
            const oneLine = `    ${k}: ${inline}${tail}`;
            if (oneLine.length <= PRINT_WIDTH) {
                lines.push(oneLine);
            } else {
                lines.push(`    ${k}: [`);
                value.forEach((v, j) => {
                    const c = j < value.length - 1 ? ',' : '';
                    lines.push(`        ${JSON.stringify(v)}${c}`);
                });
                lines.push(`    ]${tail}`);
            }
        } else {
            lines.push(`    ${k}: ${JSON.stringify(value)}${tail}`);
        }
    });
    lines.push('}');
    return `${lines.join('\n')}\n`;
}

function main() {
    // 1. Drop scaffold cruft so the manifest's `index` can take over the home.
    const stockIndex = join(CONTENT, 'index.mdx');
    if (
        existsSync(stockIndex) &&
        /Hello World|start writing/.test(readFileSync(stockIndex, 'utf8'))
    ) {
        rmSync(stockIndex);
    }
    const stockTest = join(CONTENT, 'test.mdx');
    if (existsSync(stockTest)) rmSync(stockTest);

    // 2. meta.json per section (always rewritten — it is derived from the
    // manifest), except hand-maintained sections, which own their own file.
    let metas = 0;
    for (const s of sections) {
        if (HAND_MAINTAINED_SECTIONS.has(s.path)) continue;
        const dir = s.path ? join(CONTENT, s.path) : CONTENT;
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'meta.json'), serializeMeta(metaForSection(s)));
        metas += 1;
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
        `skeleton: ${metas} meta.json, ${created} stub(s) created, ${skipped} existing page(s) kept`,
    );
}

// Run the file-system work only when executed directly, not when imported.
if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    main();
}
