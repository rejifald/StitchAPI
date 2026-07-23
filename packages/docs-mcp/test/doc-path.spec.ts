// Ported from apps/docs/test/doc-path.spec.ts — src/doc-path.ts is a verbatim
// copy of that file's logic (see its header comment), so the coverage should
// stay identical. Pure — no bundled data/ needed.
import { parseDocPath } from '../src/doc-path';

import { describe, expect, it } from 'vitest';

describe('parseDocPath', () => {
    it('parses an absolute search_docs url with an anchor', () => {
        expect(
            parseDocPath({
                url: 'https://stitchapi.dev/docs/guides/resilience/throttle#options',
            }),
        ).toEqual(['guides', 'resilience', 'throttle']);
    });

    it('parses a root-relative /docs path', () => {
        expect(parseDocPath({ url: '/docs/guides/auth/bearer' })).toEqual([
            'guides',
            'auth',
            'bearer',
        ]);
    });

    it('parses a bare slug', () => {
        expect(parseDocPath({ slug: 'guides/data/pagination' })).toEqual([
            'guides',
            'data',
            'pagination',
        ]);
    });

    it('strips query and anchor', () => {
        expect(
            parseDocPath({ url: '/docs/concepts/the-stitch?x=1#why' }),
        ).toEqual(['concepts', 'the-stitch']);
    });

    it('prefers slug over url', () => {
        expect(
            parseDocPath({
                slug: 'errors/stitch-drift',
                url: 'https://stitchapi.dev/docs/other',
            }),
        ).toEqual(['errors', 'stitch-drift']);
    });

    it('maps the docs root to []', () => {
        expect(parseDocPath({ url: '/docs' })).toEqual([]);
        expect(parseDocPath({ url: 'https://stitchapi.dev/docs' })).toEqual([]);
    });

    it('returns null for empty input', () => {
        expect(parseDocPath({})).toBeNull();
        expect(parseDocPath({ url: '   ' })).toBeNull();
    });
});
