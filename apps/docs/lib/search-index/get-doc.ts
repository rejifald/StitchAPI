// get_doc backing logic (search_docs P3): resolve a page URL or slug to its full
// Markdown — the "read the whole thing" escape hatch.
//
// Reads the page dump scripts/build-docs-pages.ts writes at deploy
// (apps/docs/.search-index/docs-pages.json: every page's `getLLMText`, the same
// Markdown the /llms.mdx route serves), not the fumadocs `source`. Importing
// `source` here put every page's compiled MDX, twoslash hover JSX included, into
// the /api/mcp function: a 25 MB webpack chunk on top of the embedding model and
// onnxruntime, which took the function past Vercel's 250 MB uncompressed cap
// (scripts/check-function-size.mjs). The dump is the same file @stitchapi/docs-mcp
// bundles, looked up the same way (packages/docs-mcp/src/get-doc.ts).
import { appPath } from './app-path';
import { INDEX_DIR, PAGES_FILE } from './config';
import { parseDocPath } from './doc-path';

import { readFileSync } from 'node:fs';

export interface DocResult {
    title: string;
    url: string;
    markdown: string;
}

interface DumpedPage extends DocResult {
    /** parseDocPath(url) segments — the lookup key. */
    slug: string[];
}

let cached: Map<string, DumpedPage> | undefined;

function loadPages(): Map<string, DumpedPage> {
    if (!cached) {
        // Found from the working directory, not this file's URL; see app-path.ts.
        // Synchronous, so a failed read leaves `cached` unset and the next call
        // retries.
        const pages: DumpedPage[] = JSON.parse(
            readFileSync(appPath(INDEX_DIR, PAGES_FILE), 'utf8'),
        );
        cached = new Map(pages.map((page) => [page.slug.join('/'), page]));
    }
    return cached;
}

export async function getDoc(input: {
    url?: string;
    slug?: string;
}): Promise<DocResult | null> {
    const slugs = parseDocPath(input);
    if (slugs === null) return null;

    const page = loadPages().get(slugs.join('/'));
    if (!page) return null;

    return { title: page.title, url: page.url, markdown: page.markdown };
}
