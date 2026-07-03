import { defineConfig } from 'vitest/config';

// The generator is pure and self-contained (it imports nothing from `stitchapi` — it
// emits that as text), so no workspace alias is needed; just run the specs.
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.spec.ts'],
    },
});
