// Unit coverage for appPath (lib/search-index/app-path.ts, #829), which finds the
// search index and the vendored embedding model at runtime. It resolves from the
// working directory rather than from import.meta.url (webpack pins that to the
// build machine), and a deployed function's cwd may be apps/docs or the
// repository root. These pin both layouts, the order between them, and what a
// production miss prints, so a refactor cannot quietly go back to a path that only
// exists on the machine that built the app.
import { appPath } from '../lib/search-index/app-path';
import { INDEX_DIR, INDEX_FILE } from '../lib/search-index/config';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const scratch: string[] = [];

// A throwaway directory holding the given files (paths relative to it).
function layout(files: string[]): string {
    const root = mkdtempSync(join(tmpdir(), 'app-path-'));
    scratch.push(root);
    for (const file of files) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), '{}');
    }
    return root;
}

function runFrom(cwd: string): void {
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);
}

afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of scratch.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const index = join(INDEX_DIR, INDEX_FILE);
const nested = join('apps', 'docs', index);

describe('appPath', () => {
    it('finds the file under the working directory when that is apps/docs', () => {
        const root = layout([index]);
        runFrom(root);

        expect(appPath(INDEX_DIR, INDEX_FILE)).toBe(join(root, index));
    });

    it('falls back to apps/docs when the working directory is the repository root', () => {
        const root = layout([nested]);
        runFrom(root);

        expect(appPath(INDEX_DIR, INDEX_FILE)).toBe(join(root, nested));
    });

    it('prefers the working directory when both layouts hold the file', () => {
        const root = layout([index, nested]);
        runFrom(root);

        expect(appPath(INDEX_DIR, INDEX_FILE)).toBe(join(root, index));
    });

    it('throws, naming both candidates, when neither holds the file', () => {
        const root = layout([]);
        runFrom(root);

        const lookup = () => appPath(INDEX_DIR, INDEX_FILE);
        expect(lookup).toThrow(join(root, index));
        expect(lookup).toThrow(join(root, nested));
    });
});
