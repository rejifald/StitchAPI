import { defineConfig, devices } from '@playwright/test';

/**
 * Real-browser tests for the guarantees a node fake can only assume — today the
 * `stitchapi/postmessage` window-peer binding, which rests on `WindowProxy`
 * identity across reloads, navigations and remounts (test/browser/). No server:
 * every origin is fake and answered by `page.route`, and the surface is bundled
 * from `src/` on each run, so nothing needs building first.
 *
 *   pnpm --filter stitchapi test:browser:install   # one-time: fetch chromium
 *   pnpm --filter stitchapi test:browser
 *
 * `*.browser.ts`, not `*.spec.ts`, so vitest's `test/**\/*.spec.ts` never
 * collects them. CI runs them in the `e2e` job, which already installs chromium.
 */
export default defineConfig({
    testDir: './test/browser',
    testMatch: '**/*.browser.ts',
    timeout: 30_000,
    expect: { timeout: 10_000 },
    reporter: process.env.CI ? 'github' : 'list',
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
