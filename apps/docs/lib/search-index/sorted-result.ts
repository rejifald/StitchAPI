// Map hybrid-search hits to fumadocs' SortedResult[] — the shape the docs
// search dialog (the `fetch` client) renders. Pure (no model/Orama imports) so
// it's cheap to unit-test. One `page` entry per matched page, then a
// `heading`/`text` entry per matched section so each result links to its anchor.

/** A single section hit from the hybrid search engine. */
export interface DocSearchHit {
    pageUrl: string;
    pageTitle: string;
    /** Section heading (equals pageTitle for a page's intro chunk). */
    heading: string;
    /** github-slug anchor (`''` for the intro / top of page). */
    anchor: string;
    text: string;
    score: number;
}

/** fumadocs-core `SortedResult` (see fumadocs-core/search). */
export interface SortedResult {
    id: string;
    url: string;
    type: 'page' | 'heading' | 'text';
    content: string;
}

const EXCERPT_LEN = 160;

function excerpt(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > EXCERPT_LEN ? `${flat.slice(0, EXCERPT_LEN)}…` : flat;
}

export function toSortedResults(hits: DocSearchHit[]): SortedResult[] {
    const out: SortedResult[] = [];
    const seenPages = new Set<string>();

    hits.forEach((hit, i) => {
        if (!seenPages.has(hit.pageUrl)) {
            seenPages.add(hit.pageUrl);
            out.push({
                id: `page:${hit.pageUrl}`,
                url: hit.pageUrl,
                type: 'page',
                content: hit.pageTitle,
            });
        }

        const isIntro = hit.anchor === '';
        out.push({
            id: `hit:${i}:${hit.pageUrl}#${hit.anchor}`,
            url: isIntro ? hit.pageUrl : `${hit.pageUrl}#${hit.anchor}`,
            type: isIntro ? 'text' : 'heading',
            content: isIntro ? excerpt(hit.text) : hit.heading,
        });
    });

    return out;
}
