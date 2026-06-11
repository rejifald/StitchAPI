# StitchAPI Docs

The documentation site for [StitchAPI](https://github.com/rejifald/StitchAPI),
built with [Fumadocs](https://fumadocs.dev) on Next.js (App Router).

> **Scaffold only.** This sets up the app shell and tooling; documentation
> content lands in follow-up PRs.

## Develop

From the repository root:

```bash
pnpm install
pnpm --filter @stitchapi/docs dev
```

Open http://localhost:3000 with your browser.

## Scripts

| Script        | What it does                                       |
| ------------- | -------------------------------------------------- |
| `dev`         | Start the Next.js dev server.                      |
| `build`       | Production build (`next build`).                   |
| `start`       | Serve the production build.                        |
| `check:types` | Generate Fumadocs/Next types, then `tsc --noEmit`. |
| `check:lint`  | Lint with `eslint-config-next`.                    |

`check:types` and `check:lint` participate in the workspace verify gate
(`pnpm -r ...`, CI, and the lefthook hooks).

## Layout

| Path                      | Description                                    |
| ------------------------- | ---------------------------------------------- |
| `content/docs/`           | MDX documentation content.                     |
| `source.config.ts`        | Fumadocs MDX collections + frontmatter schema. |
| `lib/source.ts`           | Content source adapter (`loader()`).           |
| `lib/shared.ts`           | App name, routes, and GitHub config.           |
| `lib/layout.shared.tsx`   | Shared layout options (nav, links).            |
| `app/(home)/`             | Landing page route group.                      |
| `app/docs/`               | Documentation layout + pages.                  |
| `app/api/search/route.ts` | Orama search route handler.                    |

See the [Fumadocs documentation](https://fumadocs.dev) for details.
