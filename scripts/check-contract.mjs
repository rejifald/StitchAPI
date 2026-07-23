#!/usr/bin/env node
// API meta-contract gate — see docs/CONTRACT.md.
//
// A RATCHET, not a hard gate. The current surface predates the contract and violates it
// in many places (that backlog is docs/CONTRACT.md §6). So this script freezes today's
// violations in scripts/contract-violations.baseline.json and fails ONLY when a NEW
// violation appears — exactly like the repo's ESLint-suppression ratchet. The gate never
// blocks unrelated work, but the surface can only get more consistent, never less.
//
//   pnpm check:contract            # check working tree against the baseline (CI/hook mode)
//   node scripts/check-contract.mjs --list     # print every current violation, grouped
//   node scripts/check-contract.mjs --update    # rewrite the baseline to the current set
//
// Rules are intentionally HIGH-PRECISION source-text checks (no TS type info), so a flagged
// line is a real violation, not a guess. Shape-diffing (full P9), duration-type conformance,
// and default-value inversion (P8) need the TS checker and are deferred to a type-aware phase.
import {
    existsSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = join(ROOT, 'packages');
const BASELINE = join(ROOT, 'scripts', 'contract-violations.baseline.json');

// ---- the published surface ------------------------------------------------
// Every packages/* whose manifest is not `private: true`. Those are the consumer-facing
// contracts the meta-contract governs; private tooling (eval-harness, sandbox-sim, …) is out.
function publishedPackages() {
    const out = [];
    for (const dir of readdirSync(PKGS)) {
        const manifest = join(PKGS, dir, 'package.json');
        if (!existsSync(manifest)) continue;
        let pkg;
        try {
            pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        } catch {
            continue;
        }
        if (pkg.private === true) continue;
        if (!existsSync(join(PKGS, dir, 'src'))) continue;
        out.push({ dir, name: pkg.name });
    }
    return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

function tsFiles(root) {
    const out = [];
    const walk = (d) => {
        for (const e of readdirSync(d)) {
            const p = join(d, e);
            const s = statSync(p);
            if (s.isDirectory()) walk(p);
            else if (
                /\.tsx?$/.test(e) &&
                !/\.d\.ts$/.test(e) &&
                !/\.(spec|test)\.tsx?$/.test(e) &&
                !/\.generated\./.test(e)
            )
                out.push(p);
        }
    };
    walk(root);
    return out;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const rel = (p) => relative(ROOT, p);

// Brace-match an exported `interface Name { … }`; returns { name, body, index }.
function interfaceBlocks(src) {
    const blocks = [];
    const re = /\bexport\s+interface\s+([A-Za-z_]\w*)[^{]*\{/g;
    let m;
    while ((m = re.exec(src))) {
        let depth = 0;
        let j = m.index + m[0].length - 1; // sit on the opening brace
        const open = j;
        for (; j < src.length; j++) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}' && --depth === 0) {
                j++;
                break;
            }
        }
        blocks.push({
            name: m[1],
            body: src.slice(open + 1, j - 1),
            index: m.index,
            bodyStart: open + 1,
        });
    }
    return blocks;
}

// True when the declaration at `idx` is immediately preceded by a JSDoc block carrying
// `@deprecated`. A deprecated member is a known, time-boxed migration alias (P19), not an
// active violation — so the rules skip it, and a rename-under-alias clears the finding.
function deprecatedBefore(src, idx) {
    let j = idx;
    while (j > 0 && /[\s{;,(]/.test(src[j - 1])) j--; // skip whitespace + the field anchor
    if (src.slice(j - 2, j) !== '*/') return false; // must sit right after a comment
    const open = src.lastIndexOf('/*', j - 2);
    return open !== -1 && /@deprecated/.test(src.slice(open, j));
}

// True when every TOP-LEVEL member of an interface body is optional (`?`) — so the bag is
// `{}`-constructible and would accept the opaque empty object at a config slot (P20). Tracks
// brace/paren depth so a nested object-literal field type doesn't read as a required member.
function isAllOptional(body) {
    let depth = 0;
    for (const line of body.split('\n')) {
        if (depth === 0) {
            const m = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*(\??)\s*[:(]/.exec(
                line,
            );
            if (m && m[2] !== '?') return false; // a required member at depth 0
        }
        for (const ch of line) {
            if (ch === '{' || ch === '(') depth++;
            else if (ch === '}' || ch === ')') depth--;
        }
    }
    return true;
}

// Names declared-and-exported in a file (declaration sites; not re-export resolution).
function exportedDeclNames(src) {
    const names = [];
    const re =
        /\bexport\s+(?:abstract\s+)?(interface|type|class|function|const)\s+([A-Za-z_]\w*)/g;
    let m;
    while ((m = re.exec(src)))
        names.push({ kind: m[1], name: m[2], index: m.index });
    return names;
}

// Identifiers a package's index.ts puts on its PUBLIC surface (direct decls + `export {…}`
// blocks, taking the post-`as` alias). `export * from` is not expanded — a known gap noted
// in CONTRACT.md §7; the watch-list (R5) is curated so this gap doesn't hide a real clash.
function indexExports(indexPath) {
    if (!existsSync(indexPath)) return new Set();
    const src = readFileSync(indexPath, 'utf8');
    const names = new Set(exportedDeclNames(src).map((d) => d.name));
    const block = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;
    let m;
    while ((m = block.exec(src))) {
        for (let part of m[1].split(',')) {
            part = part.trim().replace(/^type\s+/, '');
            if (!part) continue;
            const as = part.split(/\s+as\s+/);
            const id = (as[1] ?? as[0]).trim();
            if (/^[A-Za-z_]\w*$/.test(id)) names.add(id);
        }
    }
    return names;
}

// ---- rules ----------------------------------------------------------------
// P3 — banned consumer-input suffix. Carve-outs: the well-known StitchConfig authoring
// family, and any *Like* duck-type (P18: an adapter mirror keeps its upstream spelling).
const BANNED_SUFFIX = /(Opts|Info|Params|Config)$/;
const SUFFIX_CARVEOUT = new Set([
    'StitchConfig',
    'ResolvedStitchConfig',
    'RedactedStitchConfig',
    'SeamConfig',
    // ADR 0020: the config-slot UNION type of `StitchConfig.auth` (`AuthStrategy | AuthDescriptor`),
    // not a consumer-input `*Options` envelope — same `*Config` family as StitchConfig above.
    'AuthConfig',
    'OpenApiInfo', // mirrors the OpenAPI spec's InfoObject (P18: keep the upstream spelling)
]);
const isLike = (n) => /Like/.test(n);

// P9/P16 — identifiers that MUST be unique-by-shape across packages (a curated watch list;
// full shape-diff is the deferred type-aware phase). Flagged when ≥2 packages export one.
const UNIQUE_WATCH = new Set([
    'StitchStore',
    'RequestSeam',
    'StitchHost',
    'StitchError',
    // `StitchLike` de-listed (P9): it is two deliberate, compatible tiers, not a clash. The
    // canonical RICH shape — `(input?) => StitchCallResult<T>` (awaitable + streamable) — lives in
    // `@stitchapi/query-core` and is re-exported by the five TanStack-family bindings
    // (react/vue/solid/svelte/angular). The three stream-LESS adapters (swr/rtk-query/vercel-ai)
    // intentionally use a MINIMAL await-only `(input?) => PromiseLike<T>` duck-type — they never call
    // `.stream()`, so requiring `StitchCallResult` would wrongly reject a plain awaitable callable.
    // query-core's rich shape is assignable to the minimal one, so a real stitch satisfies both; the
    // by-name R5 proxy can't see that the difference is intentional, hence the de-list.
    // `StitchErrorLike` de-listed: the host adapters' error duck-type is now uniformly
    // named `StitchErrorLike` (`Error & { status? }`) across elysia/hono/express/fastify/nest/next —
    // one structural contract (P9). The mis-named `StitchError` duck-types (which shadowed core's
    // real `StitchError` class) were renamed here, so bare `StitchError` is now core-only.
    // `queryOptions` was watch-listed as the bare TanStack alias; the canonical
    // `stitchQueryOptions` rename (ADR 0012) is now applied to ALL five framework bindings
    // (react/vue/solid/svelte/angular), and the bare `queryOptions` survives only as a uniform
    // `@deprecated` re-export of it — no longer a competing canonical, so it is de-listed (P16).
]);

function collect() {
    const violations = [];
    const add = (rule, file, symbol, detail, line) =>
        violations.push({
            rule,
            file: rel(file),
            symbol,
            detail,
            line: line ?? null,
            key: `${rule}|${rel(file)}|${symbol}`,
        });

    const packages = publishedPackages();
    const exportsByName = new Map(); // identifier -> Set(dir)

    for (const { dir } of packages) {
        const srcRoot = join(PKGS, dir, 'src');
        for (const file of tsFiles(srcRoot)) {
            const src = readFileSync(file, 'utf8');

            // R1 — banned type-name suffix (P3). Type declarations only — a `function`/`const`
            // ending in Config (redactConfig, the ADR-0012 fromNestConfig constructor) is not
            // a consumer-input type and is out of scope.
            for (const { kind, name, index } of exportedDeclNames(src)) {
                if (kind !== 'interface' && kind !== 'type' && kind !== 'class')
                    continue;
                if (
                    BANNED_SUFFIX.test(name) &&
                    !SUFFIX_CARVEOUT.has(name) &&
                    !isLike(name) &&
                    !deprecatedBefore(src, index)
                ) {
                    add(
                        'R1',
                        file,
                        name,
                        `banned suffix on consumer type → *Options (P3)`,
                        lineOf(src, index),
                    );
                }
            }

            // R2 — ANY field carrying the `Ms` suffix (P17: ms is the house unit, so the
            // suffix is dropped EVERYWHERE — input and emitted; the unit lives in JSDoc).
            // File-level scan so it catches type-union / class fields (StitchEvent,
            // RateLimitError), not only interface bags. Anchored to a declaration position
            // ([\n{;,(] then `name?:`) so prose mentions of `…Ms` in JSDoc don't match.
            // Deduped by field name per file.
            {
                const fre = /(?:^|[\n{;,(])\s*([A-Za-z_]\w*Ms)\s*\??:/g;
                const seen = new Set();
                let f;
                while ((f = fre.exec(src))) {
                    // Carve-out: an epoch *timestamp* (`*UnixMs`) keeps its unit — Unix time is
                    // conventionally SECONDS, so a bare `startUnix` would be misleading, and these
                    // mirror OTLP's `*Unix*` fields (P18). The rule targets DURATIONS, not instants.
                    if (/Unix(Ms|Nano|Seconds)$/.test(f[1])) continue;
                    if (deprecatedBefore(src, f.index)) continue; // a renamed-under-alias field
                    if (seen.has(f[1])) continue;
                    seen.add(f[1]);
                    add(
                        'R2',
                        file,
                        f[1],
                        `duration field carries Ms suffix → drop it (ms is the house unit; P17)`,
                        lineOf(src, f.index),
                    );
                }
            }

            const blocks = interfaceBlocks(src);
            for (const blk of blocks) {
                // R3 — function-typed `key` (P6: a derivation fn must be `keyOf`)
                const keyM = /(^|\n)\s*key\s*\??:\s*\(/.exec(blk.body);
                if (
                    keyM &&
                    !deprecatedBefore(src, blk.bodyStart + keyM.index)
                ) {
                    add(
                        'R3',
                        file,
                        `${blk.name}.key`,
                        `function-typed key → rename keyOf (P6)`,
                        lineOf(src, blk.bodyStart + keyM.index),
                    );
                }
                // R4 — `scope: 'stitch'|'host'` overloads the tenancy word (P2: rename to pool)
                const scopeM = /(^|\n)\s*scope\s*\??:\s*'(stitch|host)'/.exec(
                    blk.body,
                );
                if (
                    scopeM &&
                    !deprecatedBefore(src, blk.bodyStart + scopeM.index)
                ) {
                    add(
                        'R4',
                        file,
                        `${blk.name}.scope`,
                        `pool axis named scope → rename pool (P2)`,
                        lineOf(src, blk.bodyStart + scopeM.index),
                    );
                }
            }

            // R6 — a StitchConfig capability slot typed as a bare all-optional `*Options` bag
            // accepts the opaque empty object `{}` (P20). The fix is `Scalar | AtLeastOne<Options>`
            // so the all-defaults case is a scalar and `{}` is a compile error.
            const allOptional = new Set(
                blocks.filter((b) => isAllOptional(b.body)).map((b) => b.name),
            );
            const cfgBlock = blocks.find((b) => b.name === 'StitchConfig');
            if (cfgBlock) {
                const fre = /(?:^|\n)\s*([A-Za-z_]\w*)\??:\s*([A-Z]\w*)\s*;/g;
                let f6;
                while ((f6 = fre.exec(cfgBlock.body))) {
                    if (allOptional.has(f6[2]))
                        add(
                            'R6',
                            file,
                            `StitchConfig.${f6[1]}`,
                            `all-optional ${f6[2]} accepts {} → Scalar|AtLeastOne<${f6[2]}> (P20)`,
                            lineOf(src, cfgBlock.bodyStart),
                        );
                }
            }
        }

        for (const id of indexExports(join(srcRoot, 'index.ts'))) {
            if (!exportsByName.has(id)) exportsByName.set(id, new Set());
            exportsByName.get(id).add(dir);
        }
    }

    // R5 — watch-listed identifier exported by ≥2 published packages (P9/P16)
    for (const [id, dirs] of exportsByName) {
        if (UNIQUE_WATCH.has(id) && dirs.size > 1) {
            add(
                'R5',
                join(PKGS, '<multiple>'),
                id,
                `exported by ${[...dirs].sort().join(', ')} — must be unique-by-shape (P9/P16)`,
                null,
            );
        }
    }

    return violations.sort((a, b) => a.key.localeCompare(b.key));
}

// ---- ratchet --------------------------------------------------------------
const args = new Set(process.argv.slice(2));
const current = collect();
const currentKeys = new Set(current.map((v) => v.key));

if (args.has('--list')) {
    const byRule = {};
    for (const v of current) (byRule[v.rule] ??= []).push(v);
    for (const rule of Object.keys(byRule).sort()) {
        console.log(`\n${rule} (${byRule[rule].length}):`);
        for (const v of byRule[rule])
            console.log(
                `  ${v.file}${v.line ? `:${v.line}` : ''}  ${v.symbol} — ${v.detail}`,
            );
    }
    console.log(`\nTotal: ${current.length} violations.`);
    process.exit(0);
}

if (args.has('--update')) {
    writeFileSync(
        BASELINE,
        JSON.stringify(
            {
                generatedBy: 'scripts/check-contract.mjs --update',
                count: current.length,
                violations: current,
            },
            null,
            4,
        ) + '\n',
    );
    console.log(`✓ Baseline rewritten: ${current.length} known violations.`);
    process.exit(0);
}

if (!existsSync(BASELINE)) {
    console.error(
        '✗ No baseline found. Run `node scripts/check-contract.mjs --update` to create it.',
    );
    process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const baseKeys = new Set((baseline.violations ?? []).map((v) => v.key));

const added = current.filter((v) => !baseKeys.has(v.key));
const fixed = [...baseKeys].filter((k) => !currentKeys.has(k));

if (fixed.length) {
    console.log(
        `\n✓ ${fixed.length} baseline violation(s) fixed — shrink the baseline with ` +
            '`node scripts/check-contract.mjs --update`:',
    );
    for (const k of fixed.sort()) console.log(`    ${k}`);
}

if (added.length) {
    console.error(
        `\n✗ ${added.length} NEW API meta-contract violation(s) (docs/CONTRACT.md):`,
    );
    for (const v of added)
        console.error(
            `    [${v.rule}] ${v.file}${v.line ? `:${v.line}` : ''}  ${v.symbol} — ${v.detail}`,
        );
    console.error(
        '\n  Fix it, or — if this is an intentional, contract-aligned change — refresh the ' +
            'baseline with `node scripts/check-contract.mjs --update` and commit it.',
    );
    process.exit(1);
}

console.log(
    `✓ API meta-contract: no new violations (${baseKeys.size} known, baselined).`,
);
