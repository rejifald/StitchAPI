import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Alias the workspace package to core SOURCE, so tests run without `stitchapi` being built first
// (mirrors tsconfig `paths` + @stitchapi/nest).
const src = (p: string): string =>
    fileURLToPath(new URL(`../core/src/${p}`, import.meta.url));

export default defineConfig({
    resolve: {
        alias: [{ find: /^stitchapi$/, replacement: src('index.ts') }],
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.spec.ts'],
    },
});
