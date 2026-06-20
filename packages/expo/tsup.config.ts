import { defineConfig } from 'tsup';

// Single dual-format entry. The shared core (`@stitchapi/react-native`,
// `@stitchapi/react`, `@stitchapi/query-core`, `stitchapi`) and the platform
// modules (`react`, `react-native`, `expo/fetch`, `expo-secure-store`) are all
// kept external so this package stays a thin Expo specialization.
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
        '@stitchapi/react-native',
        'react',
        'react-native',
        'expo',
        'expo/fetch',
        'expo-secure-store',
        '@react-native-async-storage/async-storage',
        '@react-native-community/netinfo',
    ],
});
