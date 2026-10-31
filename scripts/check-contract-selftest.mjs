#!/usr/bin/env node
// Self-test for the R12 gate (docs/CONTRACT.md P26) — run by `pnpm check:contract` after the gate.
//
// R12 is a source-text scanner, and a scanner that is wrong in the quiet direction is the worst kind:
// it passes. So this builds a miniature repository in a temp dir, proves the gate is green on it,
// then applies one MUTATION at a time and proves the gate goes red with the right finding. A mutation
// that stops failing means the rule has gone vacuous.
//
// It drives the real script as a child process (`CHECK_CONTRACT_ROOT` points it at the fixture), so
// what is tested is exactly what CI runs — flags, exit codes and all.
import { spawnSync } from 'node:child_process';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(
    dirname(fileURLToPath(import.meta.url)),
    'check-contract.mjs',
);

const TAG = '/**\n * @experimental\n */\n';
const pkgJson = (name, exportsMap) =>
    JSON.stringify({ name, version: '1.0.0', exports: exportsMap });
const entry = (base) => ({
    import: { types: `./lib/${base}.d.mts`, default: `./lib/${base}.mjs` },
});
const table = (...rows) =>
    [
        '<!-- R12 members: fixture -->',
        '',
        '| Surface | Why | Since |',
        '| --- | --- | --- |',
        ...rows.map((r) => `| \`${r}\` | fixture | 1.0.0 |`),
        '',
        '<!-- /R12 members -->',
        '',
    ].join('\n');

// The fixture: core with an experimental subpath (`stitchapi/llm`), an experimental package
// (`@stitchapi/shell`) and one stable package (`@stitchapi/react`). Every file is the smallest thing
// that makes the gate meaningful; the overloads include one whose return type is an object literal,
// which is the shape a naive "ends in `;`" scan gets wrong.
const base = () => ({
    'docs/CONTRACT.md': table('stitchapi/llm', '@stitchapi/shell'),
    'scripts/contract-violations.baseline.json':
        '{"generatedBy":"fixture","count":0,"violations":[]}\n',
    'packages/core/package.json': pkgJson('stitchapi', {
        '.': entry('index'),
        './llm': entry('llm'),
    }),
    'packages/core/src/index.ts': "export { stitch } from './stitch';\n",
    'packages/core/src/stitch.ts': 'export const stitch = (): number => 1;\n',
    'packages/core/src/llm.ts': [
        TAG + 'export interface LlmMessage {\n    role: string;\n}\n',
        TAG + 'export function pick(a: string): { ok: true };',
        TAG + 'export function pick(a: number): { ok: false };',
        'export function pick(a: unknown): { ok: boolean } {',
        "    return { ok: typeof a === 'string' };",
        '}\n',
    ].join('\n'),
    'packages/shell/package.json': pkgJson('@stitchapi/shell', {
        '.': entry('index'),
    }),
    'packages/shell/src/index.ts': `${TAG}export const shell = (): number => 1;\n`,
    'packages/react/package.json': pkgJson('@stitchapi/react', {
        '.': entry('index'),
    }),
    'packages/react/src/index.ts': 'export const useThing = (): number => 1;\n',
});

const cases = [];
const gate = (
    name,
    mutate,
    { code = 1, includes = [], args = [], also } = {},
) => cases.push({ name, mutate, code, includes, args, also });
const edit = (files, path, fn) => {
    files[path] = fn(files[path]);
};

// ---- the fixture itself must be green --------------------------------------
gate('the unmutated fixture passes', () => {}, { code: 0 });

// ---- (a) every public declaration carries the tag --------------------------
gate(
    'a plain export without the tag fails',
    (f) => edit(f, 'packages/shell/src/index.ts', (s) => s.replace(TAG, '')),
    { includes: ['without @experimental'] },
);
gate(
    'an overload tagged only on its FIRST signature fails on the second',
    (f) =>
        edit(f, 'packages/core/src/llm.ts', (s) =>
            s.replace(
                `${TAG}export function pick(a: number)`,
                'export function pick(a: number)',
            ),
        ),
    { includes: ['pick (overload 2 of 2)', 'lacks @experimental'] },
);
gate(
    'an overload tagged only on a LATER signature fails on the first',
    (f) =>
        edit(f, 'packages/core/src/llm.ts', (s) =>
            s.replace(
                `${TAG}export function pick(a: string)`,
                'export function pick(a: string)',
            ),
        ),
    { includes: ['pick (overload 1 of 2)', 'lacks @experimental'] },
);
gate(
    'a tag only on the IMPLEMENTATION signature does not count',
    (f) =>
        edit(f, 'packages/core/src/llm.ts', (s) =>
            s
                .replace(
                    `${TAG}export function pick(a: string)`,
                    'export function pick(a: string)',
                )
                .replace(
                    `${TAG}export function pick(a: number)`,
                    'export function pick(a: number)',
                )
                .replace(
                    'export function pick(a: unknown)',
                    `${TAG}export function pick(a: unknown)`,
                ),
        ),
    { includes: ['lacks @experimental'] },
);
gate(
    'an untagged symbol behind `export *` fails',
    (f) => {
        f['packages/shell/src/index.ts'] = "export * from './more';\n";
        f['packages/shell/src/more.ts'] =
            'export const hidden = (): number => 1;\n';
    },
    { includes: ['hidden', 'without @experimental'] },
);
gate(
    'the same barrel passes once the symbol is tagged',
    (f) => {
        f['packages/shell/src/index.ts'] = "export * from './more';\n";
        f['packages/shell/src/more.ts'] =
            `${TAG}export const hidden = (): number => 1;\n`;
    },
    { code: 0 },
);
gate(
    'a re-export of another package symbol fails',
    (f) => {
        f['packages/shell/src/index.ts'] =
            "export { useThing } from '@stitchapi/react';\n";
    },
    { includes: ['re-exports `useThing`'] },
);

// ---- second entry points ----------------------------------------------------
const withExtra = (f, src) => {
    f['packages/shell/package.json'] = pkgJson('@stitchapi/shell', {
        '.': entry('index'),
        './extra': entry('extra'),
    });
    f['packages/shell/src/extra.ts'] = src;
};
gate(
    'an untagged symbol behind a SECOND entry point fails',
    (f) => withExtra(f, 'export const extra = (): number => 1;\n'),
    { includes: ['extra', 'without @experimental'] },
);
gate(
    'a tagged second entry point passes',
    (f) => withExtra(f, `${TAG}export const extra = (): number => 1;\n`),
    { code: 0 },
);
gate(
    'an `exports` key R12 cannot read fails instead of being skipped',
    (f) => {
        f['packages/shell/package.json'] = pkgJson('@stitchapi/shell', {
            '.': entry('index'),
            './extra': './lib/*.js',
        });
    },
    { includes: ['maps to no source file'] },
);

// ---- (b) the tag is held to the table, in both directions ------------------
gate(
    'a tag on a stable symbol fails',
    (f) => edit(f, 'packages/react/src/index.ts', (s) => TAG + s),
    { includes: ['no P26 member exports'] },
);
gate(
    'a tag on a class member fails',
    (f) =>
        edit(
            f,
            'packages/core/src/stitch.ts',
            () =>
                'export class A {\n    /**\n     * @experimental\n     */\n    m = 1;\n}\n',
        ),
    { includes: ['@experimental'] },
);
gate(
    'dropping a member row orphans its tags',
    (f) => {
        f['docs/CONTRACT.md'] = table('stitchapi/llm');
    },
    { includes: ['no P26 member exports'] },
);
gate(
    'a typo in a member row fails',
    (f) => {
        f['docs/CONTRACT.md'] = table('stitchapi/llm', '@stitchapi/shel');
    },
    { includes: ['resolves to no entry point'] },
);
gate(
    'removing the table markers fails',
    (f) => {
        f['docs/CONTRACT.md'] = '# no table here\n';
    },
    { includes: ['no member table found'] },
);

// ---- (c) the tier's edge: stable files do not import a member --------------
gate(
    'a stable barrel re-exporting a member fails',
    (f) =>
        edit(
            f,
            'packages/core/src/index.ts',
            (s) => s + "export { pick } from './llm';\n",
        ),
    { includes: ['import of ./llm', 'MUST NOT re-export or name'] },
);
gate(
    'a stable file that only names a member type fails',
    (f) => {
        f['packages/core/src/stitch.ts'] =
            "import type { LlmMessage } from './llm';\nexport const stitch = (m?: LlmMessage): number => (m ? 1 : 2);\n";
    },
    { includes: ['import of ./llm'] },
);
gate(
    'a dynamic import of a member subpath fails',
    (f) => {
        f['packages/react/src/index.ts'] =
            "export const load = () => import('stitchapi/llm');\n";
    },
    { includes: ['import of stitchapi/llm'] },
);
gate(
    'a bare import of a member package from a stable package fails',
    (f) => {
        f['packages/react/src/index.ts'] =
            "import { shell } from '@stitchapi/shell';\nexport const useThing = (): number => shell();\n";
    },
    { includes: ['import of @stitchapi/shell'] },
);
gate(
    'a member importing another member passes',
    (f) => {
        f['packages/shell/src/index.ts'] =
            `import { pick } from 'stitchapi/llm';\n${TAG}export const shell = (): boolean => pick('a').ok;\n`;
    },
    { code: 0 },
);
gate(
    'an import named only in a comment, a string or a template passes',
    (f) => {
        f['packages/react/src/index.ts'] = [
            "// import { pick } from 'stitchapi/llm';",
            'export const a = "from \'stitchapi/llm\'";',
            'export const b = `import { shell } from "@stitchapi/shell";`;',
            '',
        ].join('\n');
    },
    { code: 0 },
);

// ---- R12 is never baselined -------------------------------------------------
gate(
    '`--update` refuses to baseline an R12 finding and writes none',
    (f) => edit(f, 'packages/shell/src/index.ts', (s) => s.replace(TAG, '')),
    {
        args: ['--update'],
        includes: ['NOT baselined'],
        also: (dir) => {
            const b = JSON.parse(
                readFileSync(
                    join(dir, 'scripts/contract-violations.baseline.json'),
                    'utf8',
                ),
            );
            if (b.violations.some((v) => v.rule === 'R12'))
                throw new Error('R12 finding written into the baseline');
        },
    },
);
gate(
    'a hand-edited baseline entry does not silence an R12 finding',
    (f) => {
        edit(f, 'packages/shell/src/index.ts', (s) => s.replace(TAG, ''));
        f['scripts/contract-violations.baseline.json'] = JSON.stringify({
            count: 1,
            violations: [
                {
                    rule: 'R12',
                    key: 'R12|packages/shell/src/index.ts|shell',
                    file: 'packages/shell/src/index.ts',
                    symbol: 'shell',
                    detail: 'x',
                    line: null,
                },
            ],
        });
    },
    { includes: ['cannot be baselined'] },
);
// Every OTHER rule keeps its baseline: R7 (a `@deprecated` tag) is reported as new, and the block
// after the loop proves `--update` records it and the plain gate is then green.
gate(
    'a non-R12 finding is still reported as new',
    (f) => {
        f['packages/react/src/index.ts'] =
            '/**\n * @deprecated gone\n */\nexport const old = (): number => 1;\n';
    },
    { includes: ['[R7]'] },
);

// ---- runner -----------------------------------------------------------------
const run = (files, args) => {
    const dir = mkdtempSync(join(tmpdir(), 'check-contract-selftest-'));
    for (const [path, body] of Object.entries(files)) {
        const abs = join(dir, path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, body);
    }
    const res = spawnSync(process.execPath, [SCRIPT, ...args], {
        env: { ...process.env, CHECK_CONTRACT_ROOT: dir },
        encoding: 'utf8',
    });
    return { dir, code: res.status, out: `${res.stdout}\n${res.stderr}` };
};

const failures = [];
for (const c of cases) {
    const files = base();
    c.mutate(files);
    const r = run(files, c.args);
    try {
        if (r.code !== c.code)
            throw new Error(`exit ${r.code}, wanted ${c.code}\n${r.out}`);
        for (const needle of c.includes)
            if (!r.out.includes(needle))
                throw new Error(`output lacks "${needle}"\n${r.out}`);
        if (c.also) c.also(r.dir);
    } catch (err) {
        failures.push(`  ✗ ${c.name}: ${err.message}`);
    } finally {
        rmSync(r.dir, { recursive: true, force: true });
    }
}

// The baseline path for a non-R12 rule: `--update` records it, and the plain gate is then green.
{
    const files = base();
    files['packages/react/src/index.ts'] =
        '/**\n * @deprecated gone\n */\nexport const old = (): number => 1;\n';
    const first = run(files, ['--update']);
    try {
        const second = spawnSync(process.execPath, [SCRIPT], {
            env: { ...process.env, CHECK_CONTRACT_ROOT: first.dir },
            encoding: 'utf8',
        });
        if (first.code !== 0 || second.status !== 0)
            throw new Error(
                `update exit ${first.code}, re-check exit ${second.status}\n${first.out}\n${second.stdout}${second.stderr}`,
            );
    } catch (err) {
        failures.push(
            `  ✗ a non-R12 finding is baselined by --update: ${err.message}`,
        );
    } finally {
        rmSync(first.dir, { recursive: true, force: true });
    }
}

if (failures.length) {
    console.error(
        `✗ R12 self-test: ${failures.length} case(s) went the wrong way — the rule is no longer doing what P26 says:`,
    );
    for (const f of failures) console.error(f);
    process.exit(1);
}
console.log(
    `✓ R12 self-test: ${cases.length + 1} cases (mutations fail, the fixture and the baseline path pass).`,
);
