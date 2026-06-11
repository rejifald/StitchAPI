# StitchAPI — live playground

A separate, runnable showcase of the stitch runtime. Each feature has a mock backend
that simulates the behavior proven in core's `test/`, and the server streams the
stitch event stream to the browser **live** over SSE.

## Run

```bash
pnpm --filter @stitchapi/playground dev   # → http://localhost:5174
# from this folder:  pnpm dev
# or a plain script: bash packages/playground/run.sh
# pick a port:       PORT=8080 pnpm --filter @stitchapi/playground dev
```

No build step — it loads core's TypeScript source (`../core/src`) directly via `tsx`.

## How it works

-   `demos.ts` — the feature registry. Each `Demo.setup(mock)` registers behavior on a fresh
    mock backend (the tested `../core/test/support/mock-server.ts`) and returns one or more
    "plays" (a stitch + input).
-   `server.ts` — serves `public/`, exposes `GET /api/demos` (list) and `GET /api/run/:id`
    (Server-Sent Events). A run spins up a mock, builds the stitch against it, and pipes
    `start → progress → drift → result → done` events to the browser.
-   `public/` — the UI: a card per feature, a Run button, and a live event log + result.
