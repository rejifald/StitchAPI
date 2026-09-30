// Smoke test for the public library entry (README.md documents createServer()
// as a supported embedding API). A dropped re-export passes `tsc --noEmit`
// silently (only a renamed export is caught by typecheck), so this pins the
// barrel actually re-exporting everything it claims to.
import * as docsMcp from '../src/index';

import { describe, expect, it } from 'vitest';

describe('package public API (src/index.ts barrel)', () => {
    it('re-exports createServer, getDoc, and searchDocs', () => {
        expect(typeof docsMcp.createServer).toBe('function');
        expect(typeof docsMcp.getDoc).toBe('function');
        expect(typeof docsMcp.searchDocs).toBe('function');
    });

    it('re-exports the named option interfaces (CONTRACT P14)', () => {
        // Types are erased at runtime, so pin them at the type level: if the
        // barrel drops any of these re-exports, this block stops compiling.
        const getDocOptions: docsMcp.GetDocOptions = {
            url: '/docs/guides/resilience/throttle',
            slug: 'guides/resilience/throttle',
        };
        const hybridWeights: docsMcp.HybridWeights = { text: 0.2, vector: 0.8 };
        const boost: docsMcp.FieldBoost = { pageTitle: 3, heading: 2 };
        const searchOptions: docsMcp.SearchOptions = {
            limit: 8,
            hybridWeights,
            boost,
        };
        const hit: docsMcp.DocSearchHit = {
            path: '/docs/guides/x',
            title: 'X Guide',
            heading: 'Retries',
            anchor: 'retries',
            text: 'body text',
            score: 1,
        };
        const doc: docsMcp.DocResult = {
            title: 'X Guide',
            url: '/docs/guides/x',
            markdown: '# X Guide',
        };

        expect({ getDocOptions, searchOptions, hit, doc }).toBeTruthy();
    });
});
