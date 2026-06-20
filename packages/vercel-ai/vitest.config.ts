import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

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
        environment: 'node',
        include: ['test/**/*.spec.ts'],
    },
});
