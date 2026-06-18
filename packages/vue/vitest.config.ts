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
        // Composables drive Vue's reactivity directly via `effectScope` — no DOM,
        // no component mount — so the plain node env is enough.
        environment: 'node',
        include: ['test/**/*.spec.ts'],
    },
});
