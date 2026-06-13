#!/usr/bin/env node
// Thin CLI wrapper — logic lives in @stitchapi/completions-plugin.
// Run: pnpm --filter @stitchapi/docs run gen:completions
import { generatePlaygroundCompletions } from '@stitchapi/completions-plugin';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

await generatePlaygroundCompletions({
    packages: [
        resolve(repoRoot, 'packages/core'),
        // Add adapter packages here if they expose *Config interfaces + exports:
        // resolve(repoRoot, 'packages/some-adapter'),
    ],
    outputFile: resolve(
        __dirname,
        '../app/(home)/playground/playground-completions.generated.ts',
    ),
});
