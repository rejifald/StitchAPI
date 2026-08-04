#!/usr/bin/env node
// Unknown-key guard gate — the excess-property-check (EPC) suppression bug class.
//
// An authoring surface that infers `const C` from its option-bag argument gets NO
// excess-property checking: the literal is compared against a `C` just inferred from it, so no
// property is ever "excess", and the `C extends …Options` constraint is then verified by ordinary
// assignability, which ignores freshness. The result is that a misspelled or REMOVED slot
// typechecks and is silently dropped at runtime:
//
//     stitch({ path: '/x', timeut: 500 })   // no error without a guard
//
// That is what makes a slot rename unsafe — every call site still authoring the old spelling keeps
// compiling (#591: 2 files found by typechecking, 30 by running the suite). The fix is to intersect
// the parameter with `NoUnknownKeys<C, Allowed, What>` (packages/core/src/types.ts), which maps
// `Exclude<keyof C, keyof Allowed>` onto a `ConfigError` brand naming the key.
//
// This gate is the RATCHET that keeps it closed: every generic-inferred option bag must either
// carry a guard or be listed in scripts/unknown-keys.baseline.json WITH A REASON. A new unguarded
// surface fails the build, so the decision is made deliberately rather than by omission — the same
// shape as the API meta-contract ratchet in check-contract.mjs.
//
//   pnpm check:unknown-keys                        # check the working tree (CI/hook mode)
//   node scripts/check-unknown-keys.mjs --list     # print every site, guarded and not
//   node scripts/check-unknown-keys.mjs --update   # rewrite the baseline to the current set
//
// HIGH-PRECISION by design, like check-contract.mjs's rules: a flagged line is a real
// generic-inferred option bag, not a guess. The scan matches a type-parameter constraint naming a
// `…Config`/`…Options` type or a `Partial<…>` of one, which is what every authored option bag in
// this repo looks like. Deliberately NOT flagged, because they are a different shape and the
// distinction was verified by probe rather than assumed:
//
//   • `S extends StitchLike<…>` (react/vue/solid/svelte/angular/swr/query-core/rtk-query/
//     vercel-ai) — the generic binds the STITCH argument, a function, not an option literal. Those
//     hooks' options bags are separate NON-generic parameters, so they keep ordinary EPC.
//   • `M extends Record<string, Member>` (`all()`'s named-bag form) — an index-signature
//     constraint whose keys are caller-chosen, so there is no fixed vocabulary to misspell.
//   • unconstrained/value generics (`T extends NonNullable<unknown>` in util.ts,
//     `K extends keyof …`, `S extends SchemaLike`) — internal helpers over already-typed values.
//
// `test/` and `test-d/` are skipped: they author bad configs on purpose.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'scripts', 'unknown-keys.baseline.json');

const SCAN_ROOTS = ['packages', 'apps'];
const SKIP_DIRS = new Set([
    'node_modules',
    'lib',
    'dist',
    'build',
    '.next',
    '.turbo',
    'test',
    'test-d',
    'coverage',
]);
const EXTS = ['.ts', '.tsx', '.mts', '.cts'];

// The guards that discharge a site. `NoUnknownConfigKeys` is the `StitchConfig` binding of
// `NoUnknownKeys`; both count.
const GUARDS = ['NoUnknownKeys', 'NoUnknownConfigKeys'];

// A constraint naming an authored option bag: a `…Config`/`…Options` type, or a `Partial<…>` of
// one. `Partial<` also catches `Stitch.with`'s `Partial<TIn>`, which is the same bug class on the
// call-input side and is baselined with its reason rather than hidden from the scan.
const OPTION_BAG = /Config\b|Options\b|Partial</;

function walk(dir, out = []) {
    let entries;
    try {
        entries = readdirSync(dir);
    } catch {
        return out;
    }
    for (const name of entries) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
        const full = join(dir, name);
        let st;
        try {
            st = statSync(full);
        } catch {
            continue;
        }
        if (st.isDirectory()) walk(full, out);
        else if (
            EXTS.some((e) => name.endsWith(e)) &&
            !name.endsWith('.d.ts') &&
            !name.includes('.generated.')
        )
            out.push(full);
    }
    return out;
}

// Read a balanced span starting at `pos`, stopping at any char in `stopAt` seen at depth 0.
function spanTo(text, pos, stopAt, limit = 4000) {
    let depth = 0;
    let i = pos;
    const end = Math.min(text.length, pos + limit);
    for (; i < end; i++) {
        const ch = text[i];
        if ('<([{'.includes(ch)) depth++;
        else if ('>)]}'.includes(ch)) {
            if (depth === 0) break;
            depth--;
        } else if (depth === 0 && stopAt.includes(ch)) break;
    }
    return { text: text.slice(pos, i), end: i };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

function lineOf(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++)
        if (text[i] === '\n') line++;
    return line;
}

function collect() {
    const sites = [];
    const files = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r)));

    for (const file of files.sort()) {
        const text = readFileSync(file, 'utf8');
        const rel = relative(ROOT, file).split('\\').join('/');

        // Every type parameter declared with an `extends` constraint, in source order.
        const decls = [];
        const declRe = /[<,]\s*(?:const\s+)?([A-Z]\w*)\s+extends\s+/g;
        for (let m; (m = declRe.exec(text));) {
            const { text: raw } = spanTo(text, m.index + m[0].length, ',=');
            decls.push({ pos: m.index, name: m[1], constraint: norm(raw) });
        }
        if (!decls.length) continue;

        const names = new Set(decls.map((d) => d.name));
        const seen = new Map(); // key -> occurrence ordinal

        // A parameter whose declared type is that type parameter (bare or intersected).
        for (const name of names) {
            const useRe = new RegExp(
                String.raw`(?:\(|,|^)\s*(\w+)(\??):\s*(` +
                    name +
                    String.raw`)\s*(?=[&,)\n])`,
                'gm',
            );
            for (let m; (m = useRe.exec(text));) {
                // The nearest PRECEDING declaration of this name owns this use.
                const owner = decls
                    .filter((d) => d.name === name && d.pos <= m.index)
                    .pop();
                if (!owner || !OPTION_BAG.test(owner.constraint)) continue;

                // The parameter's full declared type — up to the `,`/`)` that ends this parameter.
                const typeStart = m.index + m[0].indexOf(m[3]);
                const { text: paramType } = spanTo(text, typeStart, ',');
                const guarded = GUARDS.some((g) => paramType.includes(g));

                const base = `${rel}:${name}:${owner.constraint}:${m[1]}`;
                const n = (seen.get(base) ?? 0) + 1;
                seen.set(base, n);

                sites.push({
                    key: `${base}#${n}`,
                    file: rel,
                    line: lineOf(text, m.index),
                    param: m[1],
                    typeParam: name,
                    constraint: owner.constraint,
                    guarded,
                });
            }
        }
    }
    return sites.sort((a, b) => a.key.localeCompare(b.key));
}

// ---- ratchet --------------------------------------------------------------
const args = new Set(process.argv.slice(2));
const sites = collect();
const unguarded = sites.filter((s) => !s.guarded);
const guarded = sites.filter((s) => s.guarded);

if (args.has('--list')) {
    console.log(`\nGUARDED (${guarded.length}):`);
    for (const s of guarded)
        console.log(
            `  ✓ ${s.file}:${s.line}  ${s.param}: <${s.typeParam} extends ${s.constraint}>`,
        );
    console.log(`\nUNGUARDED (${unguarded.length}):`);
    for (const s of unguarded)
        console.log(
            `  · ${s.file}:${s.line}  ${s.param}: <${s.typeParam} extends ${s.constraint}>`,
        );
    console.log(`\nTotal: ${sites.length} generic-inferred option bags.`);
    process.exit(0);
}

if (args.has('--update')) {
    const prior = existsSync(BASELINE)
        ? JSON.parse(readFileSync(BASELINE, 'utf8'))
        : { allowed: [] };
    const reasons = new Map(
        (prior.allowed ?? []).map((a) => [a.key, a.reason]),
    );
    writeFileSync(
        BASELINE,
        JSON.stringify(
            {
                generatedBy: 'scripts/check-unknown-keys.mjs --update',
                note: 'Generic-inferred option bags that are deliberately UNGUARDED. Every entry needs a `reason` — a bare TODO is not one. Guarded surfaces are not listed; they need no exception.',
                count: unguarded.length,
                allowed: unguarded.map((s) => ({
                    key: s.key,
                    file: s.file,
                    reason:
                        reasons.get(s.key) ??
                        'TODO: state why this bag is safe unguarded, or guard it.',
                })),
            },
            null,
            4,
        ) + '\n',
    );
    console.log(
        `✓ Baseline rewritten: ${unguarded.length} allowed unguarded site(s).`,
    );
    process.exit(0);
}

if (!existsSync(BASELINE)) {
    console.error(
        '✗ No baseline found. Run `node scripts/check-unknown-keys.mjs --update` to create it.',
    );
    process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const allowed = new Map((baseline.allowed ?? []).map((a) => [a.key, a.reason]));

const added = unguarded.filter((s) => !allowed.has(s.key));
const stale = [...allowed.keys()].filter(
    (k) => !unguarded.some((s) => s.key === k),
);
const unreasoned = [...allowed.entries()].filter(
    ([, reason]) => !reason || /^TODO/i.test(reason),
);

if (stale.length) {
    console.log(
        `\n✓ ${stale.length} baseline entr(ies) no longer unguarded — shrink the baseline with ` +
            '`node scripts/check-unknown-keys.mjs --update`:',
    );
    for (const k of stale.sort()) console.log(`    ${k}`);
}

if (unreasoned.length) {
    console.error(
        `\n✗ ${unreasoned.length} baseline entr(ies) have no reason recorded:`,
    );
    for (const [k] of unreasoned) console.error(`    ${k}`);
    console.error(
        '\n  Every allowed exception must say why it is safe unguarded. Fill in `reason`.',
    );
    process.exit(1);
}

if (added.length) {
    console.error(
        `\n✗ ${added.length} NEW unguarded generic-inferred option bag(s) — a misspelled or ` +
            'removed slot there will typecheck and be silently dropped:',
    );
    for (const s of added)
        console.error(
            `    ${s.file}:${s.line}  ${s.param}: <${s.typeParam} extends ${s.constraint}>`,
        );
    console.error(
        "\n  Intersect the parameter with `NoUnknownKeys<C, YourOptions, 'YourOptions'>` " +
            '(packages/core/src/types.ts) — or, if the bag is deliberately open, baseline it with ' +
            '`node scripts/check-unknown-keys.mjs --update` and record a reason.',
    );
    process.exit(1);
}

console.log(
    `✓ Unknown-key guards: ${guarded.length} guarded, ` +
        `${allowed.size} allowed unguarded (baselined).`,
);
