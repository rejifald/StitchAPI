#!/usr/bin/env node
// attw ("Are the types wrong?") gate for the @stitchapi/* COMPANION packages.
//
// Core runs attw itself via its own `check:exports`. The companions intentionally carry no
// attw devDep (zero extra dependency surface), so this drives core's already-installed
// @arethetypeswrong/cli binary against each one — no per-companion devDep or lockfile change.
// It packs each companion (its `prepack` builds it) and verifies the dual ESM/CJS `exports`
// types resolve cleanly across node10 / node16-CJS / node16-ESM / bundler. Mirrors the
// guarantee core already has, for every published package.
import { execFileSync } from 'node:child_process';

const COMPANIONS = [
    'nest',
    'redis',
    'shell',
    'fingerprint-zod',
    'fingerprint-valibot',
    'fingerprint-arktype',
    'fingerprint-typebox',
    'fingerprint-effect',
];

let failed = 0;
for (const dir of COMPANIONS) {
    process.stdout.write(`\nattw @stitchapi/${dir} …\n`);
    try {
        // `pnpm --filter stitchapi exec` runs in packages/core, so `../<dir>` resolves to the
        // sibling companion; attw --pack builds + packs it and checks type resolution.
        execFileSync(
            'pnpm',
            [
                '--filter',
                'stitchapi',
                'exec',
                'attw',
                '--pack',
                `../${dir}`,
                '--ignore-rules',
                'no-resolution',
            ],
            { stdio: 'inherit' },
        );
    } catch {
        failed++;
    }
}

if (failed) {
    console.error(
        `\n✗ attw found type-resolution problems in ${failed} companion package(s).`,
    );
    process.exit(1);
}
console.log(
    `\n✓ attw clean across all ${COMPANIONS.length} companion packages.`,
);
