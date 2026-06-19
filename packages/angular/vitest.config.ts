import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Alias the workspace packages to their SOURCE (more specific subpaths first), so
// tests run without `stitchapi` / `@stitchapi/query-core` being built. Mirrors
// tsconfig `paths`.
const core = (p: string): string =>
    fileURLToPath(new URL(`../core/src/${p}`, import.meta.url));
const queryCore = (): string =>
    fileURLToPath(new URL('../query-core/src/index.ts', import.meta.url));

export default defineConfig({
    resolve: {
        alias: [
            { find: /^stitchapi\/testing$/, replacement: core('testing.ts') },
            { find: /^stitchapi$/, replacement: core('index.ts') },
            { find: /^@stitchapi\/query-core$/, replacement: queryCore() },
        ],
    },
    test: {
        globals: true,
        // Angular's TestBed needs a DOM; jsdom is enough (we drive signals by
        // hand, no rendering).
        environment: 'jsdom',
        // Initialise the Angular test environment once (zone.js + TestBed).
        setupFiles: ['./test/setup.ts'],
        include: ['test/**/*.spec.ts'],
        // Angular and RxJS ship ESM with package `exports`; force vitest to
        // transform them so their entry points (incl. `@angular/core/rxjs-interop`)
        // resolve under the node test runner.
        server: { deps: { inline: [/^@angular\//, /^rxjs/, /^zone\.js/] } },
    },
});
