import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Alias the workspace packages to their SOURCE (more specific subpaths first), so
// tests run without `stitchapi` / `@stitchapi/query-core` / `@stitchapi/react`
// being built. Mirrors tsconfig `paths`. `react-native` is aliased to a tiny stub
// so the lifecycle module imports cleanly off-device (the hooks inject their
// platform module in tests anyway).
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
            { find: /^react-native$/, replacement: stub('react-native.ts') },
        ],
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.spec.ts'],
    },
});
