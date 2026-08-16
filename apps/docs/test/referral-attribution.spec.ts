// Unit coverage for the `?from=` → `/from/<source>` rewrite that gives npm-originated
// traffic a countable row on the Hobby plan. Pure — no analytics script — so it runs in
// the normal vitest job.
import { foldReferralSource } from '../lib/referral-attribution';

import { describe, expect, it } from 'vitest';

const path = (url: string) => {
    const u = new URL(url);
    return u.pathname + u.search + u.hash;
};

describe('foldReferralSource', () => {
    it('folds a known source into the path, keeping the destination legible', () => {
        expect(
            path(
                foldReferralSource(
                    'https://stitchapi.dev/docs/agents?from=npm',
                ),
            ),
        ).toBe('/from/npm/docs/agents');
    });

    it('keeps the root row unsuffixed rather than emitting `/from/npm/`', () => {
        expect(
            path(foldReferralSource('https://stitchapi.dev/?from=npm')),
        ).toBe('/from/npm');
    });

    // Regression: `…/#playground?from=gh` puts the query INSIDE the fragment, so the
    // param never parses and the referral is silently lost. The README must spell it
    // `/?from=gh#playground` — this pins that the fragment survives the rewrite.
    it('preserves a fragment when the query precedes it', () => {
        expect(
            path(
                foldReferralSource('https://stitchapi.dev/?from=gh#playground'),
            ),
        ).toBe('/from/gh#playground');
    });

    it('leaves an untagged url untouched', () => {
        const url = 'https://stitchapi.dev/docs/agents';
        expect(foldReferralSource(url)).toBe(url);
    });

    // Cardinality guard: an unknown value is stripped, never folded, so a crawler or a
    // spammed `?from=` cannot mint unbounded rows in the Pages panel.
    it('strips an unknown source without folding it', () => {
        expect(
            path(
                foldReferralSource(
                    'https://stitchapi.dev/docs/agents?from=evil',
                ),
            ),
        ).toBe('/docs/agents');
    });

    it('preserves unrelated query params', () => {
        expect(
            path(
                foldReferralSource(
                    'https://stitchapi.dev/docs/agents?from=npm&q=1',
                ),
            ),
        ).toBe('/from/npm/docs/agents?q=1');
    });

    it('records a malformed url as-is rather than dropping the pageview', () => {
        expect(foldReferralSource('not-a-url?from=npm')).toBe(
            'not-a-url?from=npm',
        );
    });
});
