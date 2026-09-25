// The studio band's data contract (docs/design/studio-band/anatomy.md §5):
// a missing or malformed `studio-band.<lang>.json` must fail the build rather
// than ship a broken band. `studio-band-data.ts` enforces that by parsing the
// committed file through this schema at MODULE SCOPE — importing it here
// already proves the real file is valid (a malformed one would throw before
// any test below runs); these cases pin the schema's own rejection behaviour
// independently of that file's current contents.
import {
    getStudioBandData,
    studioBandDataSchema,
} from '../app/(home)/components/studio-band-data';

import { describe, expect, it } from 'vitest';

const valid = {
    version: 1,
    project: 'stitchapi',
    lang: 'en',
    title: 'Other projects by the studio',
    studio: {
        name: 'Oleks Crane',
        href: 'https://olekscrane.com/work/stitchapi',
    },
    all: { label: 'All projects', href: 'https://olekscrane.com/work' },
    related: [
        {
            name: 'Yakir',
            tagline: 'Pin your docs to the truth so they can’t drift.',
            href: 'https://olekscrane.com/work/yakir',
        },
    ],
    ask: {
        heading: 'Have something to build?',
        body: 'Tell me what you’re working on.',
        label: 'Discuss a project',
        href: 'https://olekscrane.com/contact',
    },
};

describe('studio-band.en.json (the committed file)', () => {
    it('parses into the exact content the band renders', () => {
        const data = getStudioBandData('en');
        expect(data.title).toBe('Other projects by the studio');
        expect(data.studio).toEqual({
            name: 'Oleks Crane',
            href: 'https://olekscrane.com/work/stitchapi',
        });
        expect(data.all).toEqual({
            label: 'All projects',
            href: 'https://olekscrane.com/work',
        });
        expect(data.related.map((r) => r.name)).toEqual([
            'Yakir',
            'Langtell',
            'Pervigil',
        ]);
        expect(data.ask?.label).toBe('Discuss a project');
    });
});

describe('studioBandDataSchema', () => {
    it('accepts a well-formed file, including ask: null (no-ask hosts)', () => {
        expect(studioBandDataSchema.safeParse(valid).success).toBe(true);
        expect(
            studioBandDataSchema.safeParse({ ...valid, ask: null, related: [] })
                .success,
        ).toBe(true);
    });

    it('rejects a version other than the literal 1', () => {
        const result = studioBandDataSchema.safeParse({ ...valid, version: 2 });
        expect(result.success).toBe(false);
    });

    it('rejects a lang outside "en" | "uk"', () => {
        const result = studioBandDataSchema.safeParse({
            ...valid,
            lang: 'fr',
        });
        expect(result.success).toBe(false);
    });

    it('rejects a studio name other than "Oleks Crane"', () => {
        const result = studioBandDataSchema.safeParse({
            ...valid,
            studio: { ...valid.studio, name: 'Someone Else' },
        });
        expect(result.success).toBe(false);
    });

    it('rejects an href that is not a URL', () => {
        const result = studioBandDataSchema.safeParse({
            ...valid,
            all: { ...valid.all, href: '/work' },
        });
        expect(result.success).toBe(false);
    });

    it('rejects more than three related projects', () => {
        const fourth = valid.related[0];
        const result = studioBandDataSchema.safeParse({
            ...valid,
            related: [fourth, fourth, fourth, fourth],
        });
        expect(result.success).toBe(false);
    });

    it('rejects a related item missing its tagline', () => {
        const { tagline: _tagline, ...withoutTagline } = valid.related[0];
        const result = studioBandDataSchema.safeParse({
            ...valid,
            related: [withoutTagline],
        });
        expect(result.success).toBe(false);
    });

    it('rejects a missing title', () => {
        const { title: _title, ...withoutTitle } = valid;
        const result = studioBandDataSchema.safeParse(withoutTitle);
        expect(result.success).toBe(false);
    });
});
