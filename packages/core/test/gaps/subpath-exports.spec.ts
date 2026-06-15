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

// ---------------------------------------------------------------------------
// ADR 0005 Decision 10 — every non-http surface + the xhr adapter is a subpath
// export, built by tsup, so `import { stitch }` bundles http alone while each
// surface is reached only when used.
// ---------------------------------------------------------------------------

describe('surface + adapter subpath exports (ADR 0005 Decision 10)', () => {
    const exports = readJson('package.json')['exports'] as Record<
        string,
        {
            import?: { types?: string; default?: string };
            require?: { types?: string; default?: string };
        }
    >;
    const tsupText = readText('tsup.config.ts');

    // subpath → its `src` entry (the `xhr` subpath maps to `xhr-adapter`, not its own name)
    const SURFACES = [
        ['./graphql', 'src/graphql.ts'],
        ['./sse', 'src/sse.ts'],
        ['./stream', 'src/stream.ts'],
        ['./download', 'src/download.ts'],
        ['./xhr', 'src/xhr-adapter.ts'],
    ] as const;

    test.each(SURFACES)(
        'exports["%s"] maps to its lib/ artifact and tsup builds the entry',
        (subpath, entry) => {
            const base = entry.replace(/^src\//, '').replace(/\.ts$/, '');
            const e = exports[subpath];
            expect(e?.import?.types).toBe(`./lib/${base}.d.mts`);
            expect(e?.import?.default).toBe(`./lib/${base}.mjs`);
            expect(e?.require?.types).toBe(`./lib/${base}.d.ts`);
            expect(e?.require?.default).toBe(`./lib/${base}.js`);
            expect(tsupText).toContain(entry);
        },
    );
});
