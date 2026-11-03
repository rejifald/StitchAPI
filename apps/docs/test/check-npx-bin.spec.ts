// Unit coverage for the bare-`stitch` runner guard (scripts/check-npx-bin.mjs, #861).
//
// The npm name `stitch` is an unrelated package; our bin ships inside `stitchapi`.
// The gate fails any tracked file that launches the bare name through a package
// runner, so docs, READMEs and the rules template `stitch init` writes into users'
// repos cannot send a reader to someone else's code. These pin what it flags, what
// it leaves alone, and the single-bin property `npx stitchapi` depends on.
//
// Fixtures are assembled from parts: the gate scans this file too, and a literal
// bad command here would fail it.
import {
    findBareStitchRunners,
    resolvesSingleBin,
} from '../../../scripts/check-npx-bin.mjs';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cmd = (runner: string, rest: string) => `${runner} ${rest}`;
const BARE = 'stit' + 'ch';

describe('findBareStitchRunners — flags the foreign package', () => {
    it.each([
        ['npx', `${BARE} init`],
        ['npx', `-y ${BARE} run getUser --id 1`],
        ['npx', `--yes ${BARE}`],
        ['npx', `${BARE}@latest init`],
        ['pnpx', `${BARE} init`],
        ['bunx', `${BARE} diagram`],
        ['bun x', `${BARE} diagram`],
        ['pnpm dlx', `${BARE} init`],
        ['yarn dlx', `${BARE} init`],
        ['npm exec', `${BARE} -- mcp`],
        ['npm x', `${BARE} init`],
        ['/usr/local/bin/npx', `${BARE} init`],
    ])('%s %s', (runner, rest) => {
        expect(findBareStitchRunners(cmd(runner, rest))).toHaveLength(1);
    });

    // `-p` / `--package` name the package npm downloads; the word after the options is
    // only a bin, so it is the flag's VALUE that decides, not the flag's presence.
    it.each([
        ['npx', `-p ${BARE} ${BARE} init`],
        ['npx', `-p ${BARE}@rc ${BARE} init`],
        ['npx', `--package ${BARE} ${BARE} init`],
        ['npx', `--package=${BARE} ${BARE} init`],
        ['npx', `--package=${BARE}@rc ${BARE} init`],
        ['npx', `-p stitchapi -p ${BARE} ${BARE} init`],
        ['npx', `-y --package="${BARE}" ${BARE} init`],
        ['pnpm dlx', `--package=${BARE} ${BARE} init`],
        ['yarn dlx', `-p ${BARE} ${BARE} init`],
        ['bunx', `-p ${BARE} ${BARE} init`],
    ])('names it as the package: %s %s', (runner, rest) => {
        expect(findBareStitchRunners(cmd(runner, rest))).toHaveLength(1);
    });

    // An option that takes a value must not be mistaken for the package.
    it.each([
        ['npx', `--registry https://registry.example.com ${BARE} init`],
        ['npx', `--registry=https://registry.example.com ${BARE} init`],
        ['npx', `--cache /tmp/npx-cache -y ${BARE} init`],
        ['npx', `--userconfig ./.npmrc ${BARE} init`],
        ['npx', `-w packages/app ${BARE} init`],
        // not in the known list, but its value looks like a URL
        ['npx', `--some-new-flag https://example.com ${BARE} init`],
        ['pnpm dlx', `--allow-build esbuild ${BARE} init`],
        ['npm exec', `--workspace app -- ${BARE} init`],
    ])('skips an option value: %s %s', (runner, rest) => {
        expect(findBareStitchRunners(cmd(runner, rest))).toHaveLength(1);
    });

    // Markdown and prose hug the command: the name is read past the wrapper.
    it.each([
        `[\`${cmd('npx', BARE)}\`](/docs/x)`,
        `[${cmd('npx', BARE)}](/docs/x)`,
        `**${cmd('npx', BARE)}**`,
        `(${cmd('npx', BARE)})`,
        `"${cmd('npx', BARE)}"`,
        `${cmd('npx', `"${BARE}"`)} init`,
        `${cmd('npx', `'${BARE}@rc'`)} init`,
        `${cmd('npx', BARE)}&& echo done`,
        `${cmd('npx', BARE)}; echo done`,
        `${cmd('npx', BARE)}| tee out.txt`,
        `Then run ${cmd('npx', BARE)}.`,
        `${cmd('npx', BARE)}, then commit`,
        `| ${cmd('npx', BARE)} |`,
    ])('reads the name past markup: %s', (line) => {
        expect(findBareStitchRunners(line)).toHaveLength(1);
    });

    // A command wraps — in prose, in a code block, or with a backslash — and the hit
    // is reported on the line the runner is on.
    describe('wrapped commands', () => {
        it('the name on the next line', () => {
            const text = ['intro', 'run npx', `${BARE} init`, 'outro'].join(
                '\n',
            );
            expect(findBareStitchRunners(text).map((h) => h.line)).toEqual([2]);
        });

        it('a backslash line continuation', () => {
            const text = ['```bash', 'npx \\', `  ${BARE} init`, '```'].join(
                '\n',
            );
            expect(findBareStitchRunners(text).map((h) => h.line)).toEqual([2]);
        });

        it('options wrapped over several continued lines', () => {
            const text = [
                'npx -y \\',
                '  --registry https://registry.example.com \\',
                `  ${BARE} init`,
            ].join('\n');
            expect(findBareStitchRunners(text).map((h) => h.line)).toEqual([1]);
        });

        it('a CRLF continuation', () => {
            expect(
                findBareStitchRunners(`npx \\\r\n  ${BARE} init`),
            ).toHaveLength(1);
        });

        it('keeps later line numbers right after a continuation', () => {
            const text = ['a \\', 'b', cmd('npx', `${BARE} init`)].join('\n');
            expect(findBareStitchRunners(text).map((h) => h.line)).toEqual([3]);
        });
    });

    it('sees it inside inline code, a shell prompt and prose', () => {
        expect(
            findBareStitchRunners(
                `or let \`${cmd('npx', BARE)} init\` write it`,
            ),
        ).toHaveLength(1);
        expect(
            findBareStitchRunners(`$ ${cmd('npx', BARE)} init --check`),
        ).toHaveLength(1);
        expect(
            findBareStitchRunners(`written by ${cmd('npx', BARE)}`),
        ).toHaveLength(1);
    });

    it('sees the backslash-escaped backticks of a template literal (RULES_BODY)', () => {
        const source = `4. Inspect or run: \\\`${cmd('npx', BARE)} run getUser\\\`,`;
        expect(findBareStitchRunners(source)).toHaveLength(1);
    });

    it('reports one hit per line with the 1-based line number', () => {
        const text = [
            'intro',
            `\`${cmd('npx', BARE)} diagram\`, \`${cmd('npx', BARE)} mcp\``,
            'outro',
            cmd('npx', `${BARE} init`),
        ].join('\n');
        expect(findBareStitchRunners(text).map((h) => h.line)).toEqual([2, 4]);
    });
});

describe('findBareStitchRunners — leaves the correct forms alone', () => {
    it.each([
        'npx stitchapi init',
        'npx stitchapi@rc init --check --project',
        'npx -y stitchapi run getUser',
        'pnpm dlx stitchapi init',
        // an explicit package: the next word is a bin name, not a package
        `npx -p stitchapi ${BARE} run getUser`,
        `npx --package=stitchapi ${BARE} run getUser`,
        `npx --package stitchapi ${BARE} run getUser`,
        // `pnpm exec` runs a local bin and never downloads
        `pnpm exec ${BARE} run getUser`,
        // the local bin after install, and a package script
        `${BARE} run getUser`,
        `pnpm ${BARE} run getUser`,
        // other first-party and third-party launches
        'npx @stitchapi/openapi ./spec.yaml --all',
        'npx stitch-openapi ./spec.yaml',
        'npx orval --config ./orval.config.ts',
        // an option's value, then the right package
        'npx --registry https://registry.example.com stitchapi init',
        'npx --cache /tmp/npx-cache -y stitchapi init',
        `npx -y -p stitchapi@rc ${BARE} init`,
        `npx -p stitchapi -p @stitchapi/openapi ${BARE} init`,
        `pnpm dlx --package=stitchapi ${BARE} init`,
        'npm x stitchapi init',
        // `-c` hands npm a shell string; no package is resolved from it
        `npx -c '${BARE} run getUser'`,
        // a runner name inside a longer word is not a runner
        `my-npx ${BARE} init`,
        // a word, not a command
        `the ${BARE} package is unrelated`,
        `${BARE} run getUser | tee out.txt`,
        `${BARE} init && npx stitchapi init --check`,
    ])('%s', (line) => {
        expect(findBareStitchRunners(line)).toEqual([]);
    });

    it('does not read across a blank line into the next paragraph', () => {
        expect(
            findBareStitchRunners(
                `run it with npx\n\n${BARE} is the executable`,
            ),
        ).toEqual([]);
    });

    it('does not read a code fence as the package', () => {
        expect(
            findBareStitchRunners('npx\n```\n' + BARE + ' run x\n```'),
        ).toEqual([]);
    });
});

describe('resolvesSingleBin', () => {
    it('accepts one bin', () => {
        expect(
            resolvesSingleBin({
                name: 'stitchapi',
                bin: { [BARE]: 'bin/stitch' },
            }),
        ).toBe(true);
    });

    it('accepts two names for the same target (an alias)', () => {
        expect(
            resolvesSingleBin({
                name: 'stitchapi',
                bin: { [BARE]: 'bin/stitch', st: 'bin/stitch' },
            }),
        ).toBe(true);
    });

    it('accepts several bins when one is named like the package', () => {
        expect(
            resolvesSingleBin({
                name: '@stitchapi/openapi',
                bin: { openapi: 'bin/a', other: 'bin/b' },
            }),
        ).toBe(true);
    });

    it('rejects several unrelated bins — npm cannot pick an executable', () => {
        expect(
            resolvesSingleBin({
                name: 'stitchapi',
                bin: { [BARE]: 'bin/stitch', extra: 'bin/extra' },
            }),
        ).toBe(false);
    });

    it('rejects a package with no bin', () => {
        expect(resolvesSingleBin({ name: 'stitchapi' })).toBe(false);
    });

    it('holds for the real stitchapi package', () => {
        const pkg = JSON.parse(
            readFileSync(
                fileURLToPath(
                    new URL(
                        '../../../packages/core/package.json',
                        import.meta.url,
                    ),
                ),
                'utf8',
            ),
        );
        expect(resolvesSingleBin(pkg)).toBe(true);
    });
});
