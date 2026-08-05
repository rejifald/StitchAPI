#!/usr/bin/env node
// The workspace lint gate. Runs ESLint over every packages/* directory found ON DISK.
//
// It replaces `pnpm -r check:lint`, which only reached packages that DEFINE a
// `check:lint` script — in practice just core, leaving all 35 companions unlinted
// (#457). Enumerating the filesystem instead of the script map is the whole point: a
// new package is covered the moment it exists, and none can opt out by omitting a
// script. `scripts/check-lint.mjs --list` prints what would run.
//
// Why one eslint process PER PACKAGE rather than a single root pass: the rules are
// type-aware (strictTypeChecked), so a whole-workspace pass has to hold every
// package's TypeScript program in one heap. That exhausts Node's default heap —
// verified, SIGABRT at ~4.7 GB RSS, with both a tsconfig glob and `projectService` —
// which would leave the gate unrunnable in CI. Sharding keeps one program live at a
// time. It also gives each package its own `eslint-suppressions.json`, since ESLint
// resolves that path relative to cwd (core already has one; see eslint.config.ts).
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');
// eslint's `exports` map doesn't expose ./bin, so go through its manifest and read
// the documented `bin` entry rather than hard-coding the path.
const eslintPkg = require.resolve('eslint/package.json');
const eslintBin = resolve(
    dirname(eslintPkg),
    require(eslintPkg).bin.eslint ?? require(eslintPkg).bin,
);

// The directories a package is linted through. Mirrors core's historical
// `eslint src test`; a package contributes whichever of these it actually has.
const LINT_DIRS = ['src', 'test'];

// Bounded so peak memory stays a small multiple of one package's program rather
// than the whole workspace's.
const CONCURRENCY = 4;

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
// Anything not a flag filters by package directory name (`check-lint.mjs redis`).
const filters = argv.filter((a) => !a.startsWith('-'));
// Flags forwarded verbatim, so the baselines can be regenerated/pruned through the
// same sharding: `--suppress-all`, `--prune-suppressions`, `--fix`, …
const passthrough = argv.filter((a) => a.startsWith('-') && a !== '--list');

const targets = readdirSync(packagesDir)
    .filter((name) => statSync(join(packagesDir, name)).isDirectory())
    .sort()
    .map((name) => ({
        name,
        dir: join(packagesDir, name),
        dirs: LINT_DIRS.filter((d) => existsSync(join(packagesDir, name, d))),
    }))
    .filter((p) => p.dirs.length > 0)
    .filter((p) => filters.length === 0 || filters.includes(p.name));

if (listOnly) {
    for (const p of targets) console.log(`${p.name}: ${p.dirs.join(' ')}`);
    process.exit(0);
}

if (targets.length === 0) {
    console.error(
        filters.length
            ? `✗ no packages/* directory matched: ${filters.join(', ')}`
            : '✗ no lintable packages found under packages/',
    );
    process.exit(1);
}

async function lintPackage(pkg) {
    try {
        const { stdout, stderr } = await execFileAsync(
            process.execPath,
            [eslintBin, ...pkg.dirs, ...passthrough],
            // cwd is the package: it anchors parserOptions.project and the
            // eslint-suppressions.json lookup to that package (see eslint.config.ts).
            { cwd: pkg.dir, maxBuffer: 64 * 1024 * 1024 },
        );
        return { pkg, ok: true, output: stdout + stderr };
    } catch (error) {
        return {
            pkg,
            ok: false,
            output: (error.stdout ?? '') + (error.stderr ?? ''),
        };
    }
}

const queue = [...targets];
const results = [];
await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
            results.push(await lintPackage(next));
        }
    }),
);

const failures = results.filter((r) => !r.ok);
for (const r of results.sort((a, b) => a.pkg.name.localeCompare(b.pkg.name))) {
    // ESLint prints nothing when a package is clean; only surface the noisy ones.
    if (r.output.trim()) {
        process.stdout.write(`\n── packages/${r.pkg.name} ──\n${r.output}`);
    }
}

if (failures.length) {
    console.error(
        `\n✗ eslint failed in ${failures.length} of ${targets.length} package(s): ${failures
            .map((f) => f.pkg.name)
            .join(', ')}`,
    );
    process.exit(1);
}
console.log(`✓ eslint clean across ${targets.length} packages.`);
