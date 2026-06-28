// Single source of truth for the *documented* release: the version string the
// docs site shows and the npm dist-tag users must install from. Both are derived
// from the canonical `stitchapi` package version so the docs can never drift from
// what actually ships (the bug this module exists to kill: a banner reading
// "rc.1" while npm's `rc` tag points at rc.3, and bare `npm install stitchapi`
// quietly resolving to the old `latest` build).
//
// The version is read from the workspace source package.json — the same file
// scripts/check-release.mjs treats as canonical. resolveJsonModule is on (see
// tsconfig.json), and the path stays inside the monorepo so both `tsc` and the
// Next/fumadocs bundlers resolve it at build time.
import corePkg from '../../../packages/core/package.json';

/** The documented release version, e.g. `1.0.0-rc.3`. */
export const releaseVersion: string = corePkg.version;

/**
 * The npm dist-tag a version publishes under: its prerelease label (`rc`,
 * `alpha`, …), `next` for a numeric-only prerelease, or `latest` for a stable
 * release. This MUST stay in lockstep with `deriveDistTag` in
 * scripts/check-release.mjs — that function (backed by semver) is the canonical
 * rule the Publish workflow enforces; this is a dependency-free mirror of it.
 */
export function deriveDistTag(version: string): string {
    const dash = version.indexOf('-');
    if (dash === -1) return 'latest'; // no prerelease → stable
    const firstId = version.slice(dash + 1).split('.')[0];
    return /^[a-z]/i.test(firstId) ? firstId : 'next';
}

/** The dist-tag the documented version installs from, e.g. `rc` or `latest`. */
export const releaseChannel: string = deriveDistTag(releaseVersion);

/**
 * The suffix to append to a bare `stitchapi` / `@stitchapi/*` install spec so it
 * pulls the documented release: `@rc` on a prerelease channel, and `''` once the
 * channel is `latest` (a bare install is already correct for a stable release).
 * The install-channel remark plugin and the README guard both build on this, so
 * cutting `1.0.0` stable makes every documented install command correct with no
 * further edits.
 */
export const installSuffix: string =
    releaseChannel === 'latest' ? '' : `@${releaseChannel}`;
