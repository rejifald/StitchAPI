import { defineConfig } from 'tsup';

// Single dual-format entry. The bundle is just the adapter: it ships no validation engine, and
// the only imports are type-only (`stitchapi` for the StitchSchema type; `ajv` is a structural
// interface, not imported), so nothing external lands in the runtime bundle.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
});
