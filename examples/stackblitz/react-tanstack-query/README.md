# StitchAPI as a TanStack Query `queryFn`

StitchAPI does not compete with TanStack Query — it fills the `queryFn`. `stitchQueryOptions`
turns a `stitch()` into a plain TanStack Query options object (`queryKey` + `queryFn`), so
TanStack Query keeps owning caching and revalidation while the stitch supplies a typed,
validated, streaming-first fetcher.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/rejifald/StitchAPI/tree/main/examples/stackblitz/react-tanstack-query)

## Run locally

```bash
npm install
npm run dev
```

## What to look at

-   **`src/api.ts`** — one `stitch()` declaration, identical to the plain quick start.
-   **`src/App.tsx`** — `useQuery(stitchQueryOptions(getUsers, {}))`. No `@tanstack/react-query`
    import is needed inside StitchAPI: `stitchQueryOptions` returns a POJO, so it stays an
    optional peer.

More: <https://stitchapi.dev>.
