# StitchAPI — working agreement for Claude

## Edit in a fresh worktree off `main`

Before writing or editing **any** file in this repository, call `EnterWorktree`
first so the session works in a fresh git worktree branched from `main`. Do not
edit the primary checkout directly.

- `EnterWorktree` uses the `fresh` base ref (configured in
  [.claude/settings.json](.claude/settings.json)), so every worktree branches
  from `origin/main` — the repository's default branch.
- Enter the worktree **once per session, before the first edit**. All edits and
  the working branch live there.
- `main` is the default target branch: open the resulting PR against `main`.
- Exception: small edits to repo configuration (`.claude/`, `CLAUDE.md`, or
  memory files) may be made in the primary checkout directly — bootstrapping the
  worktree rule from inside a worktree isn't worth the friction.

### `node_modules` in a fresh worktree

A fresh worktree has no `node_modules` (it's gitignored). This is handled
**automatically**: a hook in [.claude/settings.json](.claude/settings.json) runs
`pnpm install --frozen-lockfile --prefer-offline` the moment an `EnterWorktree`
worktree is created. The global pnpm store (`~/Library/pnpm/store`) is shared
across all checkouts, so it's fully offline and fast (~5–7s — nothing is
re-downloaded; file content is hardlinked). It creates the per-package
`node_modules` the pnpm workspace needs and runs `lefthook install` so the
worktree's git hooks are wired up.

If you ever land in a worktree without deps (e.g. the hook was disabled), run that
same command by hand. Don't symlink `node_modules` into the worktree — pnpm would
write through the symlink into the primary checkout's store. A real `pnpm install`
is the correct fix.

## Using the StitchAPI docs MCP

This repo ships the `stitchapi-docs` MCP server preconfigured in
[`.mcp.json`](.mcp.json) — the local, offline
[`@stitchapi/docs-mcp`](https://www.npmjs.com/package/@stitchapi/docs-mcp)
package, which answers from a docs bundle on your machine (no per-query network;
a one-time embedding-model download on first use). For any question about
StitchAPI's own public API, configuration, errors, or runtime behavior, use it
before answering:

- Call `search_docs` with a natural-language query first, and read the excerpts
  and deep links it returns.
- Call `get_doc` to read a full page when an excerpt is not enough.
- Prefer these tools over prior knowledge. StitchAPI moves faster than model
  training data, so the published docs are the source of truth — when they
  disagree with memory, follow the docs.

Two caveats specific to working **inside this repo**:

- The bundle tracks the last published release, so for docs you are actively
  editing under `apps/docs/content`, read the working tree — it is ahead of the
  bundle.
- Want the latest unreleased docs over the local bundle instead? Swap the
  `.mcp.json` entry to the hosted server (`https://stitchapi.dev/api/mcp`,
  transport `http`).
