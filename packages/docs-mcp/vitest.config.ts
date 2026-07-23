import { version } from './package.json';

import { defineConfig } from 'vitest/config';

// Mirror the tsup `define` so the test run sees the same build-time version
// constant the shipped bundle does. See src/version.d.ts.
export default defineConfig({
    define: { __PKG_VERSION__: JSON.stringify(version) },
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.spec.ts'],
    },
});
