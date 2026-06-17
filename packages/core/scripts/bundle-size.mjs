// Bundle-size budget gate for the `stitchapi` core entry.
//
// "Pay only for what you import" is a stated principle; this makes it an enforced
// gate. We measure the TREE-SHAKEN cost of importing from `stitchapi` — what a
// downstream bundler actually emits — minified + gzipped, and fail if any scenario
// exceeds its budget.
//
// Why re-bundle instead of `ls lib/index.mjs`? tsup code-splits shared engine code
// into chunks that several subpath entries import, so the raw entry file is only
// part of the cost and those chunks carry bytes other entries use. Re-bundling each
// scenario with esbuild + tree-shaking reproduces what a consumer's bundler ships —
// the same method bundlephobia uses. The numbers quoted in the READMEs and docs come
// from here; keep them in sync (see memory: core-zero-deps-bundle-size).
//
// Budgets are a deliberate ceiling. Raising one is a conscious act: edit the number
// below and justify it in the PR. Prefer trimming the entry, or moving a new
// capability behind its own subpath import, over bumping the budget.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

// esbuild ships as CommonJS; load it through createRequire so this stays robust
// regardless of ESM/CJS interop.
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const libDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib');

const KB = 1024;

// Each scenario is a real import a consumer writes. `budget` is the min+gzip ceiling.
const SCENARIOS = [
    {
        name: 'stitchapi — whole entry',
        code: `export * from './index.mjs';`,
        budget: 21.5 * KB,
    },
    {
        name: 'import { stitch }',
        code: `export { stitch } from './index.mjs';`,
        budget: 17.5 * KB,
    },
];

function measure(code) {
    const result = esbuild.buildSync({
        stdin: {
            contents: code,
            resolveDir: libDir,
            sourcefile: 'entry.mjs',
            loader: 'js',
        },
        bundle: true,
        minify: true,
        format: 'esm',
        treeShaking: true,
        platform: 'neutral',
        external: ['node:*'], // zero deps; the root entry is browser-safe
        write: false,
        logLevel: 'silent',
    });
    const out = result.outputFiles[0].contents;
    return {
        min: out.length,
        gzip: gzipSync(out, { level: 9 }).length,
        brotli: brotliCompressSync(out).length,
    };
}

const kb = (bytes) => `${(bytes / KB).toFixed(2)} KB`;

if (!existsSync(resolve(libDir, 'index.mjs'))) {
    console.error(
        '✗ lib/index.mjs not found — run `pnpm build` first (or use `pnpm size`).',
    );
    process.exit(1);
}

const rows = SCENARIOS.map((s) => {
    const m = measure(s.code);
    return { ...s, ...m, over: m.gzip > s.budget };
});

const failed = rows.some((r) => r.over);

if (process.argv.includes('--json')) {
    console.log(
        JSON.stringify(
            rows.map(({ name, min, gzip, brotli, budget, over }) => ({
                name,
                min,
                gzip,
                brotli,
                budget,
                over,
            })),
            null,
            2,
        ),
    );
} else {
    const col = (s, w) => String(s).padStart(w);
    console.log('\n  Core bundle budget — tree-shaken, min+gzip\n');
    console.log(
        '  ' +
            'scenario'.padEnd(26) +
            col('minified', 11) +
            col('gzip', 11) +
            col('brotli', 11) +
            col('budget', 11) +
            '   status',
    );
    console.log('  ' + '─'.repeat(83));
    for (const r of rows) {
        const headroom = r.over
            ? `OVER by ${kb(r.gzip - r.budget)}`
            : `${kb(r.budget - r.gzip)} left`;
        console.log(
            '  ' +
                r.name.padEnd(26) +
                col(kb(r.min), 11) +
                col(kb(r.gzip), 11) +
                col(kb(r.brotli), 11) +
                col(kb(r.budget), 11) +
                `   ${r.over ? '✗' : '✓'} ${headroom}`,
        );
    }
    console.log('');
}

if (failed) {
    console.error(
        '✗ Bundle budget exceeded.\n' +
            '  Trim the entry, or move the new capability behind its own subpath import\n' +
            '  (like cache / graphql / sse). If the growth is genuinely necessary, raise\n' +
            '  the budget in packages/core/scripts/bundle-size.mjs and say why in the PR —\n' +
            '  the budget is the gate, so bumping it must be deliberate.\n',
    );
    process.exit(1);
}

// Keep --json output pure (it is consumed by scripts/check-size-docs.mjs);
// the human-readable confirmation is only for the table view.
if (!process.argv.includes('--json')) {
    console.log('✓ Core entry within budget.\n');
}
