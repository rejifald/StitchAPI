import { defineConfig } from 'tsup';

// Single dual-format entry. `stitchapi` and `@nestjs/common` are peer deps,
// externalised by tsup, so the bundle is just the wiring. Not minified — class
// names (e.g. SeamRegistry) show up in Nest's DI errors and logs.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: false,
    outDir: 'lib',
    clean: true,
});
