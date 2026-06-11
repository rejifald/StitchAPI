# StitchAPI · Get Users (live example)

A self-contained demo of [`stitchapi`](https://github.com/rejifald/StitchAPI). It
fetches users with StitchAPI and renders them — but instead of calling a
third-party service, it runs every request against a **fake API we build and
serve inside the sandbox itself**.

## Run it

```bash
npm install
npm run dev
```

Then open the printed URL.

## How it works

| Piece | File | Role |
| --- | --- | --- |
| Fake API data | [`fake-api/users.ts`](fake-api/users.ts) | The seed records the API returns. |
| Fake API logic | [`fake-api/handler.ts`](fake-api/handler.ts) | Framework-agnostic `(method, path, query) → JSON` handler. |
| Fake API server | [`fake-api/plugin.ts`](fake-api/plugin.ts) | A Vite plugin that mounts the handler as `/api/*` middleware. |
| The demo | [`src/main.ts`](src/main.ts) | Uses `stitchapi` to call `/api/users` and `/api/users/{id}`. |

Because the fake API is just Vite dev-server middleware, there is no separate
backend process, no service worker to generate, and no network access required.
The same `handler.ts` could be remounted behind Express, MSW, or a Worker.

## StitchAPI features shown

- **URL Templates** — `'/api/users/{id}'` expanded from `params`.
- **Query strings** — `findUsers({ query: { per_page: 6 } })`.
- **Response `unwrap`** — returning just `data` from the envelope.
- **On-the-fly validation + type inference** — Zod schemas validate the whole
  response and drive the TypeScript types of the unwrapped results.
