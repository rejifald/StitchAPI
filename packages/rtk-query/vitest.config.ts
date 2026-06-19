import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Alias `stitchapi` to its SOURCE so tests run without it being built first.
const core = (p: string): string =>
    fileURLToPath(new URL(`../core/src/${p}`, import.meta.url));

export default defineConfig({
    resolve: {
        alias: [
            { find: /^stitchapi\/testing$/, replacement: core('testing.ts') },
            { find: /^stitchapi$/, replacement: core('index.ts') },
        ],
    },
    test: {
        globals: true,
        // The adapters are framework-agnostic plain functions — no DOM needed.
        environment: 'node',
        include: ['test/**/*.spec.ts'],
    },
});
