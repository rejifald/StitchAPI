# StitchAPI — StackBlitz templates

Minimal, self-contained apps you can open and run in the browser — no local setup. Each
installs the published `@stitchapi/*` packages from npm and fetches from
[JSONPlaceholder](https://jsonplaceholder.typicode.com), a free public sample API; edit
`src/api.ts` to hit your own.

| Template                                         | What it shows                                                                                | Open                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`react-quickstart`](./react-quickstart)         | `stitch()` + `useStitch` — declare an endpoint once, call it as a hook                       | [StackBlitz](https://stackblitz.com/github/rejifald/StitchAPI/tree/main/examples/stackblitz/react-quickstart)     |
| [`react-tanstack-query`](./react-tanstack-query) | `stitchQueryOptions` — a stitch as a TanStack Query `queryFn` (complement, not a competitor) | [StackBlitz](https://stackblitz.com/github/rejifald/StitchAPI/tree/main/examples/stackblitz/react-tanstack-query) |

> The StackBlitz links resolve against `main`, so they go live once this lands. Until then,
> run any template locally with `npm install && npm run dev`.

Docs & live playground: <https://stitchapi.dev>.
