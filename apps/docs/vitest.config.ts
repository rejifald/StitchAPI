import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Docs-IA guardrail tests only (test/**/*.spec.ts) — manifest ↔ content/docs
// two-way sync and gen:docs idempotency. The Playwright e2e suite is separate
// (`test:e2e`), and Next/Fumadocs rendering is covered by the build gate.
export default defineConfig({
    // Mirror the `@/*` path alias from tsconfig.json so a spec can import an
    // app-router module (e.g. app/api/search-docs/route.ts) the same way the
    // module imports its own dependencies — without the alias, vi.mock() of a
    // relative path and the route's `@/`-prefixed import resolve to two
    // different module ids and the mock silently doesn't apply.
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('.', import.meta.url)),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.spec.ts'],
    },
});
