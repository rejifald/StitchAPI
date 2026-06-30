// Unit coverage for the search_docs P2 result mapping: hybrid hits → fumadocs
// SortedResult[]. Pure (no model, no index), so it runs in the normal vitest job.
import {
    type DocSearchHit,
    toSortedResults,
} from '../lib/search-index/sorted-result';

import { describe, expect, it } from 'vitest';

function hit(overrides: Partial<DocSearchHit>): DocSearchHit {
    return {
        pageUrl: '/docs/x',
        pageTitle: 'X',
        heading: 'X',
        anchor: '',
        text: 'body',
        score: 1,
        ...overrides,
    };
}

describe('toSortedResults', () => {
    it('emits one page entry per page, before its sections', () => {
        const out = toSortedResults([
            hit({
                pageUrl: '/docs/a',
                pageTitle: 'A',
                heading: 'First',
                anchor: 'first',
            }),
            hit({
                pageUrl: '/docs/a',
                pageTitle: 'A',
                heading: 'Second',
                anchor: 'second',
            }),
        ]);
        expect(out.filter((r) => r.type === 'page')).toHaveLength(1);
        expect(out[0]).toMatchObject({
            type: 'page',
            url: '/docs/a',
            content: 'A',
        });
        expect(out[1]).toMatchObject({
            type: 'heading',
            url: '/docs/a#first',
            content: 'First',
        });
    });

    it('links a section hit to its anchor', () => {
        const [, section] = toSortedResults([
            hit({
                pageUrl: '/docs/guides/throttle',
                pageTitle: 'Throttle',
                heading: 'Options',
                anchor: 'options',
            }),
        ]);
        expect(section).toMatchObject({
            type: 'heading',
            url: '/docs/guides/throttle#options',
            content: 'Options',
        });
    });

    it('renders an intro chunk (no anchor) as a text excerpt at the page url', () => {
        const [, intro] = toSortedResults([
            hit({
                pageUrl: '/docs/p',
                pageTitle: 'P',
                heading: 'P',
                anchor: '',
                text: 'Intro paragraph that orients the reader.',
            }),
        ]);
        expect(intro.type).toBe('text');
        expect(intro.url).toBe('/docs/p');
        expect(intro.content).toContain('Intro paragraph');
    });

    it('gives every result a unique id', () => {
        const out = toSortedResults([
            hit({ pageUrl: '/docs/a', anchor: 'x', heading: 'X' }),
            hit({ pageUrl: '/docs/a', anchor: 'y', heading: 'Y' }),
            hit({ pageUrl: '/docs/b', anchor: 'z', heading: 'Z' }),
        ]);
        expect(new Set(out.map((r) => r.id)).size).toBe(out.length);
    });
});
