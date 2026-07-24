// Unit tests for the shared `acceptsStatus` matcher (src/resilience.ts) — the CONTRACT.md P7
// normalizer every status-classification slot runs through (`retry.on`, `throttle.on`,
// `acceptStatus`, the auth strategies' `refreshOn`). It collapses the four `StatusMatch` spellings
// (a bare number, a number list, a predicate, or unset) into one `(status) => boolean` predicate,
// so `on: 429` ≡ `on: [429]` at every reader.
import type { StatusMatch } from '../src';
import { acceptsStatus } from '../src/resilience';

describe('acceptsStatus (StatusMatch normalizer)', () => {
    test('a bare number matches exactly that status', () => {
        const match = acceptsStatus(429);
        expect(match(429)).toBe(true);
        expect(match(430)).toBe(false);
        expect(match(200)).toBe(false);
    });

    test('a bare number is equivalent to its one-element list', () => {
        const bare = acceptsStatus(404);
        const list = acceptsStatus([404]);
        for (const status of [200, 404, 429, 503]) {
            expect(bare(status)).toBe(list(status));
        }
    });

    test('a number list matches membership', () => {
        const match = acceptsStatus([429, 502, 503, 504]);
        expect(match(503)).toBe(true);
        expect(match(500)).toBe(false);
    });

    test('a predicate is used as-is', () => {
        const match = acceptsStatus((s) => s >= 500);
        expect(match(500)).toBe(true);
        expect(match(499)).toBe(false);
    });

    test('unset accepts nothing (every status falls through)', () => {
        const match = acceptsStatus(undefined);
        expect(match(429)).toBe(false);
        expect(match(200)).toBe(false);
    });

    test('the four spellings type-check as one StatusMatch union', () => {
        const spellings: StatusMatch[] = [429, [429], (s) => s === 429];
        for (const spelling of spellings) {
            expect(acceptsStatus(spelling)(429)).toBe(true);
        }
    });
});
