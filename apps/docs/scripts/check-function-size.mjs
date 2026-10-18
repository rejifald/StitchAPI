// Fail when a deployed function's files add up to more than a budget kept well
// below Vercel's 250 MB uncompressed cap.
//
// Vercel refuses a deploy outright when one function is over the cap: "The
// Vercel Function "api/mcp" is 276.86mb uncompressed which exceeds the maximum
// uncompressed size limit of 250mb". The build has already succeeded by then, so
// CI's build stays green while every production deploy fails. That happened from
// 2026-09-30 to 2026-10-18: #836 bumped onnxruntime-node 1.24 → 1.30, its linux
// libraries grew by 17 MB, and /api/mcp crossed the cap with nothing in CI to say
// so. The cap is the same on every plan.
//
// What a function ships is its entry plus the files `next build` traced for it
// (the `*.nft.json` beside every entry under .next/server), plus the Next server
// runtime it runs on (.next/next-server.js.nft.json). This sums the sizes of that
// union per function and fails over BUDGET_MB. The two search functions carry
// almost all of it: the embedding model (90 MB), onnxruntime's linux/x64 library
// (46 MB), the search index (19 MB) and sharp's libvips (19 MB); see
// outputFileTracingIncludes in next.config.mjs.
//
// The sum only means something on the platform Vercel builds on, so CI runs it on
// linux (verify-docs, verify.yml). On macOS the trace carries darwin binaries in
// place of linux ones, and the number is not comparable. It also has to see the
// deploy-only artifacts: the search index and the model are built only when
// VERCEL or BUILD_SEARCH_INDEX is set (scripts/prebuild-search-index.mjs), and a
// build without them would measure a function 110 MB lighter than the one that
// ships. So it fails when the search functions' traces hold neither.
//
// Run it after `pnpm build` with BUILD_SEARCH_INDEX=1; CI does:
//
//     pnpm --filter @stitchapi/docs check:function-size
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The budget, in MB (10^6 bytes), for what this script measures.
 *
 * Vercel counts more than the traces list. For the build it refused at 276.86 MB
 * (onnxruntime-node 1.30, before the trims in next.config.mjs), this measure
 * comes to about 243 MB on linux: a macOS build of that commit, with its darwin
 * onnxruntime and sharp binaries swapped for the linux ones' published sizes. So
 * Vercel's figure runs about 34 MB above this one, from what its builder adds to
 * each function and from how it counts.
 *
 * 200 here is about 234 MB to Vercel: 16 MB under the cap at the moment this
 * fails. /api/mcp measured about 190 MB here (about 224 MB to Vercel) when the
 * budget was set. Raising it eats the headroom, so a change that needs more
 * should take weight out first; the model and onnxruntime are the big items.
 */
export const BUDGET_MB = 200;

/** Functions that must carry the deploy-only search artifacts. */
const SEARCH_FUNCTIONS = [
    'app/api/mcp/route.js',
    'app/api/search-docs/route.js',
];

const MB = 1e6;

/** How many of the largest files to list for a function over budget. */
const LISTED = 10;

/**
 * Absolute paths of a trace's files. Entries are relative to the directory of the
 * nft file that lists them.
 * @param {string} trace absolute path of a `*.nft.json`
 * @returns {string[]}
 */
export function tracedFiles(trace) {
    const { files } = JSON.parse(readFileSync(trace, 'utf8'));
    if (!Array.isArray(files)) {
        throw new Error(`${trace} has no "files" list`);
    }
    return files.map((file) => resolve(dirname(trace), file));
}

/**
 * Total size in bytes of the distinct regular files among `files`, with the
 * sizes of each, largest first. A path that is a directory or does not exist
 * counts as nothing (check-traces.mjs is the gate for paths that should not be
 * there at all).
 * @param {Iterable<string>} files absolute paths
 * @param {(file: string) => import('node:fs').Stats | undefined} [stat]
 * @returns {{ bytes: number, sizes: Array<[string, number]> }}
 */
export function measure(files, stat = statOrUndefined) {
    const sizes = [];
    let bytes = 0;
    for (const file of new Set(files)) {
        const stats = stat(file);
        if (!stats?.isFile()) continue;
        sizes.push([file, stats.size]);
        bytes += stats.size;
    }
    sizes.sort((a, b) => b[1] - a[1]);
    return { bytes, sizes };
}

function statOrUndefined(file) {
    try {
        return statSync(file);
    } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
    }
}

/**
 * Whether `files` hold the search index and the vendored embedding model.
 * @param {string} root absolute path of the app (apps/docs)
 * @param {string[]} files absolute paths
 * @returns {boolean}
 */
export function hasSearchArtifacts(root, files) {
    const under = (dir) =>
        files.some((file) => file.startsWith(join(root, dir) + sep));
    return under('.search-index') && under('.model-cache');
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

const mb = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

async function main() {
    const say = (message) => console.log(`[check-function-size] ${message}`);
    const fail = (message) => {
        console.error(`[check-function-size] ${message}`);
        process.exit(1);
    };
    const dotNext = join(appRoot, '.next');
    const serverDir = join(dotNext, 'server');
    const traces = findTraces(serverDir);
    if (traces.length === 0) {
        fail(
            `no *.nft.json under ${relative(appRoot, serverDir)}, so there is nothing ` +
                'to measure. Run this after `pnpm build` has finished.',
        );
    }
    if (process.platform !== 'linux') {
        say(
            `warning: running on ${process.platform}. Vercel builds on linux, and the ` +
                'native binaries traced here are not the ones it ships, so the sizes ' +
                'below are not comparable to the budget.',
        );
    }
    const runtime = tracedFiles(join(dotNext, 'next-server.js.nft.json'));

    const results = traces.map((trace) => {
        const entry = trace.slice(0, -'.nft.json'.length);
        const files = tracedFiles(trace);
        return {
            name: relative(serverDir, entry),
            files,
            ...measure([entry, ...files, ...runtime]),
        };
    });

    for (const name of SEARCH_FUNCTIONS) {
        const result = results.find((r) => r.name === name);
        if (!result) fail(`no trace for ${name}; did the route move?`);
        if (!hasSearchArtifacts(appRoot, result.files)) {
            fail(
                `${name} carries no search index or embedding model, so its size here is ` +
                    'not what deploys. Build with BUILD_SEARCH_INDEX=1 (see ' +
                    'scripts/prebuild-search-index.mjs) and run this again.',
            );
        }
    }

    results.sort((a, b) => b.bytes - a.bytes);
    const over = results.filter((r) => r.bytes > BUDGET_MB * MB);
    for (const result of results.slice(0, 3)) {
        say(`${result.name}: ${mb(result.bytes)} of ${BUDGET_MB} MB`);
    }
    for (const result of over) {
        say(`${result.name} is over budget; its largest files:`);
        for (const [file, bytes] of result.sizes.slice(0, LISTED)) {
            console.log(
                `    ${mb(bytes).padStart(9)}  ${relative(appRoot, file)}`,
            );
        }
    }
    if (over.length > 0) {
        fail(
            `${over.length} function(s) over the ${BUDGET_MB} MB budget. Vercel refuses ` +
                'a deploy with a function over 250 MB uncompressed, and the budget ' +
                'leaves room for what Vercel adds. See scripts/check-function-size.mjs.',
        );
    }
    say(`${results.length} functions measured, all within ${BUDGET_MB} MB`);
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    await main();
}
