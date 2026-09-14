#!/usr/bin/env node
// attw ("Are the types wrong?") gate for the @stitchapi/* COMPANION packages.
//
// Core runs attw itself via its own `check:exports`. The companions intentionally carry no
// attw devDep (zero extra dependency surface), so this drives core's already-installed
// @arethetypeswrong/cli binary against each one — no per-companion devDep or lockfile change.
// It packs each companion (its `prepack` builds it) and verifies the dual ESM/CJS `exports`
// types resolve cleanly across node10 / node16-CJS / node16-ESM / bundler. Mirrors the
// guarantee core already has, for every published package.
//
// Why core's own `check:exports` passes `--ignore-rules no-resolution` (2026-09 audit, verified
// rather than inherited): legacy `moduleResolution: "node"` — attw's **node10** column — does not
// read the `exports` map at all, so a SUBPATH's types resolve there only via `typesVersions`. Core
// publishes 18 entry points, and without the flag all 16 non-root subpaths report `NoResolution` on
// node10 alone. Re-run `pnpm exec attw --pack .` in packages/core with the flag removed and the
// table shows exactly that shape: `"stitchapi"` green everywhere including node10, every subpath
// green under node16-CJS, node16-ESM and bundler, and 💀 only under node10. So the flag suppresses
// a known limitation of a resolver the package does not target, not a broken entry point.
//
// The same flag is passed for each companion below, where it is inert rather than load-bearing:
// every companion publishes a single `"."` entry, which node10 resolves through the `main`/`types`
// fallback, so none of them can produce a `NoResolution`. It is kept only so the two invocations
// stay one command — if a companion ever grows a subpath, the flag is already the reason its
// node10 column will go quiet, and that is the moment to add `typesVersions` instead.
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
