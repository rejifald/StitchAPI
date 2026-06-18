#!/usr/bin/env node
// Internal-link integrity gate for the docs site.
//
// Fumadocs derives one page route from each `apps/docs/content/docs/**/*.mdx` file
// (file path → slug; an `index.mdx` collapses to its parent route). A `/docs/...` link
// whose target has no backing `.mdx` page 404s in production — the bug class that shipped
// a dead "fluent builder" link and a `/docs/guides` link to a section with no index page.
//
// This scans every `.mdx` for STATIC absolute `/docs/...` links (markdown `](…)` + a
// component `href="…"`) and fails on any whose target is not a real page route. Anchors
// (`#…`) and queries (`?…`) are stripped; external, relative (`./`, `../`), and non-`/docs`
// links are deliberately out of scope (the content has none today). The route base matches
// `docsRoute` in `apps/docs/lib/shared.ts`.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'apps/docs/content/docs');
const DOCS_ROUTE = '/docs';

function walkMdx(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walkMdx(p));
        else if (p.endsWith('.mdx')) out.push(p);
    }
    return out;
}

const files = walkMdx(DOCS);

// 1. Valid page routes — exactly what Fumadocs serves: each `.mdx` is a page; an `index.mdx`
//    is the route of its directory (the root `index.mdx` is `/docs` itself).
const routes = new Set();
for (const f of files) {
    const rel = relative(DOCS, f).replace(/\.mdx$/, '');
    const slug = rel.replace(/(^|\/)index$/, '');
    routes.add(slug ? `${DOCS_ROUTE}/${slug}` : DOCS_ROUTE);
}

// 2. Extract and validate. `/docs(?![\w-])` keeps `/docs` and `/docs/…` but rejects siblings
//    like `/docs-content`; the body runs to the closing `)`, quote, whitespace, `#`, or `?`.
const LINK = /(?:\]\(|href=["'])(\/docs(?![\w-])[^)"'\s#?]*)/g;
const broken = [];
for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(LINK)) {
        const target = m[1].replace(/\/+$/, '') || DOCS_ROUTE;
        if (!routes.has(target)) {
            broken.push({ file: relative(ROOT, f), target });
        }
    }
}

// 3. Report.
if (broken.length) {
    console.error(
        `\n✗ ${broken.length} broken internal /docs link(s) — no backing page:`,
    );
    for (const b of broken) console.error(`  ${b.file} → ${b.target}`);
    console.error(
        '\n  Every /docs/... link must resolve to an apps/docs/content/docs/**/*.mdx page' +
            '\n  (a directory route needs an index.mdx). Fix the link or add the page.\n',
    );
    process.exit(1);
}
console.log(
    `✓ docs links OK — ${routes.size} page routes, every /docs/... link across ${files.length} pages resolves.`,
);
