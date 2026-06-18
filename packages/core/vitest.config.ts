import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.spec.ts'],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
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
