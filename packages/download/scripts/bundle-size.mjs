// Bundle-size budget gate for the `@stitchapi/download` entry.
//
// Same discipline as the core gate (packages/core/scripts/bundle-size.mjs): measure
// the TREE-SHAKEN cost a downstream bundler actually emits — minified + gzipped — and
// fail if it exceeds the budget. `stitchapi` (and its `stitchapi/*` subpaths) is a peer
// dependency, so it is externalised: what we budget here is JUST this package's own
// code — the FIFO scheduler, aggregate progress/ETA, cancel wiring, and error classifier.
//
// The budget is a deliberate ceiling. Raising it is a conscious act: edit the number
// below and justify it in the PR. Prefer trimming, or gating a new capability, over
// bumping the budget.
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

// Budget for 1.0.0-rc.4 — the initial @stitchapi/download entry. The batch
// orchestrator (FIFO scheduler + progress/ETA + classifier + cancel + idle timer)
// measured ~2.46 KB gzip with `stitchapi` externalised, under a 2.65 KB ceiling.
//
// RAISED to 3.05 KB for #455, which hardened the opt-in `dedupe` on both axes the
// v1 note listed: keys off the RESOLVED request target (a local ~15-line endpoint
// resolver — core exports no URL builder, and a dedupe key is not a good reason to
// widen core's public surface), and REF-COUNTED sharers, so one sharer's cancel no
// longer decides the fetch for the rest. That measures ~2.85 KB gzip; ~0.38 KB of
// the growth is the two mechanisms themselves, and it was trimmed where it could be
// (the group lives on the existing per-item `Active` record rather than in a second
// id-keyed map). The ceiling keeps the same tight ~0.2 KB headroom core's gate holds,
// so the NEXT increment is still a conscious act.
//
// `stitchapi` and every `stitchapi/*` subpath are external (peer dep).
const SCENARIOS = [
    {
        name: '@stitchapi/download — whole entry',
        code: `export * from './index.mjs';`,
        budget: 3.05 * KB,
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
        // Zero deps of our own; `stitchapi` is a peer (externalised), and the
        // root entry stays browser-safe (no static node:* in shipped code).
        external: ['node:*', 'stitchapi', 'stitchapi/*'],
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
                kb: Math.round(gzip / KB),
                budget,
                over,
            })),
            null,
            2,
        ),
    );
} else {
    const col = (s, w) => String(s).padStart(w);
    console.log(
        '\n  @stitchapi/download bundle budget — tree-shaken, min+gzip\n',
    );
    console.log(
        '  ' +
            'scenario'.padEnd(36) +
            col('minified', 11) +
            col('gzip', 11) +
            col('brotli', 11) +
            col('budget', 11) +
            '   status',
    );
    console.log('  ' + '─'.repeat(93));
    for (const r of rows) {
        const headroom = r.over
            ? `OVER by ${kb(r.gzip - r.budget)}`
            : `${kb(r.budget - r.gzip)} left`;
        console.log(
            '  ' +
                r.name.padEnd(36) +
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
            '  Trim the entry, or gate a new capability behind an option. If the growth is\n' +
            '  genuinely necessary, raise the budget in packages/download/scripts/bundle-size.mjs\n' +
            '  and say why in the PR — the budget is the gate, so bumping it must be deliberate.\n',
    );
    process.exit(1);
}

if (!process.argv.includes('--json')) {
    console.log('✓ @stitchapi/download entry within budget.\n');
}
