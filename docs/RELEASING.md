# Releasing StitchAPI

How to cut and publish a StitchAPI release. This is the standing, repeatable
runbook; for the one-time **v1.0 Launch** milestone tracker see
[`RELEASE.md`](RELEASE.md).

Every step that can be checked mechanically is checked by
[`scripts/check-release.mjs`](../scripts/check-release.mjs) (`pnpm check:release`) —
so this document explains the _why_ and the manual steps, and the script is the
enforcement.

## What gets published

`pnpm -r publish` pushes every **non-private** workspace package, in **lockstep**
at a single version:

| Package                          | Notes                            |
| -------------------------------- | -------------------------------- |
| `stitchapi`                      | core library (unscoped, public)  |
| `@stitchapi/fingerprint-arktype` | cache-fingerprint vendor adapter |
| `@stitchapi/fingerprint-effect`  | cache-fingerprint vendor adapter |
| `@stitchapi/fingerprint-typebox` | cache-fingerprint vendor adapter |
| `@stitchapi/fingerprint-valibot` | cache-fingerprint vendor adapter |
| `@stitchapi/fingerprint-zod`     | cache-fingerprint vendor adapter |
| `@stitchapi/nest`                | NestJS integration               |
| `@stitchapi/redis`               | Redis-backed store               |
| `@stitchapi/shell`               | shell surface                    |

**Never published** (`"private": true`): `@stitchapi/completions-plugin`,
`@stitchapi/sandbox-sim`, `@stitchapi/docs`.

## Versioning

- **Semantic Versioning.** At/after `1.0.0`: breaking → **major**, features →
  **minor**, fixes → **patch**. (While pre-`1.0`, breaking changes bumped the
  _minor_.)
- **Prereleases** use a dotted identifier: `X.Y.Z-rc.N` (also `-beta.N`,
  `-alpha.N`). Precedence: `alpha` < `beta` < `rc` < the final release.
- **The npm dist-tag is derived from the version**, never passed by hand:
  `-rc.*`→`rc`, `-beta.*`→`beta`, `-alpha.*`→`alpha`, a numeric-only prerelease →
  `next`, and a stable version → `latest`. **A prerelease therefore never takes
  `latest`** — `npm install stitchapi` keeps resolving the last stable release.
- **Lockstep + peer ranges.** All publishable packages share the version. Each
  companion declares `"stitchapi": "^<version>"`. A caret range like
  `^1.0.0-rc.1` admits the entire `1.x` line (so `rc.2`, `1.0.0`, `1.4.0` all
  satisfy it) — **only a major bump (e.g. `1.x` → `2.0.0`) needs the companion
  peer ranges widened.**

> [!IMPORTANT]
>
> A prerelease does **not** satisfy an ordinary range. `1.0.0-rc.1` does _not_
> satisfy `>=0.8.0` — a prerelease only satisfies a comparator that shares its
> `x.y.z` _and_ carries a prerelease tag. That is why companion peer ranges are
> `^<version>` and why `check:release` verifies satisfaction with `semver`.

## The guardrail — `pnpm check:release`

[`scripts/check-release.mjs`](../scripts/check-release.mjs) validates a release and
runs in three places, so a bad release is caught at PR time, locally, and in CI:

| Where                                        | Invocation                                            |
| -------------------------------------------- | ----------------------------------------------------- |
| `verify.yml` (every PR / push)               | `pnpm check:release` — static invariants only         |
| each package's `prepublishOnly`              | `check-release.mjs --changelog` — defense in depth    |
| `npm-publish.yml` (before `pnpm -r publish`) | `--changelog --tag <derived> --release-tag <git tag>` |

It checks: **(1)** version lockstep across publishable packages, **(2)**
prerelease-aware peer-range satisfaction for in-repo deps, **(3)** scoped
packages declare `publishConfig.access: public`, **(4)** dist-tag safety (a
prerelease may not land on `latest`), **(5)** a `CHANGELOG.md` entry exists for
the version (`--changelog`), and **(6)** the git/release tag equals the version
(`--release-tag`).

Flags: `--print-tag` (print the derived dist-tag and exit), `--changelog`,
`--tag <dist-tag>`, `--release-tag <ref>`.

## Cut a release — checklist

1. [ ] Branch off `main` (a fresh worktree, per [`CLAUDE.md`](../CLAUDE.md)).
2. [ ] Set the new `version` in **all 9** publishable `packages/*/package.json`
       (lockstep). For a **major** bump, also widen each companion's `stitchapi`
       peer range to `^<new-major>.0.0`.
3. [ ] Update [`CHANGELOG.md`](../CHANGELOG.md): rename `## [Unreleased]` to
       `## [X.Y.Z] — <YYYY-MM-DD>`, add a fresh empty `## [Unreleased]` above it,
       and update the compare links at the bottom.
4. [ ] Run `pnpm install` to refresh the lockfile if any dependency changed.
5. [ ] Run `pnpm check:release` — it must pass. It fails loudly if a package was
       missed, a peer range is stale, scoped access is absent, or the CHANGELOG
       lacks the entry.
6. [ ] Run the full gate (the same checks CI runs):
       `pnpm check:format && pnpm check:lint && pnpm check:types && pnpm test && pnpm check:exports`.
7. [ ] _(optional)_ Dry-run the publish — builds, packs, and resolves the tag
       without uploading:
       `pnpm -r publish --dry-run --no-git-checks --tag "$(node scripts/check-release.mjs --print-tag)"`.
8. [ ] Open a PR to `main`; merge once green.
9. [ ] Tag the merged commit and push it:
       `git tag vX.Y.Z && git push origin vX.Y.Z`.
10. [ ] Create a GitHub **release** from the tag — mark it **pre-release** for an
        `rc`/`beta`/`alpha` (drop `--prerelease` for a stable one):
        `gh release create vX.Y.Z --title vX.Y.Z --notes "See CHANGELOG.md" --prerelease`.
        This fires [`npm-publish.yml`](../.github/workflows/npm-publish.yml), which
        re-runs the verify + e2e gates and then publishes every package over OIDC
        (`pnpm pack` → `npm publish <tarball> --provenance`). New packages must be
        bootstrapped first — see _Bootstrapping a new package's first publish_ below.
11. [ ] Confirm on npm: `npm view stitchapi dist-tags` and
        `npm view stitchapi@<derived-tag> version`.

## Promote a prerelease to stable

When the soak is clean, release the final version (e.g. `1.0.0-rc.2` → `1.0.0`)
by repeating the checklist — the derived tag becomes `latest` automatically and
the `@stitchapi/*` companions move with it. To re-point an _already-published_
build instead of cutting a new one:

```sh
npm dist-tag add stitchapi@1.0.0 latest
```

## CI & authentication (OIDC trusted publishing)

- `npm-publish.yml` triggers on `release: created`. A fast **`preflight`** job runs
  first and gates everything else: it rejects in seconds a release whose tag does not
  match the version in the commit it points at (the classic "tagged `main` before the
  bump PR merged" mistake), so the long gates never run on a doomed release. Then the
  full verify gate (`check:format` → `lint` → `types` → `test:coverage` → `exports` →
  `check:release`) + the browser e2e gate run, and finally it publishes — the publish
  job re-runs `check-release --release-tag` as the authoritative final guard. Node
  version comes from [`.nvmrc`](../.nvmrc).
- **No npm token.** The publish job authenticates with **OIDC trusted publishing**:
  it requests an `id-token: write` permission, mints a short-lived token, and npm
  exchanges it for publish rights — nothing to store, rotate, or leak. It then runs
  `pnpm pack` (which rewrites the `workspace:` protocol and builds via `prepack`) and
  `npm publish <tarball> --provenance`, so every release also carries a signed
  build-provenance attestation. `publishConfig.access: public` (set on every
  companion) makes the scoped publishes public.
- **Each package needs a Trusted Publisher** configured once on npmjs.com: the
  package's _Settings → Trusted Publisher_ → GitHub Actions, repo `rejifald/StitchAPI`,
  workflow `npm-publish.yml`. Without it that package's publish step fails to
  authenticate.

## Bootstrapping a new package's first publish

OIDC can only publish a package that **already exists** on npm (a Trusted Publisher is
attached to an existing package — there is no way to OIDC-publish a brand-new name). A
new package's **first** version is therefore published once outside the workflow, after
which it rides `npm-publish.yml` for every release:

1. [ ] `npm login` — completes **interactive 2FA**. This works even under the strict
       "require two-factor authentication and disallow tokens" package/org policy,
       because interactive 2FA is not a token.
2. [ ] Build, then publish locally — `pnpm -r publish --tag <derived>` bootstraps the
       whole set at once (enter the OTP when prompted), or per package from its dir:
       `pnpm pack` then `npm publish <tarball> --tag <derived>`.
3. [ ] On npmjs.com, add the **Trusted Publisher** to each now-existing package.
4. [ ] Subsequent releases publish automatically over OIDC — no further local steps.

## Rollback

You cannot overwrite a published version. To retract a bad prerelease, move the
tag off it (`npm dist-tag rm stitchapi rc`, then re-point if needed) and/or
`npm deprecate stitchapi@<version> "<reason>"`. Unpublishing is only possible
within 72 hours of publish and only when nothing depends on the version.
