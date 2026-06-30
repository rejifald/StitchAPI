// Split a page's *processed* markdown into self-contained, citeable section
// chunks. The input is `page.data.getText('processed')` — the exact text that
// feeds llms.txt — so the index can never drift from the docs.
//
// One chunk per H2/H3 section, plus a "top of page" chunk for any intro text
// before the first heading. H4+ subheadings stay inside their parent section.
// `#` inside fenced code blocks is never mistaken for a heading.

import { Slugger } from './slugger';

export interface PageInput {
    /** Canonical page route, e.g. `/docs/guides/resilience/throttle`. */
    url: string;
    /** Page title (frontmatter) — also the heading of the intro chunk. */
    title: string;
    /** `page.data.getText('processed')`. */
    processed: string;
}

export interface DocChunk {
    pageUrl: string;
    pageTitle: string;
    /** Section heading text (the page title for the intro chunk). */
    heading: string;
    /** github-slug of the heading (`''` for the intro / top of page). */
    anchor: string;
    /** Section body markdown, heading line excluded. */
    text: string;
}

// A fenced code block opener/closer: three or more backticks or tildes,
// possibly indented. We only need the fence run to match opener with closer.
const FENCE = /^\s*(`{3,}|~{3,})/;
// An ATX heading: `## Heading`, tolerating trailing `#`s.
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
// An explicit heading id: `## Title [#custom-id]` (fumadocs/remark syntax).
const HEADING_ID = /\s*\[#([^\]]+)\]\s*$/;

/** The text we actually embed: page + heading breadcrumb prepended for context. */
export function embeddingInput(chunk: DocChunk): string {
    return chunk.heading === chunk.pageTitle
        ? `${chunk.pageTitle}\n\n${chunk.text}`
        : `${chunk.pageTitle} — ${chunk.heading}\n\n${chunk.text}`;
}

export function chunkPage(page: PageInput): DocChunk[] {
    const slugger = new Slugger();
    const chunks: DocChunk[] = [];

    let heading = page.title;
    let anchor = '';
    let body: string[] = [];
    let fence: string | null = null;

    const flush = () => {
        const text = body.join('\n').trim();
        body = [];
        if (!text) return;
        chunks.push({
            pageUrl: page.url,
            pageTitle: page.title,
            heading,
            anchor,
            text,
        });
    };

    for (const line of page.processed.split('\n')) {
        const fenceMatch = line.match(FENCE);
        if (fenceMatch) {
            if (fence && line.trimStart().startsWith(fence)) fence = null;
            else if (!fence) fence = fenceMatch[1];
            body.push(line);
            continue;
        }

        const headingMatch = fence ? null : line.match(HEADING);
        if (
            headingMatch &&
            (headingMatch[1].length === 2 || headingMatch[1].length === 3)
        ) {
            flush();
            // A heading may carry an explicit id (`## Title [#custom-id]`). When
            // present that id IS the rendered anchor and the bracket is not part
            // of the visible title; otherwise slug the text github-style.
            let text = headingMatch[2].trim();
            const explicit = text.match(HEADING_ID);
            if (explicit) text = text.slice(0, explicit.index).trim();
            heading = text;
            anchor = explicit ? explicit[1].trim() : slugger.slug(text);
            continue; // heading line is metadata, not body
        }

        body.push(line);
    }
    flush();

    return chunks;
}
