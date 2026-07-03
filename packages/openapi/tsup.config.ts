import { defineConfig } from 'tsup';

// Two entries: the library (`planGen` + types) and the CLI (`stitch-openapi`, reached
// through bin/stitch-openapi). No runtime deps — JSON parses natively and YAML is a
// lazily-imported optional, so nothing is bundled beyond the generator itself.
export default defineConfig({
    entry: ['src/index.ts', 'src/cli.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
});
