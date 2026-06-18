import { defineConfig } from 'tsup';

// Single dual-format entry. `stitchapi` and `vue` are peer deps (externalised by
// tsup); `@stitchapi/query-core` is a runtime dep and is also kept external so
// the Vue bindings stay a thin layer over it.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
    external: ['@stitchapi/query-core'],
});
