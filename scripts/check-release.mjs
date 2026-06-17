#!/usr/bin/env node
// Release guardrails for the StitchAPI workspace.
//
// Validates that the publishable packages are internally consistent and safe to
// publish, so a bad release is caught locally and in CI rather than on npm.
//
// Invoked from three places:
//   - `pnpm check:release`              — verify.yml + local sanity (static invariants)
//   - each package's `prepublishOnly`   — defense-in-depth on a hand-run publish
//   - the Publish workflow              — full strict check before `pnpm -r publish`
//
// Checks:
//   1. Version lockstep — every publishable (non-private) package shares one version.
//   2. peerDep coherence — each peerDep/dependency on an in-repo sibling admits the
//      published version (prerelease-aware, via semver). This is the check that catches
//      `"stitchapi": ">=0.8.0"` silently rejecting a `1.0.0-rc.1` install.
//   3. publishConfig.access — every scoped (@stitchapi/*) package declares public access,
//      or npm rejects the very first publish.
//   4. dist-tag safety — a prerelease must never land on the `latest` tag.
//   5. CHANGELOG entry — CHANGELOG.md has a heading for the version (--changelog mode).
//   6. release-tag match — a provided git tag equals v<version> (--release-tag mode).
//
// Flags:
//   --changelog            require a CHANGELOG.md entry (publish-time)
//   --tag <dist-tag>       the intended npm dist-tag (else $npm_config_tag)
//   --release-tag <ref>    a git/release tag (e.g. v1.0.0-rc.1) to reconcile with the version
//   --print-tag            print the dist-tag derived from the version, then exit 0
//
// Exit code is 1 if any check fails; warnings never fail the run.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(ROOT, 'packages');

// ---- args --------------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const opts = {
    changelog: has('--changelog'),
    printTag: has('--print-tag'),
    tag: valueOf('--tag') ?? process.env.npm_config_tag,
    releaseTag: valueOf('--release-tag'),
};

// ---- helpers -----------------------------------------------------------------
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** The npm dist-tag a version should publish under: a prerelease channel, else `latest`. */
export function deriveDistTag(version) {
    const pre = semver.prerelease(version); // e.g. ['rc', 1] | ['alpha', 0] | [3] | null
    if (!pre) return 'latest';
    return typeof pre[0] === 'string' ? pre[0] : 'next';
}

/** Every non-private package under packages/* — the set `pnpm -r publish` would push. */
function loadPublishable() {
    return readdirSync(PACKAGES_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(PACKAGES_DIR, d.name, 'package.json'))
        .filter(existsSync)
        .map((path) => ({ path, json: readJson(path) }))
        .filter(({ json }) => !json.private);
}

// ---- run ---------------------------------------------------------------------
const pkgs = loadPublishable();
const versions = new Map(pkgs.map(({ json }) => [json.name, json.version]));
const canonical = versions.get('stitchapi');

if (opts.printTag) {
    if (!canonical) {
        console.error(
            'check:release — cannot derive tag: `stitchapi` not found',
        );
        process.exit(1);
    }
    process.stdout.write(deriveDistTag(canonical));
    process.exit(0);
}

const failures = [];
const warnings = [];
const fail = (msg) => failures.push(msg);
const warn = (msg) => warnings.push(msg);
const ok = [];
const pass = (msg) => ok.push(msg);

// 1. Version lockstep ----------------------------------------------------------
const distinct = [...new Set(pkgs.map((p) => p.json.version))];
if (distinct.length > 1) {
    const list = pkgs
        .map((p) => `      ${p.json.name}@${p.json.version}`)
        .join('\n');
    fail(
        `version lockstep: publishable packages disagree on version:\n${list}`,
    );
} else {
    pass(
        `version lockstep: all ${pkgs.length} publishable packages at ${distinct[0]}`,
    );
}

if (!canonical) {
    fail('`stitchapi` core package not found among publishable packages');
}

// 2. peerDep / dependency coherence against in-repo siblings -------------------
let peerChecks = 0;
for (const { json } of pkgs) {
    for (const field of ['peerDependencies', 'dependencies']) {
        for (const [dep, range] of Object.entries(json[field] ?? {})) {
            const siblingVersion = versions.get(dep);
            if (!siblingVersion) continue; // external dep — not our concern here
            peerChecks++;
            if (!semver.satisfies(siblingVersion, range)) {
                fail(
                    `${json.name}: ${field} "${dep}": "${range}" does NOT admit ${dep}@${siblingVersion}. ` +
                        `Prereleases only satisfy a range whose comparator shares the same x.y.z and carries a prerelease ` +
                        `(e.g. "^${canonical}").`,
                );
            }
        }
    }
}
if (peerChecks && !failures.some((f) => f.includes('does NOT admit'))) {
    pass(
        `peerDep coherence: ${peerChecks} in-repo range(s) admit the published version`,
    );
}

// 3. publishConfig.access for scoped packages ---------------------------------
for (const { json } of pkgs) {
    if (json.name.startsWith('@') && json.publishConfig?.access !== 'public') {
        fail(
            `${json.name}: scoped package needs \`"publishConfig": { "access": "public" }\` to publish`,
        );
    }
}
if (!failures.some((f) => f.includes('access'))) {
    pass('publishConfig.access: all scoped packages declare public access');
}

// 4. dist-tag safety (only when a tag is in play) ------------------------------
if (canonical) {
    const expected = deriveDistTag(canonical);
    const isPrerelease = expected !== 'latest';
    if (opts.tag !== undefined || opts.changelog) {
        if (isPrerelease && opts.tag === 'latest') {
            fail(
                `dist-tag: ${canonical} is a prerelease and must NOT publish to "latest" (use --tag ${expected})`,
            );
        } else if (isPrerelease && opts.tag === undefined) {
            warn(
                `dist-tag: ${canonical} is a prerelease — publish with \`--tag ${expected}\` (a bare publish defaults to "latest")`,
            );
        } else if (opts.tag !== undefined && opts.tag !== expected) {
            warn(
                `dist-tag: publishing ${canonical} under "${opts.tag}" (derived tag is "${expected}")`,
            );
        } else {
            pass(`dist-tag: ${canonical} → "${opts.tag ?? expected}"`);
        }
    }
}

// 5. CHANGELOG entry -----------------------------------------------------------
if (opts.changelog && canonical) {
    const changelogPath = join(ROOT, 'CHANGELOG.md');
    const body = existsSync(changelogPath)
        ? readFileSync(changelogPath, 'utf8')
        : '';
    const heading = new RegExp(
        `^##\\s*\\[?${canonical.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\]?`,
        'm',
    );
    if (heading.test(body)) {
        pass(`CHANGELOG: entry present for ${canonical}`);
    } else {
        fail(`CHANGELOG.md is missing a "## [${canonical}]" entry`);
    }
}

// 6. release-tag match ---------------------------------------------------------
if (opts.releaseTag && canonical) {
    const normalized = opts.releaseTag.replace(/^v/, '');
    if (normalized === canonical) {
        pass(`release tag: ${opts.releaseTag} matches ${canonical}`);
    } else {
        fail(`release tag ${opts.releaseTag} != package version ${canonical}`);
    }
}

// ---- report ------------------------------------------------------------------
for (const m of ok) console.log(`  ✓ ${m}`);
for (const m of warnings) console.warn(`  ! ${m}`);
for (const m of failures) console.error(`  ✗ ${m}`);

if (failures.length) {
    console.error(
        `\ncheck:release FAILED (${failures.length} problem${failures.length > 1 ? 's' : ''}).`,
    );
    process.exit(1);
}
console.log(
    `\ncheck:release passed${warnings.length ? ` (${warnings.length} warning${warnings.length > 1 ? 's' : ''})` : ''}.`,
);
