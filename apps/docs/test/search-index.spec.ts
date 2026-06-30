// Unit coverage for the search_docs P1 chunk pipeline: deterministic chunking
// and github-slugger-compatible anchors. Pure functions only — no model load,
// no network — so this runs in the normal `vitest run` test job. (Embedding
// determinism is asserted by the index build itself; see scripts/build-search-index.ts.)
import { chunkPage, embeddingInput } from '../lib/search-index/chunk';
import { Slugger, slugSegment } from '../lib/search-index/slugger';

import { describe, expect, it } from 'vitest';

const SAMPLE = [
    'Intro paragraph that orients the reader.',
    '',
    'More intro.',
    '',
    '## First Section',
    '',
    'Body of first section.',
    '',
    '### A Sub-Heading',
    '',
    'Sub body.',
    '',
    '## Second Section',
    '',
    '```ts',
    '// ## not a heading inside a fence',
    'const x = 1;',
    '```',
    '',
    'After the fence.',
    '',
    '## Second Section',
    '',
    'Duplicate heading body.',
    '',
].join('\n');

describe('chunkPage', () => {
    const chunks = chunkPage({
        url: '/docs/example',
        title: 'Example Page',
        processed: SAMPLE,
    });

    it('captures intro text before the first heading as a top-of-page chunk', () => {
        expect(chunks[0]).toMatchObject({
            pageUrl: '/docs/example',
            pageTitle: 'Example Page',
            heading: 'Example Page',
            anchor: '',
        });
        expect(chunks[0].text).toContain('Intro paragraph');
        expect(chunks[0].text).toContain('More intro.');
    });

    it('emits one chunk per H2/H3 in document order', () => {
        expect(chunks.map((c) => c.heading)).toEqual([
            'Example Page',
            'First Section',
            'A Sub-Heading',
            'Second Section',
            'Second Section',
        ]);
    });

    it('never mistakes `#` inside a fenced code block for a heading', () => {
        const fenced = chunks.find(
            (c) =>
                c.anchor === 'second-section' && c.heading === 'Second Section',
        );
        expect(fenced?.text).toContain('## not a heading inside a fence');
        expect(
            chunks.some((c) => c.heading === 'not a heading inside a fence'),
        ).toBe(false);
    });

    it('de-dupes repeated heading anchors like github-slugger', () => {
        const seconds = chunks.filter((c) => c.heading === 'Second Section');
        expect(seconds.map((c) => c.anchor)).toEqual([
            'second-section',
            'second-section-1',
        ]);
    });

    it('excludes the heading line from the section body', () => {
        const first = chunks[1];
        expect(first.text).toBe('Body of first section.');
    });

    it('prepends a breadcrumb to the embedding input', () => {
        expect(embeddingInput(chunks[1])).toBe(
            'Example Page — First Section\n\nBody of first section.',
        );
        // intro chunk: heading === title, so no duplicated breadcrumb
        expect(embeddingInput(chunks[0]).startsWith('Example Page\n\n')).toBe(
            true,
        );
    });

    it('honors explicit heading ids and strips them from the title', () => {
        const [section] = chunkPage({
            url: '/docs/agents',
            title: 'Agents',
            processed:
                '## Adopt in your project [#adopt-in-your-project]\n\nBody text.',
        });
        expect(section.heading).toBe('Adopt in your project');
        expect(section.anchor).toBe('adopt-in-your-project');
        expect(section.text).toBe('Body text.');
    });
});

describe('slugger', () => {
    it('lowercases, strips punctuation, and hyphenates whitespace', () => {
        expect(slugSegment('Hello, World!')).toBe('hello-world');
    });

    it('strips Unicode punctuation (em dash) the way the rendered page does', () => {
        expect(slugSegment('Setup — advanced')).toBe('setup--advanced');
    });

    it('suffixes repeats within a page', () => {
        const slugger = new Slugger();
        expect(slugger.slug('Setup')).toBe('setup');
        expect(slugger.slug('Setup')).toBe('setup-1');
        expect(slugger.slug('Setup')).toBe('setup-2');
    });
});
