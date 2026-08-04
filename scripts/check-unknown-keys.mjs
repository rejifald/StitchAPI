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
// This gate is the RATCHET that keeps it closed, in two rules — the same shape as the API
// meta-contract ratchet in check-contract.mjs, where a decision must be made deliberately rather
// than by omission. Both record their exceptions in scripts/unknown-keys.baseline.json WITH A
// REASON:
//
//   RULE 1 (surfaces) — every generic-inferred option bag must carry a guard or be baselined.
//   RULE 2 (nested)   — every house envelope reachable from a guarded bag (`StitchConfig` and
//                       the four that intersect it) must appear in the `NestedEnvelopes` table in
//                       packages/core/src/types.ts, or be baselined.
//                       The suppression is depth-independent, but the FIX cannot be: see the
//                       rule-2 block below for why the table is explicit rather than derived.
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

// ---- rule 2: nested house envelopes ---------------------------------------
// Same bug class, one layer down, and the one that stayed open longest because it LOOKED closed.
// `const C` is inferred from the whole config object, so a nested envelope is no more a fresh
// literal than the root is — excess-property checking is suppressed at every depth:
//
//     stitch({ circuit: { failures: 1, cooldown: '30s', totalNonsense: 1 } })   // no error
//
// (The type test that used to "pin" nested coverage passed only because its case carried no valid
// sibling, so weak-type detection rejected it — an attribution error, not coverage.)
//
// `NoUnknownNestedKeys` closes it over an EXPLICIT table, `NestedEnvelopes` in types.ts. Explicit
// because a walk derived from `StitchConfig[K]` is not merely more expensive but WRONG: `output`
// takes a `SchemaLike`, whose Zod arm is the phantom `{ _output: unknown }`, so a derived walk
// reports `safeParse` on a real `z.object(…)` as a misspelling. Same for the pluggable seams
// (`adapter`/`store`/`clock`/`trace`/`kind`/`auth`), where unknown keys are the extension point.
//
// A hand-maintained table goes stale by omission, which is exactly what a ratchet is for: this rule
// walks `StitchConfig` and every interface the table already covers, and flags any field that names
// a house option bag but has no table entry.
const CORE_TYPES = join(ROOT, 'packages', 'core', 'src', 'types.ts');

// A house envelope by NAME. Deliberately suffix-based, like the rules above: it admits exactly the
// `…Options` / `…Schemas` bags this repo authors and never matches the duck-typed slots
// (`SchemaLike`, `Adapter`, `Clock`, `StitchStore`, `TraceSink`, `AuthStrategy`, `Surface`,
// `DriftSpec`), which must NOT be walked. `Hooks` predates the suffix system and is listed by hand.
const ENVELOPE_NAME = /\b([A-Z]\w*(?:Options|Schemas))\b/g;
const EXTRA_ENVELOPES = new Set(['Hooks']);

const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// Split `s` on `sep` seen at nesting depth 0. `=>` is masked first: its `>` would otherwise read as
// a closing bracket and drive the depth negative on every function-valued field (`keyOf`, `next`).
function splitTop(s, sep) {
    const text = s.replace(/=>/g, '__');
    const out = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if ('<([{'.includes(ch)) depth++;
        else if ('>)]}'.includes(ch)) depth--;
        if (ch === sep && depth === 0) {
            out.push(cur);
            cur = '';
        } else cur += s[i];
    }
    out.push(cur);
    return out.map((p) => p.trim()).filter(Boolean);
}

function interfaceBody(text, name) {
    const re = new RegExp(
        String.raw`(?:export\s+)?interface\s+${name}\s*(?:extends[^{]+)?\{`,
    );
    const m = re.exec(text);
    if (!m) return null;
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
    }
    return text.slice(m.index + m[0].length, i - 1);
}

const fieldsOf = (body, sep = ';') =>
    splitTop(body, sep)
        .map((f) => /^(\w+)\??\s*:\s*([\s\S]+)$/.exec(f))
        .filter(Boolean)
        .map((m) => ({ name: m[1], type: norm(m[2]) }));

// `[Bag, 'Bag', object]` or `[Bag, 'Bag', { slot: [...] }]` → { type, children }.
function parseNode(txt) {
    const parts = splitTop(
        txt.trim().replace(/^\[/, '').replace(/\]$/, ''),
        ',',
    );
    const kidsTxt = parts.slice(2).join(',').trim();
    const children = {};
    if (kidsTxt.startsWith('{'))
        for (const f of fieldsOf(kidsTxt.slice(1, -1), ','))
            children[f.name] = parseNode(f.type);
    return { type: parts[0], children };
}

// The declared members of `name`, whichever form it takes: an `interface`, or a `type` alias whose
// right-hand side intersects an object literal (`type LlmOptions = Partial<Omit<StitchConfig, …>> &
// { provider: … }`). For the alias form only the LITERAL members are returned — the
// `Partial<StitchConfig>` half is reached by walking `StitchConfig` itself, so returning it again
// would double-report every envelope against a second owner.
function declBody(text, name) {
    const iface = interfaceBody(text, name);
    if (iface !== null) return iface;
    const m = new RegExp(String.raw`type\s+${name}\s*=`).exec(text);
    if (!m) return null;
    const { text: rhs } = spanTo(text, m.index + m[0].length, ';', 20000);
    let body = '';
    for (let i = 0; i < rhs.length; i++) {
        if (rhs[i] !== '{') continue;
        let depth = 1;
        let j = i + 1;
        for (; j < rhs.length && depth > 0; j++) {
            if (rhs[j] === '{') depth++;
            else if (rhs[j] === '}') depth--;
        }
        body += rhs.slice(i + 1, j - 1) + ';';
        i = j - 1;
    }
    return body || null;
}

// The bag types every guarded/baselined surface infers into — `Partial<StitchConfig>`,
// `LlmOptions`, `RequestOptions`… Each is a ROOT the nested walk must start from: they intersect
// `Partial<Omit<StitchConfig, …>>` and then ADD their own fields, and a house envelope added there
// would be just as unguarded as one added to `StitchConfig`, but invisible to a StitchConfig-only
// walk. Type parameters (`Partial<TIn>`) are not resolvable to a declaration and are skipped.
function rootBagsFrom(sites) {
    const names = new Set(['StitchConfig']);
    for (const s of sites)
        for (const m of s.constraint.matchAll(
            /\b([A-Z]\w*(?:Config|Options))\b/g,
        ))
            names.add(m[1]);
    return [...names];
}

function collectNested(rule1Sites) {
    const raw = readFileSync(CORE_TYPES, 'utf8');
    const text = stripComments(raw);
    const table = interfaceBody(text, 'NestedEnvelopes');
    if (!table)
        return {
            sites: [],
            error: 'NestedEnvelopes table not found in packages/core/src/types.ts',
        };

    const root = {};
    for (const f of fieldsOf(table)) root[f.name] = parseNode(f.type);

    // Every scanned source, so a root bag declared outside types.ts (`LlmOptions` in llm.ts, the
    // postmessage bags in postmessage.ts) resolves.
    const corpus = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r))).map((f) => ({
        file: relative(ROOT, f).split('\\').join('/'),
        raw: readFileSync(f, 'utf8'),
    }));
    const findDecl = (name) => {
        for (const c of corpus) {
            const body = declBody(stripComments(c.raw), name);
            if (body !== null) return { body, file: c.file, raw: c.raw };
        }
        return null;
    };

    const sites = [];
    const seen = new Set();
    // Each root bag against the table, then each covered envelope against its own children.
    const queue = rootBagsFrom(rule1Sites).map((owner) => ({
        owner,
        node: { children: root },
        path: '',
    }));
    while (queue.length) {
        const { owner, node, path } = queue.shift();
        if (seen.has(owner)) continue;
        seen.add(owner);
        const decl = findDecl(owner);
        if (!decl) continue;
        const body = decl.body;
        for (const field of fieldsOf(body)) {
            const bags = [...field.type.matchAll(ENVELOPE_NAME)]
                .map((m) => m[1])
                .concat(
                    [...EXTRA_ENVELOPES].filter((n) =>
                        new RegExp(String.raw`\b${n}\b`).test(field.type),
                    ),
                );
            if (!bags.length) continue;
            // Key by OWNER too: the same slot name on two roots is two places to keep in sync, and
            // a baseline entry for one must not silently discharge the other.
            const at = path
                ? `${path}.${field.name}`
                : `${owner}.${field.name}`;
            const child = node.children[field.name];
            sites.push({
                key: at,
                owner,
                slot: field.name,
                bag: bags[0],
                file: decl.file,
                line: lineOf(decl.raw, decl.raw.indexOf(owner)),
                covered: Boolean(child),
            });
            if (child) queue.push({ owner: child.type, node: child, path: at });
        }
    }
    return { sites: sites.sort((a, b) => a.key.localeCompare(b.key)) };
}

// ---- ratchet --------------------------------------------------------------
const args = new Set(process.argv.slice(2));
const sites = collect();
const nested = collectNested(sites);
const nestedUncovered = (nested.sites ?? []).filter((s) => !s.covered);
const nestedCovered = (nested.sites ?? []).filter((s) => s.covered);
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

    console.log(`\nNESTED — IN THE TABLE (${nestedCovered.length}):`);
    for (const s of nestedCovered)
        console.log(`  ✓ ${s.key}  → ${s.bag}  (on ${s.owner})`);
    console.log(`\nNESTED — NOT IN THE TABLE (${nestedUncovered.length}):`);
    for (const s of nestedUncovered)
        console.log(`  · ${s.key}  → ${s.bag}  (on ${s.owner})`);
    console.log(
        `\nTotal: ${(nested.sites ?? []).length} house-envelope slots reachable from a guarded bag.`,
    );
    process.exit(0);
}

if (args.has('--update')) {
    const prior = existsSync(BASELINE)
        ? JSON.parse(readFileSync(BASELINE, 'utf8'))
        : { allowed: [] };
    const reasons = new Map(
        (prior.allowed ?? []).map((a) => [a.key, a.reason]),
    );
    const nestedReasons = new Map(
        (prior.allowedNested ?? []).map((a) => [a.key, a.reason]),
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
                nestedNote:
                    'House-envelope slots reachable from a guarded option bag that are deliberately ABSENT from the `NestedEnvelopes` table in packages/core/src/types.ts, and so get no nested unknown-key rejection. Same rule: every entry needs a `reason`.',
                nestedCount: nestedUncovered.length,
                allowedNested: nestedUncovered.map((s) => ({
                    key: s.key,
                    bag: s.bag,
                    reason:
                        nestedReasons.get(s.key) ??
                        'TODO: add this slot to `NestedEnvelopes`, or state why it must stay open.',
                })),
            },
            null,
            4,
        ) + '\n',
    );
    console.log(
        `✓ Baseline rewritten: ${unguarded.length} allowed unguarded site(s), ` +
            `${nestedUncovered.length} allowed un-tabled nested slot(s).`,
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

// ---- rule 2 gate ----------------------------------------------------------
if (nested.error) {
    console.error(`\n✗ ${nested.error}`);
    console.error(
        '  The nested rule reads that table to know which envelopes are covered. If it was ' +
            'renamed, update CORE_TYPES/`NestedEnvelopes` here to match.',
    );
    process.exit(1);
}

const allowedNested = new Map(
    (baseline.allowedNested ?? []).map((a) => [a.key, a.reason]),
);
const nestedAdded = nestedUncovered.filter((s) => !allowedNested.has(s.key));
const nestedStale = [...allowedNested.keys()].filter(
    (k) => !nestedUncovered.some((s) => s.key === k),
);
const nestedUnreasoned = [...allowedNested.entries()].filter(
    ([, reason]) => !reason || /^TODO/i.test(reason),
);

if (nestedStale.length) {
    console.log(
        `\n✓ ${nestedStale.length} nested baseline entr(ies) now covered by the table — shrink it ` +
            'with `node scripts/check-unknown-keys.mjs --update`:',
    );
    for (const k of nestedStale.sort()) console.log(`    ${k}`);
}

if (nestedUnreasoned.length) {
    console.error(
        `\n✗ ${nestedUnreasoned.length} nested baseline entr(ies) have no reason recorded:`,
    );
    for (const [k] of nestedUnreasoned) console.error(`    ${k}`);
    process.exit(1);
}

if (nestedAdded.length) {
    console.error(
        `\n✗ ${nestedAdded.length} house-envelope slot(s) reachable from a guarded option bag with no ` +
            '`NestedEnvelopes` entry — a misspelled or removed key inside them will typecheck and ' +
            'be silently dropped:',
    );
    for (const s of nestedAdded)
        console.error(`    ${s.key}  → ${s.bag}  (on ${s.owner})`);
    console.error(
        '\n  Add the slot to `NestedEnvelopes` (packages/core/src/types.ts) as ' +
            "`slot: [Bag, 'Bag', object]` — or, if the bag is deliberately open (a pluggable seam, " +
            'a foreign object), baseline it with `node scripts/check-unknown-keys.mjs --update` and ' +
            'record a reason.',
    );
    process.exit(1);
}

console.log(
    `✓ Unknown-key guards: ${guarded.length} guarded, ` +
        `${allowed.size} allowed unguarded (baselined).`,
);
console.log(
    `✓ Nested house envelopes: ${nestedCovered.length} in the table, ` +
        `${allowedNested.size} allowed un-tabled (baselined).`,
);
