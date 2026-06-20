import { defineConfig } from 'tsup';

// Single dual-format entry. `stitchapi`, `react`, `react-native`, and the
// optional native modules are peer deps (externalised by tsup); `@stitchapi/react`
// and `@stitchapi/query-core` are kept external too so these bindings stay a thin
// layer over the shared reactive core rather than re-bundling it.
export default defineConfig({
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    minify: true,
    outDir: 'lib',
    clean: true,
    external: [
        'stitchapi',
        '@stitchapi/query-core',
        '@stitchapi/react',
        'react',
        'react-native',
        '@react-native-async-storage/async-storage',
        '@react-native-community/netinfo',
    ],
});
