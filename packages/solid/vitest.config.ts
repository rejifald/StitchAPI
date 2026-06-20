import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Alias the workspace packages to their SOURCE (more specific subpaths first), so
// tests run without `stitchapi` / `@stitchapi/query-core` being built. Mirrors
// tsconfig `paths`.
const core = (p: string): string =>
    fileURLToPath(new URL(`../core/src/${p}`, import.meta.url));
const queryCore = (): string =>
    fileURLToPath(new URL('../query-core/src/index.ts', import.meta.url));

// Solid ships separate condition builds: the `node`/`server` build makes
// `createEffect` a no-op (SSR), so we MUST resolve the reactive CLIENT build.
// `['development', 'browser']` is Solid's documented test condition set — it loads
// `dist/dev.js`, the real reactive runtime, even though the test `environment` is
// `node` (we drive signals by hand, no DOM needed). A vitest node-env test runs
// through Vite's SSR pipeline, so the conditions must be set on `ssr.resolve` (not
// just `resolve`, which only governs the client graph).
const reactiveConditions = ['development', 'browser'];

const alias = [
    { find: /^stitchapi\/testing$/, replacement: core('testing.ts') },
    { find: /^stitchapi$/, replacement: core('index.ts') },
    { find: /^@stitchapi\/query-core$/, replacement: queryCore() },
];

export default defineConfig({
    resolve: { conditions: reactiveConditions, alias },
    ssr: { resolve: { conditions: reactiveConditions } },
    test: {
        globals: true,
        environment: 'node',
        // Force Solid through the inline transform so the export conditions above
        // pick the reactive build instead of node's default externalised require.
        server: { deps: { inline: ['solid-js'] } },
        include: ['test/**/*.spec.ts'],
    },
});
