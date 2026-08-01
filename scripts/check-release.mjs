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
// Cross-package field consistency (version lockstep, engines.node, license) is owned
// by yakir — see yakir.json and .github/workflows/drift.yml. This script keeps the
// checks that are genuinely about a *publish*:
//
// Checks (numbered to match the sections below):
//   2. peerDep coherence — each peerDep/dependency on an in-repo sibling admits the
//      published version (prerelease-aware, via semver). This is the check that catches
//      `"stitchapi": ">=0.8.0"` silently rejecting a `1.0.0-rc.1` install.
//   3. publishConfig.access — every scoped (@stitchapi/*) package declares public access,
//      or npm rejects the very first publish.
//   4. dist-tag safety — a prerelease must never land on the `latest` tag.
//   5. CHANGELOG entry — CHANGELOG.md has a heading for the version (--changelog mode),
//      AND (advisory) every `type!:` breaking commit since the last release tag is
//      described under it. A heading alone is a weak gate: renaming [Unreleased] to the
//      release version satisfies it whatever is underneath, which is how breaks shipped
//      undocumented. P19 wants a one-line migration each.
//   6. release-tag match — a provided git tag equals v<version> (--release-tag mode).
//   7. LICENSE + README presence — every publishable package ships a LICENSE (Apache-2.0
//      §4 requires the license to accompany each distribution; npm auto-includes a
//      top-level LICENSE regardless of the `files` field) and a README.md (so the npm
//      page is not blank).
//
// Flags:
//   --changelog            require a CHANGELOG.md entry (publish-time)
//   --tag <dist-tag>       the intended npm dist-tag (else $npm_config_tag)
//   --release-tag <ref>    a git/release tag (e.g. v1.0.0-rc.1) to reconcile with the version
//   --print-tag            print the dist-tag derived from the version, then exit 0
//
// Exit code is 1 if any check fails; warnings never fail the run.
import { execSync } from 'node:child_process';
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

// ---- CHANGELOG breaking-change coverage (check 5, advisory half) --------------
// The text under one `## [version]` heading, up to the next one.
function sectionFor(body, version) {
    const lines = body.split('\n');
    const start = lines.findIndex((l) =>
        new RegExp(
            `^##\\s*\\[?${version.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\]?`,
        ).test(l),
    );
    if (start === -1) return '';
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^##\s/.test(l));
    return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

// Conventional-commit subjects marked breaking (`type(scope)!:`) since the previous
// release tag. Returns [] when git is unavailable (a published tarball has no history),
// which makes this check a no-op rather than a spurious failure.
function breakingSubjects() {
    try {
        const since = execSync('git describe --tags --abbrev=0 2>/dev/null', {
            cwd: ROOT,
            encoding: 'utf8',
        }).trim();
        const range = since ? `${since}..HEAD` : 'HEAD';
        return execSync(`git log --format=%s ${range}`, {
            cwd: ROOT,
            encoding: 'utf8',
        })
            .split('\n')
            .filter((s) => /^[a-z]+(\([^)]*\))?!:/.test(s.trim()))
            .map((s) => s.trim());
    } catch {
        return [];
    }
}

// Is this commit plausibly described in the section? Matches on the distinctive
// backticked identifiers in its subject — the tokens a migration line has to name.
function mentions(section, subject) {
    const idents = [...subject.matchAll(/`([^`]+)`/g)]
        // A subject often names a FAMILY (`*Config`, `*Info`) rather than one symbol; match
        // on the meaningful stem so `CacheConfig` in the entry satisfies `*Config` here.
        .map((m) => m[1].replace(/^\*+/, ''))
        .filter((id) => id.length > 2);
    if (idents.length === 0) return true; // nothing specific to look for
    return idents.some((id) => section.includes(id));
}

// 1. Version lockstep — now owned by yakir (yakir.json `release-version` tether, a
// glob over every published packages/*/package.json #/version). It also covers the
// engines.node and license fields (`node-engines` / `package-license` tethers), which
// this script never checked. Run `npx --yes ./tools/yakir.tgz check --tier token`, or
// see .github/workflows/drift.yml. Kept here: the checks that are genuinely about a
// *publish*, not cross-package field consistency.

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
    if (!heading.test(body)) {
        fail(`CHANGELOG.md is missing a "## [${canonical}]" entry`);
    } else {
        pass(`CHANGELOG: entry present for ${canonical}`);

        // A heading alone is a weak gate: renaming `[Unreleased]` to the release version
        // satisfies it no matter what is underneath. P19 requires a one-line migration per
        // hard break, so also check that every BREAKING commit since the previous release
        // heading is actually described. Advisory (a warning, not a failure) because the
        // match is by subject keyword and a legitimately-reworded entry would otherwise
        // block a publish — but it makes an undocumented break visible at release time
        // instead of after it ships.
        // Both sections: unreleased work is described under [Unreleased] until the
        // release renames that heading to the version, so either placement counts.
        const section =
            sectionFor(body, canonical) + '\n' + sectionFor(body, 'Unreleased');
        const undocumented = breakingSubjects().filter(
            (s) => !mentions(section, s),
        );
        if (undocumented.length === 0) {
            pass(
                `CHANGELOG: every breaking commit since the last release is described`,
            );
        } else {
            warn(
                `CHANGELOG: ${undocumented.length} breaking commit(s) not obviously described ` +
                    `under [${canonical}] — P19 wants a one-line migration each:\n` +
                    undocumented.map((s) => `      • ${s}`).join('\n'),
            );
        }
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

// 7. LICENSE + README presence -------------------------------------------------
// A scoped @stitchapi/* tarball that declares Apache-2.0 but omits the license text
// is non-compliant (Apache-2.0 §4(a)) and shows a blank npm page. npm always ships a
// top-level LICENSE/README regardless of the `files` whitelist, so the only failure
// mode is the file simply not existing in the package dir.
let assetChecks = 0;
for (const { path, json } of pkgs) {
    const dir = dirname(path);
    for (const asset of ['LICENSE', 'README.md']) {
        assetChecks++;
        if (!existsSync(join(dir, asset))) {
            fail(
                `${json.name}: missing ${asset} in ${dir.replace(ROOT + '/', '')} (npm always ships ${asset}; required for a clean, license-compliant publish)`,
            );
        }
    }
}
if (
    assetChecks &&
    !failures.some(
        (f) => f.includes('missing LICENSE') || f.includes('missing README'),
    )
) {
    pass(
        `LICENSE + README: present in all ${pkgs.length} publishable packages`,
    );
}

// 8. README install-channel coherence -----------------------------------------
// Plain-markdown READMEs (npm package pages + the GitHub landing) ship in the
// tarball with no build step, so their install commands carry a literal dist-tag.
// A bare `npm install stitchapi` resolves to the `latest` tag — which, on a
// prerelease line, is the OLD stable build, not what the docs describe. This
// check fails when a documented install command for a first-party package omits
// the channel suffix this version publishes under (`@rc` here), and — once 1.0.0
// ships stable — when a stale `@rc` lingers on what should be a bare install.
// The docs *site* is handled separately by lib/remark-install-channel.ts.
if (canonical) {
    const expectedTag = deriveDistTag(canonical);
    const expectedSuffix = expectedTag === 'latest' ? '' : `@${expectedTag}`;
    // After an optional `$ ` prompt, the line must START with an install command
    // (so inline-prose backtick mentions are not treated as instructions).
    const installLine =
        /^\s*\$?\s*(npm (install|i)|pnpm add|yarn add|bun add)\b/;
    const readmes = [
        join(ROOT, 'README.md'),
        ...pkgs.map(({ path }) => join(dirname(path), 'README.md')),
    ].filter(existsSync);

    /** The dist-tag portion of a first-party token, or null if it isn't ours. */
    const channelOf = (token) => {
        if (token === 'stitchapi' || token.startsWith('stitchapi@')) {
            return token.slice('stitchapi'.length); // '' | '@rc' | '@1.2.3'
        }
        if (token.startsWith('@stitchapi/')) {
            const at = token.indexOf('@', 1);
            return at === -1 ? '' : token.slice(at);
        }
        return null; // third-party (react, zod, …) — not our concern
    };

    let installChecks = 0;
    for (const file of readmes) {
        const rel = file.replace(ROOT + '/', '');
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
            if (!installLine.test(line)) return;
            for (const token of line.match(/\S+/g) ?? []) {
                const channel = channelOf(token);
                if (channel === null) continue;
                installChecks++;
                if (channel !== expectedSuffix) {
                    const base = token.slice(0, token.length - channel.length);
                    fail(
                        `${rel}:${i + 1}: install spec "${token}" should be ` +
                            `"${base}${expectedSuffix}" — ${canonical} publishes under ` +
                            `"${expectedTag}"; a bare install resolves to "latest".`,
                    );
                }
            }
        });
    }
    if (installChecks && !failures.some((f) => f.includes('install spec'))) {
        pass(
            `README install-channel: ${installChecks} first-party install spec(s) target "${expectedTag}"`,
        );
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
