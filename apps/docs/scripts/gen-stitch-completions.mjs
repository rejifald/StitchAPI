#!/usr/bin/env node
// Thin CLI wrapper — logic lives in @stitchapi/completions-plugin.
// Run:  pnpm --filter @stitchapi/docs run gen:completions   (writes the file)
//       node apps/docs/scripts/gen-stitch-completions.mjs --emit   (prints to stdout)
// `--emit` is the drift-check path: yakir's `playground-completions` tether runs it
// and compares the output to the committed file (see yakir.json).
import {
    generatePlaygroundCompletions,
    renderPlaygroundCompletions,
} from '@stitchapi/completions-plugin';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const packages = [
    resolve(repoRoot, 'packages/core'),
    // Add adapter packages here if they expose *Config interfaces + exports:
    // resolve(repoRoot, 'packages/some-adapter'),
];
const outputFile = resolve(
    __dirname,
    '../app/(home)/playground/playground-completions.generated.ts',
);

if (process.argv.includes('--emit')) {
    process.stdout.write(renderPlaygroundCompletions({ packages }));
} else {
    await generatePlaygroundCompletions({ packages, outputFile });
}
