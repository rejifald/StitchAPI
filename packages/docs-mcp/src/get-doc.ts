// get_doc backing logic — the local counterpart to
// apps/docs/lib/search-index/get-doc.ts. That file resolves a page through
// fumadocs' `source` (Next-only); this one looks the page up in the bundled
// data/docs-pages.json (an array of {url,slug,title,markdown} produced by
// apps/docs/scripts/build-docs-pages.ts at build:mcp-bundle time), so it needs
// no fumadocs machinery at runtime.
import { DATA_DIR, PAGES_FILE } from './config';
import { type GetDocOptions, parseDocPath } from './doc-path';

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DocResult {
    title: string;
    url: string;
    markdown: string;
}

interface BundledPage {
    url: string;
    slug: string[];
    title: string;
    markdown: string;
}

function pagesPath(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', DATA_DIR, PAGES_FILE);
}

let cached: Map<string, BundledPage> | undefined;

function loadPages(): Map<string, BundledPage> {
    if (!cached) {
        let raw: string;
        try {
            raw = readFileSync(pagesPath(), 'utf8');
        } catch (e) {
            throw new Error(
                `docs-mcp: bundled pages not found at ${pagesPath()}. ` +
                    `This package ships prebuilt at data/${PAGES_FILE} — a corrupt ` +
                    `install, not something to build locally. Reinstall @stitchapi/docs-mcp.`,
                { cause: e },
            );
        }
        // JSON.parse inside the same try/catch as the read, so a truncated or
        // corrupt bundle gets the same friendly message as a missing file —
        // this is synchronous, so `cached` stays unset on failure and a later
        // call retries naturally (unlike search.ts's async restore() cache).
        let pages: BundledPage[];
        try {
            pages = JSON.parse(raw);
        } catch (e) {
            throw new Error(
                `docs-mcp: bundled pages at ${pagesPath()} are corrupt or unreadable. ` +
                    `Reinstall @stitchapi/docs-mcp.`,
                { cause: e },
            );
        }
        cached = new Map(pages.map((p) => [p.slug.join('/'), p]));
    }
    return cached;
}

export function getDoc(input: GetDocOptions): DocResult | null {
    const slug = parseDocPath(input);
    if (slug === null) return null;

    const page = loadPages().get(slug.join('/'));
    if (!page) return null;

    return { title: page.title, url: page.url, markdown: page.markdown };
}
