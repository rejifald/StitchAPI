import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Alias the workspace package to core SOURCE (more specific subpaths first), so
// tests run without `stitchapi` being built. Mirrors tsconfig `paths`.
const src = (p: string): string =>
    fileURLToPath(new URL(`../core/src/${p}`, import.meta.url));

export default defineConfig({
    resolve: {
        alias: [
            { find: /^stitchapi\/testing$/, replacement: src('testing.ts') },
            { find: /^stitchapi\/sse$/, replacement: src('sse.ts') },
            { find: /^stitchapi$/, replacement: src('index.ts') },
        ],
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.spec.ts'],
    },
});
