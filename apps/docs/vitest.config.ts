import { defineConfig } from 'vitest/config';

// Docs-IA guardrail tests only (test/**/*.spec.ts) — manifest ↔ content/docs
// two-way sync and gen:docs idempotency. The Playwright e2e suite is separate
// (`test:e2e`), and Next/Fumadocs rendering is covered by the build gate.
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.spec.ts'],
    },
});
