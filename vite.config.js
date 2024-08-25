import path from 'path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
    plugins: [dts()],
    alias: {
        // eslint-disable-next-line no-undef
        '@/': path.resolve(__dirname, 'src'),
    },
    build: {
        lib: {
            entry: 'src/index.ts',
            name: 'index.[ext].js',
        },
        outDir: 'lib',
    },
});
