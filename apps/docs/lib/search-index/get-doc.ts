// get_doc backing logic (search_docs P3): resolve a page URL or slug to its full
// Markdown — the "read the whole thing" escape hatch that wraps the same
// getLLMText the /llms.mdx route serves. Pages are looked up from the fumadocs
// source, so this is server-only.

import { getLLMText, source } from '../source';
import { parseDocPath } from './doc-path';

export interface DocResult {
    title: string;
    url: string;
    markdown: string;
}

export async function getDoc(input: {
    url?: string;
    slug?: string;
}): Promise<DocResult | null> {
    const slugs = parseDocPath(input);
    if (slugs === null) return null;

    const page = source.getPage(slugs);
    if (!page) return null;

    return {
        title: page.data.title,
        url: page.url,
        markdown: await getLLMText(page),
    };
}
