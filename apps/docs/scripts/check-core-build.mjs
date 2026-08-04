// Guard the COHERENCE of the built `stitchapi` types the docs compile against,
// because when they skew the resulting error names the wrong thing entirely.
//
// Twoslash type-checks every ```ts twoslash``` block against the BUILT package
// (`packages/core/lib`), resolving each subpath through package.json `exports`:
// `stitchapi` → `lib/index.d.mts`, `stitchapi/pipe` → `lib/pipe.d.mts`. tsup
// emits the shared types those entries have in common as hashed chunks —
// `types-<hash>.d.mts`, `graphql-<hash>.d.mts` — and every entry imports from
// the same one. `Stitch` is declared ONCE, in the types chunk.
//
// A build that is interrupted (or half-fails after `clean`) can leave entries
// pointing at DIFFERENT vintages of a chunk. Then `Stitch` is two unrelated
// declarations, and a stitch built by `stitch()` no longer satisfies a parameter
// typed `Stitch` by `stitchapi/pipe`. TypeScript reports that as an overload
// failure — and since `ScopedRun`'s LAST overload takes a `Composable`, the
// message blames the wrong one:
//
//     [2769] No overload matches this call.
//       Property '__composable' is missing in type 'Stitch<...>'
//       but required in type 'Composable<unknown>'.
//
// which reads as an API break in `linked()`/`pipe.ts` rather than stale build
// output. Worse, twoslash throws on the first sample that fails and fumadocs-mdx
// compiles the collection eagerly, so ONE skewed chunk 500s every docs page —
// with a compiler error that points at a file nobody changed.
//
// This script asserts the invariant directly: within one module format, every
// hashed chunk family is referenced at exactly one hash, and every relative
// reference resolves to a file that exists. It is deliberately cheap (a few
// dozen small reads) so it can sit in front of `dev` and `build`, and it is
// runnable on its own — `pnpm --filter @stitchapi/docs check:core-build` — as
// the first thing to try when the docs 500 with a type error you cannot explain.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const libDir = resolve(appRoot, '../../packages/core/lib');

function fail(problem, detail = '') {
    console.error(
        `check-core-build: ${problem}\n` +
            (detail ? `\n${detail}\n` : '') +
            `\n  \`packages/core/lib\` is the built \`stitchapi\` package that twoslash\n` +
            `  type-checks the docs samples against. The output above means it is\n` +
            `  STALE or MIXED — the leftovers of a build that did not finish, not a\n` +
            `  source change. Nothing in \`packages/core/src\` needs fixing.\n\n` +
            `  Rebuild it:\n\n` +
            `      rm -rf packages/core/lib && pnpm --filter stitchapi build\n`,
    );
    process.exit(1);
}

let declarations;
try {
    declarations = readdirSync(libDir).filter((file) =>
        /\.d\.m?ts$/.test(file),
    );
} catch {
    fail(`\`packages/core/lib\` is missing (expected it at ${libDir})`);
}

if (!declarations.some((file) => file.endsWith('.d.mts'))) {
    fail(
        '`packages/core/lib` has no `.d.mts` declarations — the DTS build never ran',
    );
}

const present = new Set(declarations);

// `from './x.mjs'` (import and export-from) plus the `import('./x.mjs')` form a
// declaration file uses for an inline type reference.
const REFERENCE = /(?:from\s*|import\()\s*'(\.\/[^']+)'/g;
// A tsup/rollup shared chunk: the entry basename plus an 8-character hash. Real
// entry points (`registry.mjs`, `xhr-adapter.mjs`) have no such suffix and are
// only checked for existence.
const HASHED = /^(.+)-([A-Za-z0-9_$-]{8})$/;

// family+format → hash → the declaration files that referenced it.
const hashes = new Map();
const dangling = [];

for (const file of declarations) {
    const format = file.endsWith('.d.mts') ? 'esm' : 'cjs';
    const source = readFileSync(join(libDir, file), 'utf8');

    for (const [, specifier] of source.matchAll(REFERENCE)) {
        const base = specifier.replace(/^\.\//, '').replace(/\.m?js$/, '');
        const target = specifier.endsWith('.mjs')
            ? `${base}.d.mts`
            : `${base}.d.ts`;

        if (!present.has(target)) {
            dangling.push(`${file} → ${specifier} (no ${target})`);
            continue;
        }

        const chunk = HASHED.exec(base);
        if (!chunk) continue;
        const [, family, hash] = chunk;
        const key = `${family} (${format})`;
        if (!hashes.has(key)) hashes.set(key, new Map());
        const byHash = hashes.get(key);
        // A Set: one file can reference the same chunk twice (an `import` for the
        // types it uses and an `export … from` for the ones it re-exports).
        if (!byHash.has(hash)) byHash.set(hash, new Set());
        byHash.get(hash).add(file);
    }
}

if (dangling.length > 0) {
    fail(
        `${dangling.length} declaration reference(s) point at a file that is not there`,
        dangling.map((entry) => `      ${entry}`).join('\n'),
    );
}

for (const [key, byHash] of hashes) {
    if (byHash.size < 2) continue;
    const detail = [...byHash]
        .map(
            ([hash, files]) =>
                `      ${key.split(' ')[0]}-${hash} ← ${[...files].sort().join(', ')}`,
        )
        .join('\n');
    fail(
        `the \`${key}\` chunk is referenced at ${byHash.size} different hashes — ` +
            `its types are duplicated, so they are unrelated to each other`,
        detail,
    );
}
