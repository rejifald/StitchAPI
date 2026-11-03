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
// `npx -p stitchapi stitch …` is equivalent and also allowed; `npx -p stitch …` is
// not, because `-p` names the package npm downloads.
//
// Checks (exit 1 on any failure):
//   1. No tracked non-binary file invokes `stitch` — as a bare name or `stitch@tag` —
//      through npx, pnpx, bunx, `pnpm dlx`, `yarn dlx`, `npm exec` / `npm x` or `bun x`.
//      Every tracked file is read (a binary one — a NUL byte in its first 8 KB, git's
//      own test — is skipped), not just a list of extensions: Cursor's `.mdc`, `.mts`,
//      `.html` and a Dockerfile all carry commands. A command may wrap — `npx` at the
//      end of a line with the name on the next, or a backslash continuation — so the
//      scan reads past newlines, up to the next blank line. `pnpm exec` is left alone:
//      it only runs a local bin and never downloads. `CHANGELOG.md` is frozen history
//      and may quote the old command.
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

// Frozen history (may quote the old command) and this guard, whose docs do.
const EXEMPT = new Set(['CHANGELOG.md', 'scripts/check-npx-bin.mjs']);

// A runner that can fetch a package from the registry. `pnpm exec` is absent on
// purpose: it executes a local bin and never downloads. The lookbehind keeps a word
// that merely ends in a runner's name (`foo-npx`, `@x/npx`) from counting as a command.
const RUNNER =
    /(?<![\w@-])(?:npx|pnpx|bunx|pnpm\s+dlx|yarn\s+dlx|npm\s+(?:exec|x)|bun\s+x)(?=\s)/g;

// How far past a runner the package name can sit: a few options, possibly wrapped
// over several lines, never a new paragraph.
const WINDOW = 400;

// Options that take the next token as their value (`--registry URL`), across npm exec,
// pnpm dlx, yarn dlx and bunx. `--flag=value` carries its own value and needs no entry.
// An option missing here is still skipped when its value looks like a URL, path or number.
const VALUE_OPTIONS = new Set([
    '--registry',
    '--cache',
    '--prefix',
    '--userconfig',
    '--globalconfig',
    '--loglevel',
    '--otp',
    '--before',
    '--node-options',
    '--script-shell',
    '--shell',
    '--cwd',
    '--allow-build',
    '--workspace',
    '-w',
    '--tag',
]);
const looksLikeValue = (token) =>
    /^(?:[a-z][\w+.-]*:\/\/|[.~/]|\d+$)/i.test(token ?? '');

// The package name a token spells, found past any markdown or prose that hugs it
// (backticks, quotes, brackets, `&&`, a trailing full stop): "stitch`](/x)" → "stitch".
const NAME = /^[^\w@]*([@\w][\w@./-]*)/;
const nameOf = (token) => {
    const m = NAME.exec(token ?? '');
    return m ? m[1].replace(/[./-]+$/, '') : null;
};

// `stitch` itself, or `stitch@<tag-or-range>`: the unrelated npm package.
const isForeign = (name) =>
    name !== null && (name === 'stitch' || name.startsWith('stitch@'));

/**
 * The names a runner invocation would resolve as npm packages, given the tokens after
 * the runner. `-p` / `--package` (repeatable, `=` form too) name the packages outright,
 * and the command word after the options is then just a bin; without one, the first
 * word that is not an option is the package. `-c` / `--call` carry a whole shell
 * string, so nothing resolves.
 *
 * @param {string[]} tokens
 * @returns {(string | null)[]}
 */
function resolvedPackages(tokens) {
    const explicit = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token.startsWith('-')) {
            return explicit.length ? explicit : [nameOf(token)];
        }
        const eq = token.indexOf('=');
        const flag = eq === -1 ? token : token.slice(0, eq);
        const inline = eq === -1 ? undefined : token.slice(eq + 1);
        if (flag === '-p' || flag === '--package') {
            explicit.push(nameOf(inline ?? tokens[++i]));
        } else if (flag === '-c' || flag === '--call') {
            return explicit;
        } else if (
            inline === undefined &&
            (VALUE_OPTIONS.has(flag) || looksLikeValue(tokens[i + 1]))
        ) {
            i++; // the option's value, not the package
        }
    }
    return explicit;
}

/**
 * Every place `text` launches the foreign `stitch` package through a runner.
 *
 * @param {string} text
 * @returns {{ line: number, snippet: string }[]}
 */
export function findBareStitchRunners(text) {
    // A backslash continuation joins two lines into one command. Blank it out at the
    // same length, so indexes (and with them line numbers) still point into `text`.
    const flat = text.replace(/\\\r?\n/g, (m) => ' '.repeat(m.length));
    const hits = [];
    let line = 1;
    let counted = 0; // `text` is read up to here for line numbers (`flat` lost the continuation newlines)
    for (const match of flat.matchAll(RUNNER)) {
        for (
            let nl = text.indexOf('\n', counted);
            nl !== -1 && nl < match.index;
            nl = text.indexOf('\n', counted)
        ) {
            line++;
            counted = nl + 1;
        }
        if (hits.at(-1)?.line === line) continue; // one report per line is enough
        const from = match.index + match[0].length;
        const rest = flat
            .slice(from, from + WINDOW)
            .split(/\r?\n[ \t]*\r?\n/)[0];
        const tokens = rest.split(/\s+/).filter(Boolean);
        if (resolvedPackages(tokens).some(isForeign)) {
            const snippet = text.split('\n')[line - 1].trim().slice(0, 140);
            hits.push({ line, snippet });
        }
    }
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

function trackedFiles() {
    const out = execFileSync('git', ['ls-files', '-z'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\0').filter((f) => f && !EXEMPT.has(f));
}

function main() {
    const failures = [];
    let scanned = 0;
    for (const file of trackedFiles()) {
        let bytes;
        try {
            bytes = readFileSync(join(ROOT, file));
        } catch {
            continue; // listed but absent (deleted in the working tree), or a submodule
        }
        if (bytes.subarray(0, 8000).includes(0)) continue; // binary, by git's own test
        scanned++;
        for (const { line, snippet } of findBareStitchRunners(
            bytes.toString('utf8'),
        )) {
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
        `✓ no bare \`stitch\` runner invocation across ${scanned} tracked text files; \`npx stitchapi\` resolves to a single bin.`,
    );
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    main();
}
