import { version } from './package.json';

import { defineConfig } from 'vitest/config';

export default defineConfig({
    // Mirror the tsup `define` so the test run sees the same build-time version
    // constant the shipped bundle does (src/mcp.ts → SERVER_VERSION). Kept in
    // lockstep with tsup.config.ts; sourced from the canonical package.json.
    define: { __PKG_VERSION__: JSON.stringify(version) },
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.spec.ts'],
        coverage: {
            provider: 'v8',
            // `json-summary` writes coverage/coverage-summary.json, the machine-
            // readable totals the README coverage badge is refreshed from
            // (scripts/gen-readme-metrics.mjs --refresh, run by `pnpm metrics`).
            reporter: ['text', 'lcov', 'json-summary'],
            reportsDirectory: 'coverage',
            include: ['src/**/*.ts'],
            // Global per-metric floors so `test:coverage` fails if coverage regresses.
            // Deliberately set a few points UNDER the current actuals (observed
            // 2026-06-18: statements 87.39 / branches 77.34 / functions 90.35 /
            // lines 89.64) so the gate passes today with headroom and can be
            // ratcheted up over time — never set a floor above the live number or
            // the gate reds on a no-op run.
            thresholds: {
                statements: 84,
                branches: 73,
                functions: 87,
                lines: 86,
            },
        },
    },
});
