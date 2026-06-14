import { defineConfig, devices } from '@playwright/test';

/**
 * Minimal Playwright harness for the playground sandbox security model
 * (RELEASE.md → Playground browser Phase-2). The first spec proves the
 * load-bearing invariant: the CSP confines Worker egress to same-origin.
 *
 * Run against a production build for the real posture:
 *   pnpm run test:e2e:install   # one-time: fetch the chromium binary
 *   pnpm run build && pnpm run start &   # or let webServer build+start
 *   pnpm run test:e2e
 *
 * A running `pnpm dev` server is reused if present (reuseExistingServer); dev
 * relaxes connect-src for HMR but the cross-origin egress block still holds, so
 * the egress spec passes against either server.
 */
export default defineConfig({
    testDir: './e2e',
    timeout: 30_000,
    expect: { timeout: 10_000 },
    fullyParallel: true,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        baseURL: 'http://localhost:3000',
        trace: 'on-first-retry',
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: {
        // Build + start for the enforced (production) CSP posture. Reuses an
        // already-running server (e.g. `pnpm dev`) when one is up.
        command: 'pnpm run build && pnpm run start',
        url: 'http://localhost:3000',
        reuseExistingServer: true,
        timeout: 300_000,
    },
});
