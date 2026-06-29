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
//
// Budgets raised for 1.0.0-rc.1 (21.5→22.0 / 17.5→17.75 KB): the engine gained
// resource-safety code that lives on the core path and cannot move to a subpath —
// the caller's AbortSignal now interrupts retry/reconnect backoff and throttle waits
// (instead of sleeping out the full delay), the in-memory store opportunistically
// sweeps expired keys, and the throttle reclaims idle per-key/host state. The growth
// (~0.3 KB gzip) buys leak-freedom under long uptime and prompt cancellation; the
// headroom (~0.4 / ~0.3 KB) is deliberately kept tight so the gate stays meaningful.
//
// Budgets raised for 1.0.0-rc.2 (22.0→22.25 / 17.75→18.0 KB): the shape-only,
// BigInt-safe drift snapshot baselines and the secret-query-key registry (now exported
// for custom trace sinks) both sit on the core path; they push the entry to ~22.04 /
// ~17.78 KB gzip. The +0.25 KB step restores the same tight headroom (~0.2 KB) the
// gate is meant to keep.
//
// Budgets raised for `.inspect()` — ADR 0016 (22.25→22.65 / 18.0→18.30 KB): the
// never-throwing raw-body + drift-findings probe is baked into the core path by design
// (ADR 0016 Decision 6 — it reuses 0015's diff/findings, so it ships always, opt-in by
// call, and cannot move to a subpath). The retainRaw/bypassCache run flags, the
// `Inspection` wrapper consumer, and the contract-violation raw-pinning add ~0.19 / ~0.12
// KB gzip (entry ~22.44 / stitch ~18.12). The step restores the same tight ~0.2 KB
// headroom the gate is meant to hold.
//
// Budgets raised for adapter capabilities + the upload-progress teaching note — ADR 0005
// Decision 9 addendum (22.65→22.95 / 18.30→18.55 KB): the built-in adapters now declare a
// `capabilities` descriptor (a positive `supports` list) and the engine emits one `info`
// event when a call asks for upload progress a transport whose `supports` omits it can't
// give (turning a silent dead bar into a teaching note). Both sit on the core path — the
// check is in `execute` and the default `fetch` adapter carries the descriptor — so neither
// can move to a subpath. They add ~0.10 / ~0.04 KB gzip (entry ~22.74 / stitch ~18.34). The
// step restores the same tight ~0.2 KB headroom the gate is meant to hold.
const SCENARIOS = [
    {
        name: 'stitchapi — whole entry',
        code: `export * from './index.mjs';`,
        budget: 22.95 * KB,
    },
    {
        name: 'import { stitch }',
        code: `export { stitch } from './index.mjs';`,
        budget: 18.55 * KB,
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
