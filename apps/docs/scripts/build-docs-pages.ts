// Build-time full-page Markdown dump for the get_doc tool, both the LOCAL docs
// MCP (@stitchapi/docs-mcp) and the hosted one (lib/search-index/get-doc.ts,
// which reads it at runtime; scripts/prebuild-search-index.mjs writes it at
// deploy). Separate from build-search-index.ts on purpose: that file backs the
// CI-gated (`check:search-relevance`) search ranking, and this one must never
// touch that pipeline or its outputs.
//
// Iterates the SAME pages as build-search-index.ts (`source.getPages()`) and
// renders each with `getLLMText`, the function the /llms.mdx route serves, so
// the local and hosted servers return byte-for-byte the same Markdown. Written next to the
// search index (apps/docs/.search-index/docs-pages.json) so a single build step
// (build:mcp-bundle) produces both artifacts scripts/copy-bundle.mjs then copies
// into packages/docs-mcp/data/.
//
// Run from apps/docs:  pnpm run build:docs-pages
// (fumadocs-mdx must have run first, same precondition as build:search-index.)
import { parseDocPath } from '../lib/search-index/doc-path';
import { getLLMText, source } from '../lib/source';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(appRoot, '.search-index');
const outFile = join(outDir, 'docs-pages.json');

export interface DocsPage {
    url: string;
    /** parseDocPath(page.url) segments — the get_doc lookup key. */
    slug: string[];
    title: string;
    markdown: string;
}

export async function main(): Promise<void> {
    const pages = source.getPages();
    const out: DocsPage[] = [];

    for (const page of pages) {
        const slug = parseDocPath({ url: page.url });
        if (slug === null) {
            throw new Error(
                `[docs-pages] page.url "${page.url}" did not normalize to a slug`,
            );
        }
        out.push({
            url: page.url,
            slug,
            title: page.data.title,
            markdown: await getLLMText(page),
        });
    }

    if (out.length === 0) {
        throw new Error(
            '[docs-pages] no pages produced — run `fumadocs-mdx` first so .source exists',
        );
    }

    mkdirSync(outDir, { recursive: true });
    writeFileSync(outFile, `${JSON.stringify(out)}\n`);
    console.log(
        `[docs-pages] wrote ${join('.search-index', 'docs-pages.json')} (${out.length} pages)`,
    );
}
