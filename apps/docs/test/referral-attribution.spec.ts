// Unit coverage for the `?utm_source=` → `/utm/<source>` rewrite that gives
// npm-originated traffic a countable row on the Hobby plan. Pure — no analytics
// script — so it runs in the normal vitest job.
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
                    'https://stitchapi.dev/docs/agents?utm_source=npm',
                ),
            ),
        ).toBe('/utm/npm/docs/agents');
    });

    it('keeps the root row unsuffixed rather than emitting `/utm/npm/`', () => {
        expect(
            path(foldReferralSource('https://stitchapi.dev/?utm_source=npm')),
        ).toBe('/utm/npm');
    });

    // Regression: `…/#playground?utm_source=github` puts the query INSIDE the
    // fragment, so the param never parses and the referral is silently lost. The
    // README must spell it `/?utm_source=github#playground` — this pins that the
    // fragment survives the rewrite.
    it('preserves a fragment when the query precedes it', () => {
        expect(
            path(
                foldReferralSource(
                    'https://stitchapi.dev/?utm_source=github#playground',
                ),
            ),
        ).toBe('/utm/github#playground');
    });

    it('leaves an untagged url untouched', () => {
        const url = 'https://stitchapi.dev/docs/agents';
        expect(foldReferralSource(url)).toBe(url);
    });

    // Cardinality guard: an unknown value is stripped, never folded, so a crawler or a
    // spammed `?utm_source=` cannot mint unbounded rows in the Pages panel.
    it('strips an unknown source without folding it', () => {
        expect(
            path(
                foldReferralSource(
                    'https://stitchapi.dev/docs/agents?utm_source=evil',
                ),
            ),
        ).toBe('/docs/agents');
    });

    // The old private spelling must NOT be honoured — if a stale link survives
    // somewhere, it should record the real page rather than a phantom source row.
    it('ignores the pre-canonical `from` param', () => {
        const url = 'https://stitchapi.dev/docs/agents?from=npm';
        expect(foldReferralSource(url)).toBe(url);
    });

    it('preserves unrelated query params, including sibling utm tags', () => {
        expect(
            path(
                foldReferralSource(
                    'https://stitchapi.dev/docs/agents?utm_source=npm&utm_campaign=ga',
                ),
            ),
        ).toBe('/utm/npm/docs/agents?utm_campaign=ga');
    });

    it('records a malformed url as-is rather than dropping the pageview', () => {
        expect(foldReferralSource('not-a-url?utm_source=npm')).toBe(
            'not-a-url?utm_source=npm',
        );
    });
});
