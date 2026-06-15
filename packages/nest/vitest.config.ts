import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Alias the workspace package to core SOURCE, so tests run without `stitchapi`
// being built first. Mirrors tsconfig `paths`.
const src = (p: string): string =>
    fileURLToPath(new URL(`../core/src/${p}`, import.meta.url));

export default defineConfig({
    resolve: {
        alias: [{ find: /^stitchapi$/, replacement: src('index.ts') }],
    },
    test: {
        globals: true,
        environment: 'node',
        // Load the metadata polyfill before any test module, so importing the module
        // (which runs @Module/@Injectable at load) never depends on import ordering.
        setupFiles: ['reflect-metadata'],
        include: ['test/**/*.spec.ts'],
    },
});
