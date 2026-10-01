#!/usr/bin/env node
// Guard: a package runner must never be pointed at the bare name `stitch`.
//
// Our executable is `stitch`, but it ships inside the `stitchapi` package. The npm
// name `stitch` is an unrelated package (`stitch@0.3.3`, no bin). `npx stitch …`
// finds our bin only when `stitchapi` is already installed in the project; anywhere
// else npm downloads the foreign package, and the day that package publishes a bin,
// every reader and every agent following our docs would run someone else's code.
// The rule text `stitch init` writes into users' repos carried the bare form, so
// one slip is copied into every adopter's AGENTS.md (#861).
//
// The correct form is `npx stitchapi <command>`. npm runs a package's only bin
// whatever it is called (libnpmexec `getBinFromManifest`: one distinct bin value, or
// a bin named like the package), and a bare, unversioned spec is satisfied by the
// locally installed copy with no network — so the project's pinned version runs, which
// is also the version `stitch init --check` compares the committed rule against.
// `npx -p stitchapi stitch …` is equivalent and also allowed.
//
// Checks (exit 1 on any failure):
//   1. No tracked text file invokes `stitch` — as a bare name or `stitch@tag` — through
//      npx, pnpx, bunx, `pnpm dlx`, `yarn dlx`, `npm exec` or `bun x`. `pnpm exec` is
//      left alone: it only runs a local bin and never downloads. `CHANGELOG.md` is
//      frozen history and may quote the old command.
//   2. `packages/core/package.json` keeps exactly one distinct `bin` target, so
//      `npx stitchapi` keeps resolving to an executable. A second bin would make npm
//      fail with "could not determine executable to run" unless it were named
//      `stitchapi`.
//
// Exported for apps/docs/test/check-npx-bin.spec.ts. Run via `pnpm check:npx-bin`.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TEXT_EXT = /\.(md|mdx|ts|tsx|mjs|cjs|js|json|ya?ml|sh|txt)$/;
// Frozen history (may quote the old command) and this guard, whose docs do.
const EXEMPT = new Set(['CHANGELOG.md', 'scripts/check-npx-bin.mjs']);

// A runner that can fetch a package from the registry. `pnpm exec` is absent on
// purpose: it executes a local bin and never downloads.
const RUNNER =
    /\b(?:npx|pnpx|bunx|pnpm\s+dlx|yarn\s+dlx|npm\s+exec|bun\s+x)\b/g;

// The name a runner is asked to launch, trimmed of the markdown / prose that
// can hug it (backticks, quotes, brackets, trailing punctuation).
const bare = (token) =>
    token.replace(/^[`'"([\\]+/, '').replace(/[`'")\].,;:\\]+$/, '');

/**
 * The command a runner invocation launches, given the text after the runner:
 * leading flags are skipped, and `-p` / `--package` mean the command is a bin of
 * that package, not a package of its own, so they disarm the check.
 *
 * @param {string} rest
 * @returns {string | null} the name npm would resolve as a package, or null
 */
function launchedName(rest) {
    const tokens = rest.split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token.startsWith('-')) return bare(token);
        // `-p stitchapi stitch …` / `--package=stitchapi stitch …`: explicit
        // package, so the next word is a bin name, which is fine.
        if (/^(?:-p|--package)(?:=|$)/.test(token)) return null;
        // `-c` / `--call` carry a whole shell string; nothing to resolve.
        if (/^(?:-c|--call)(?:=|$)/.test(token)) return null;
    }
    return null;
}

/**
 * Every place `text` launches the foreign `stitch` package through a runner.
 *
 * @param {string} text
 * @returns {{ line: number, snippet: string }[]}
 */
export function findBareStitchRunners(text) {
    const hits = [];
    text.split('\n').forEach((raw, i) => {
        for (const match of raw.matchAll(RUNNER)) {
            const rest = raw.slice(match.index + match[0].length);
            const name = launchedName(rest);
            if (name === 'stitch' || name?.startsWith('stitch@')) {
                hits.push({ line: i + 1, snippet: raw.trim().slice(0, 140) });
                break; // one report per line is enough
            }
        }
    });
    return hits;
}

/**
 * Whether `npx <package>` can pick an executable: npm needs a single distinct
 * `bin` target, or a bin named like the (unscoped) package.
 *
 * @param {{ name?: string, bin?: Record<string, string> | string }} pkg
 * @returns {boolean}
 */
export function resolvesSingleBin(pkg) {
    const bin =
        typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin ?? {});
    if (new Set(Object.values(bin)).size === 1) return true;
    const unscoped = (pkg.name ?? '').replace(/^@[^/]+\//, '');
    return Boolean(bin[unscoped]);
}

function trackedTextFiles() {
    const out = execFileSync('git', ['ls-files', '-z'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    return out
        .split('\0')
        .filter((f) => f && TEXT_EXT.test(f) && !EXEMPT.has(f));
}

function main() {
    const failures = [];
    const files = trackedTextFiles();
    for (const file of files) {
        let text;
        try {
            text = readFileSync(join(ROOT, file), 'utf8');
        } catch {
            continue; // listed but absent (deleted in the working tree)
        }
        for (const { line, snippet } of findBareStitchRunners(text)) {
            failures.push(`${file}:${line}: ${snippet}`);
        }
    }

    const corePkg = JSON.parse(
        readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8'),
    );
    const singleBin = resolvesSingleBin(corePkg);

    if (failures.length || !singleBin) {
        if (failures.length) {
            console.error(
                `\n✗ ${failures.length} bare \`stitch\` runner invocation(s) — the npm name \`stitch\` is an unrelated package:`,
            );
            for (const f of failures) console.error(`  ${f}`);
            console.error(
                '\n  Write `npx stitchapi <command>` (or `npx -p stitchapi stitch <command>`).' +
                    '\n  Run outside a project that has `stitchapi` installed, `npx stitch` downloads' +
                    '\n  another package. See #861.\n',
            );
        }
        if (!singleBin) {
            console.error(
                '\n✗ packages/core/package.json no longer has exactly one distinct `bin` target.' +
                    '\n  `npx stitchapi` needs a single bin (or one named `stitchapi`) so npm can pick' +
                    '\n  the executable; otherwise it fails with "could not determine executable to run".\n',
            );
        }
        process.exit(1);
    }
    console.log(
        `✓ no bare \`stitch\` runner invocation across ${files.length} tracked text files; \`npx stitchapi\` resolves to a single bin.`,
    );
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    main();
}
