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
});
