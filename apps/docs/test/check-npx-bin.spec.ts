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
    ])('%s %s', (runner, rest) => {
        expect(findBareStitchRunners(cmd(runner, rest))).toHaveLength(1);
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
    ])('%s', (line) => {
        expect(findBareStitchRunners(line)).toEqual([]);
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
