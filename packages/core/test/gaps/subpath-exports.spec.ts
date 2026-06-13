// Pins docs/GAP-AUDIT.md §2.5: serve / MCP / registry must be importable via subpath exports
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '../..');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function readJson(rel: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Record<
        string,
        unknown
    >;
}

function readText(rel: string): string {
    return readFileSync(join(ROOT, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// package.json subpath export assertions
// ---------------------------------------------------------------------------

describe('package.json exports map', () => {
    const pkg = readJson('package.json');
    const exports = pkg['exports'] as Record<
        string,
        {
            import?: { types?: string; default?: string };
            require?: { types?: string; default?: string };
        }
    >;

    const REQUIRED_SUBPATHS = ['./serve', './mcp', './registry'] as const;

    test.each(REQUIRED_SUBPATHS)('exports["%s"] entry exists', (subpath) => {
        expect(exports).toHaveProperty(subpath);
    });

    test.each(REQUIRED_SUBPATHS)(
        'exports["%s"].import.types points into lib/',
        (subpath) => {
            expect(exports[subpath]?.import?.types).toMatch(/^\.\/lib\//);
        },
    );

    test.each(REQUIRED_SUBPATHS)(
        'exports["%s"].import.default points into lib/',
        (subpath) => {
            expect(exports[subpath]?.import?.default).toMatch(/^\.\/lib\//);
        },
    );

    test.each(REQUIRED_SUBPATHS)(
        'exports["%s"].require.types points into lib/',
        (subpath) => {
            expect(exports[subpath]?.require?.types).toMatch(/^\.\/lib\//);
        },
    );

    test.each(REQUIRED_SUBPATHS)(
        'exports["%s"].require.default points into lib/',
        (subpath) => {
            expect(exports[subpath]?.require?.default).toMatch(/^\.\/lib\//);
        },
    );
});

// ---------------------------------------------------------------------------
// tsup.config.ts entry-point assertions
// ---------------------------------------------------------------------------

describe('tsup.config.ts entry points', () => {
    const tsupText = readText('tsup.config.ts');

    const REQUIRED_ENTRIES = [
        'src/serve.ts',
        'src/mcp.ts',
        'src/registry.ts',
    ] as const;

    test.each(REQUIRED_ENTRIES)('tsup config includes entry "%s"', (entry) => {
        // The fix agent must add these entries to the tsup config's library bundle.
        // We assert via a simple string search — tsup entry arrays are textual.
        expect(tsupText).toContain(entry);
    });
});
