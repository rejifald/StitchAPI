# StitchAPI — live playground

A separate, runnable showcase of the stitch runtime. Each feature has a mock backend
that simulates the behavior proven in `test/*`, and the server streams the
stitch event stream to the browser **live** over SSE.

## Run

```bash
bash playground/run.sh           # → http://localhost:5174
# or: PORT=8080 bash playground/run.sh
```

No build step — it loads the TypeScript library via `ts-node --transpile-only`.

## How it works

-   `demos.ts` — the feature registry. Each `Demo.setup(mock)` registers behavior on a fresh
    mock backend (the tested `test/support/mock-server.ts`) and returns one or more
    "plays" (a stitch + input).
-   `server.ts` — serves `public/`, exposes `GET /api/demos` (list) and `GET /api/run/:id`
    (Server-Sent Events). A run spins up a mock, builds the stitch against it, and pipes
    `start → progress → drift → result → done` events to the browser.
-   `public/` — the UI: a card per feature, a Run button, and a live event log + result.
