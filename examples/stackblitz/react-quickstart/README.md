# StitchAPI — React quick start

The smallest useful `@stitchapi/react` app: declare an endpoint once with `stitch()`, call it
through `useStitch`, render the typed result.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/rejifald/StitchAPI/tree/main/examples/stackblitz/react-quickstart)

## Run locally

```bash
npm install
npm run dev
```

## What to look at

-   **`src/api.ts`** — the whole API layer: `stitch<User[]>('https://demo.stitchapi.dev/users')`.
    Point it at your own URL. Add `output:` (a Zod/Standard Schema) to also validate the response.
-   **`src/App.tsx`** — `useStitch(getUsers, {})` returns `{ data, isPending, isError, refetch }`
    and re-renders on each transition.

Streaming? Swap `useStitch` for `useStitchStream` and read `chunks` / `isStreaming` — the UI
re-renders as response deltas arrive. See <https://stitchapi.dev>.
