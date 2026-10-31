#!/usr/bin/env node
// Self-test for check 5 of scripts/check-release.mjs (the CHANGELOG heading) — run by
// `pnpm check:release` after the guardrail itself.
//
// The heading match once had no end anchor, so `## [1.0.0-rc.8]` satisfied the `1.0.0`
// check and a stable release with no notes of its own would have published (#857). This
// builds a one-package workspace in a temp dir per case and drives the real script as a
// child process (`CHECK_RELEASE_ROOT` points it at the fixture), so what is tested is
// exactly what the Publish workflow runs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(
    dirname(fileURLToPath(import.meta.url)),
    'check-release.mjs',
);

const fixture = (version, changelog) => ({
    'packages/core/package.json': JSON.stringify({
        name: 'stitchapi',
        version,
    }),
    'packages/core/LICENSE': 'fixture\n',
    'packages/core/README.md': '# fixture\n',
    'CHANGELOG.md': changelog,
});

const cases = [];
const gate = (name, version, headings, { code, includes = [] }) =>
    cases.push({ name, version, headings, code, includes });

gate('an exact stable heading passes', '1.0.0', ['## [1.0.0] — 2026-11-01'], {
    code: 0,
});
gate('an unbracketed heading passes', '1.0.0', ['## 1.0.0'], { code: 0 });
gate('a bare bracketed heading passes', '1.0.0', ['## [1.0.0]'], { code: 0 });
gate(
    'only an rc heading does NOT satisfy the stable version',
    '1.0.0',
    ['## [Unreleased]', '## [1.0.0-rc.8] — 2026-09-15'],
    { code: 1, includes: ['missing a "## [1.0.0]" entry'] },
);
gate('rc.10 does NOT satisfy rc.1', '1.0.0-rc.1', ['## [1.0.0-rc.10]'], {
    code: 1,
    includes: ['missing a "## [1.0.0-rc.1]" entry'],
});
gate('a later patch does NOT satisfy its prefix', '1.0.1', ['## [1.0.10]'], {
    code: 1,
    includes: ['missing a "## [1.0.1]" entry'],
});
gate(
    'the right heading is found below a lookalike',
    '1.0.0',
    ['## [1.0.0-rc.9]', '## [1.0.0] — 2026-11-01'],
    { code: 0 },
);

let failed = 0;
for (const c of cases) {
    const dir = mkdtempSync(join(tmpdir(), 'check-release-selftest-'));
    try {
        const changelog =
            '# Changelog\n\n' +
            c.headings.map((h) => `${h}\n\n- x\n`).join('\n');
        for (const [rel, body] of Object.entries(
            fixture(c.version, changelog),
        )) {
            mkdirSync(dirname(join(dir, rel)), { recursive: true });
            writeFileSync(join(dir, rel), body);
        }
        const run = spawnSync(
            process.execPath,
            // `--tag` matches the derived tag, so check 4 stays quiet and only check 5 decides.
            [
                SCRIPT,
                '--changelog',
                '--tag',
                c.version.includes('-') ? 'rc' : 'latest',
            ],
            {
                encoding: 'utf8',
                env: { ...process.env, CHECK_RELEASE_ROOT: dir },
            },
        );
        const out = run.stdout + run.stderr;
        const missing = c.includes.filter((s) => !out.includes(s));
        if (run.status !== c.code || missing.length) {
            failed++;
            console.error(
                `  ✗ ${c.name}: exit ${run.status} (want ${c.code})` +
                    (missing.length
                        ? `, missing ${JSON.stringify(missing)}`
                        : '') +
                    `\n${out.replace(/^/gm, '      ')}`,
            );
        } else {
            console.log(`  ✓ ${c.name}`);
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

if (failed) {
    console.error(
        `\ncheck-release self-test FAILED (${failed}/${cases.length}).`,
    );
    process.exit(1);
}
console.log(`\ncheck-release self-test passed (${cases.length} cases).`);
