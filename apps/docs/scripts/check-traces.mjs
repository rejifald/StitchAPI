// Fail when a deployed function's file trace reaches build scratch or this app's
// own tests (#829, #830).
//
// Vercel ships each route as its entry plus the files `next build` traced for it,
// listed in the `*.nft.json` beside every entry under .next/server. Once the build
// moved to webpack (#830), the search routes' traces swept in the whole app
// directory (content, test/, e2e/, `.next/cache` and `.next/lock`), because an
// index path was built from values that file tracing cannot read (see
// lib/search-index/app-path.ts). `next build` deletes `.next/lock` when it exits,
// so Vercel's "Deploying outputs" step failed on an `lstat` of a file that was
// gone, while CI built the same commit green: a CI build compiles but never
// packages functions.
//
// This reads the traces the build just wrote and fails on any traced file that is
// under `.next/` but outside `.next/server/` (Next itself lists
// `.next/package.json`, so that one passes), or under `test/`, `e2e/` or
// `scripts/`. The content, the search index and the model are traced on purpose
// (outputFileTracingIncludes in next.config.mjs), so they are not policed. With no
// traces to read it fails too: a skipped or failed build must not pass a check by
// leaving it nothing to look at.
//
// Run it after `pnpm build`; CI does, in the `verify-docs` job (verify.yml):
//
//     pnpm --filter @stitchapi/docs check:traces
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** How many offending paths to list per trace; the count itself is always the full one. */
const LISTED = 10;

/**
 * Whether `file` is `path` itself or lies below it. Containment by path.relative,
 * not by string prefix: `/repo/apps/docs/testing` is not inside
 * `/repo/apps/docs/test`.
 * @param {string} path
 * @param {string} file
 * @returns {boolean}
 */
function within(path, file) {
    const from = relative(path, file);
    return !(from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from));
}

/**
 * The traced files a deployed function must not carry: build scratch (anything
 * under `.next/` except `.next/server/` and `.next/package.json`) and this app's
 * own `test/`, `e2e/` and `scripts/`.
 * @param {string} root absolute path of the app (apps/docs)
 * @param {string[]} tracedFiles absolute paths
 * @returns {string[]}
 */
export function strayTracedFiles(root, tracedFiles) {
    const dotNext = join(root, '.next');
    const shipped = [join(dotNext, 'server'), join(dotNext, 'package.json')];
    const devOnly = ['test', 'e2e', 'scripts'].map((name) => join(root, name));
    return tracedFiles.filter((file) =>
        within(dotNext, file)
            ? !shipped.some((path) => within(path, file))
            : devOnly.some((path) => within(path, file)),
    );
}

/**
 * Every `*.nft.json` under `dir`; none when `dir` is missing (no build ran).
 * @param {string} dir
 * @returns {string[]}
 */
function findTraces(dir) {
    try {
        return readdirSync(dir, { recursive: true })
            .filter((entry) => entry.endsWith('.nft.json'))
            .map((entry) => join(dir, entry));
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function main() {
    const say = (message) => console.log(`[check-traces] ${message}`);
    const serverDir = join(appRoot, '.next', 'server');
    const traces = findTraces(serverDir);
    if (traces.length === 0) {
        console.error(
            `[check-traces] no *.nft.json under ${relative(appRoot, serverDir)}, so there is ` +
                'nothing to check. Run this after `pnpm build` has finished.',
        );
        process.exit(1);
    }

    let failing = 0;
    for (const trace of traces) {
        const name = relative(appRoot, trace);
        const { files } = JSON.parse(readFileSync(trace, 'utf8'));
        if (!Array.isArray(files)) {
            throw new Error(`${name} has no "files" list`);
        }
        // Entries are relative to the directory of the nft file that lists them.
        const stray = strayTracedFiles(
            appRoot,
            files.map((file) => resolve(dirname(trace), file)),
        );
        if (stray.length === 0) continue;
        failing += 1;
        say(
            `${name}: ${stray.length} of ${files.length} traced files should not ship:`,
        );
        for (const file of stray.slice(0, LISTED)) {
            console.log(`    ${relative(appRoot, file)}`);
        }
        if (stray.length > LISTED) {
            console.log(`    … and ${stray.length - LISTED} more`);
        }
    }

    if (failing > 0) {
        say(
            `${failing} of ${traces.length} traces reach outside .next/server or into ` +
                'test/e2e/scripts; Vercel would package them. See scripts/check-traces.mjs',
        );
        process.exit(1);
    }
    say(
        `${traces.length} traces checked, none reaches outside .next/server or into test/e2e/scripts`,
    );
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    await main();
}
