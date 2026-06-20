import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Alias the workspace packages to their SOURCE, and the native modules
// (`react-native`, `expo/fetch`) to tiny stubs so the modules import cleanly off
// device. Tests inject their own fetch / SecureStore, so the stubs only need to
// exist.
const core = (p: string): string =>
    fileURLToPath(new URL(`../core/src/${p}`, import.meta.url));
const pkg = (name: string, p: string): string =>
    fileURLToPath(new URL(`../${name}/src/${p}`, import.meta.url));
const stub = (p: string): string =>
    fileURLToPath(new URL(`./test/stubs/${p}`, import.meta.url));

export default defineConfig({
    resolve: {
        alias: [
            { find: /^stitchapi\/testing$/, replacement: core('testing.ts') },
            { find: /^stitchapi$/, replacement: core('index.ts') },
            {
                find: /^@stitchapi\/query-core$/,
                replacement: pkg('query-core', 'index.ts'),
            },
            {
                find: /^@stitchapi\/react$/,
                replacement: pkg('react', 'index.ts'),
            },
            {
                find: /^@stitchapi\/react-native$/,
                replacement: pkg('react-native', 'index.ts'),
            },
            { find: /^expo\/fetch$/, replacement: stub('expo-fetch.ts') },
            { find: /^react-native$/, replacement: stub('react-native.ts') },
        ],
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.spec.ts'],
    },
});
