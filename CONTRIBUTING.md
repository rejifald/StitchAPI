# Contributing to StitchAPI

Thanks for contributing! This repository is a [pnpm](https://pnpm.io) workspace.
The published library is [`stitchapi`](packages/core) (in `packages/core`); the
framework adapters and other companions live alongside it under `packages/*`. See
the package table in the [root README](README.md) for the full map.

## Reporting bugs and requesting features

> **Found a security vulnerability?** Don't open an issue. Report it privately —
> see [`SECURITY.md`](SECURITY.md) for the two channels and what to expect.

Everything else belongs in the [issue tracker](https://github.com/rejifald/StitchAPI/issues).
Pick the matching template and it will ask for what we need:

- **Bug report** — what you expected, what happened instead, and a **minimal
  reproduction**: the smallest `stitch` definition that shows the problem. Also
  tell us the `stitchapi` version and the runtime (Node, browser, Deno, Bun,
  Cloudflare Workers, React Native…), because a good share of bugs are
  runtime-specific.
- **Feature request** — the problem you're trying to solve, before the API you
  have in mind. Which package it belongs in matters too: core carries an
  [enforced bundle-size budget](#bundle-size-budget), so a capability that
  doesn't need to live in `stitchapi` is usually better as a companion package
  or a subpath import.

Search the tracker first — an open issue you can add a reproduction to is worth
more than a duplicate.

## Prerequisites

- **Node** — the version is pinned in [`.nvmrc`](.nvmrc) (currently `24`). With
  `nvm`/`fnm` run `nvm use` in the repo root to pick it up.
- **pnpm** — pinned via Corepack (the `packageManager` field in
  [`package.json`](package.json)). Run `corepack enable` once and you'll get the
  exact pnpm the repo expects; no global install to keep in sync.

## Local setup and dev loop

```sh
corepack enable          # use the pinned pnpm
pnpm install             # install the whole workspace
pnpm build               # build every package
pnpm test                # run the test suites
pnpm check:format        # prettier across the repo
```

`pnpm format` rewrites in place (prettier `--write`); `pnpm check:format` is the
read-only check the gate runs.

## Scoping work to one package

The workspace scripts (`pnpm build`, `pnpm test`, …) fan out across every package
with `pnpm -r`. While iterating on one package, scope the command with a
`--filter` and the package's name:

```sh
pnpm --filter stitchapi test          # just the core library's tests
pnpm --filter @stitchapi/react build  # just the React bindings
```

The names are the package names from the [README table](README.md) (e.g.
`stitchapi`, `@stitchapi/react`), not the directory paths.

## Bundle-size budget

The core library advertises a zero-dependency, tree-shaken bundle size, and that
claim is an enforced gate — not an aspiration:

```sh
pnpm --filter stitchapi size
```

This builds the core entry and measures the **tree-shaken, min+gzip** cost a
downstream bundler would actually ship, then checks it against the per-scenario
ceilings in [`packages/core/scripts/bundle-size.mjs`](packages/core/scripts/bundle-size.mjs).
It is the same gate CI enforces (the `size` job in
[`.github/workflows/verify.yml`](.github/workflows/verify.yml)).

A change that grows the bundle past its ceiling **fails** the gate. The budget is
a deliberate ceiling: prefer trimming the entry, or moving a new capability behind
its own subpath import, over raising it. If growth is genuinely necessary, raise
the number in `bundle-size.mjs` **in the same PR** and say why — bumping it must
be a conscious act.

## How we work: worktrees and git hooks

Development happens in a **fresh git worktree branched off `origin/main`**, not in
your primary checkout. This keeps concurrent branches isolated and every change
starting from the repository's default branch. (This is also the working
agreement automated agents follow — see [`CLAUDE.md`](CLAUDE.md).)

A fresh worktree has no `node_modules` (it's gitignored), so populate it with a
frozen install:

```sh
pnpm install --frozen-lockfile --prefer-offline
```

The global pnpm store is shared across checkouts, so this is fully offline and
fast — it just creates the per-package `node_modules` the workspace needs. Don't
symlink `node_modules` from another checkout; a real install is the correct fix.

`pnpm install` also runs `lefthook install` (via the `prepare` script), wiring up
the repo's git hooks ([`lefthook.yml`](lefthook.yml)). They run the **same gates
as CI**, cheap → expensive:

- **pre-commit** — formats staged files, lints, type-checks, and keeps generated
  artifacts (playground completions, the README metrics block, advertised bundle
  sizes) from drifting.
- **pre-push** — the full verify sequence (`check:format`, `check:lint`,
  `check:types`, `test`, `check:exports`, docs build) so a push never lands
  something CI rejects.

You can run any of these by hand — `pnpm check:format`, `pnpm check:lint`,
`pnpm check:types`, `pnpm test` — to reproduce a gate locally.

## Tests come with the change

**New functionality lands with tests for it, and a bug fix lands with a test that
fails without the fix.** This is the project's standing policy, not a
case-by-case judgement call — the suites are the only thing that keeps a
zero-dependency runtime honest across every runtime it claims to support.

Tests live next to what they cover (`packages/*/test/**` and `*.spec.ts`) and run
under [Vitest](https://vitest.dev). Core also declares coverage thresholds in
[`packages/core/vitest.config.ts`](packages/core/vitest.config.ts), enforced by
the `coverage` job in CI — a change that drops coverage below them fails the
build, so untested new code tends to fail the gate on its own.

Exercise the behaviour through the public API rather than reaching into
internals: a test that pins an implementation detail blocks the next refactor
without protecting a user.

## Opening a pull request

- **Target `main`.** It's the default branch and the base every worktree branches
  from.
- **Include the tests.** See [above](#tests-come-with-the-change) — new
  functionality without them will be sent back.
- **Write conventional-commit-style messages** — `type(scope): summary`, e.g.
  `fix(core): …`, `test(react): …`, `refactor: …`. Browse `git log` for the
  house style.
- **Keep the gate green.** The [Verify workflow](.github/workflows/verify.yml)
  re-runs the same checks as the local hooks and must pass before merge.
- The README's `METRICS:BADGES` block is generated (`pnpm gen:readme`, refreshed
  by `pnpm metrics`) — don't hand-edit it; the `check:readme` guard will flag
  drift.
