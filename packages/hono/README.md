# @stitchapi/hono

[![npm](https://img.shields.io/npm/v/@stitchapi/hono?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/hono)

**Hono middleware + helpers for [StitchAPI](https://stitchapi.dev).** Put a
`seam` on the request context, stream a stitch's SSE output to the client, and
map Stitch errors to HTTP — three thin bridges between StitchAPI's backend
primitive (the `seam`, ADR 0002) and Hono's Fetch-based request model.

**Edge/multi-runtime by construction.** Every import is from `hono` or
`stitchapi`; there are **no `node:*` imports**, so the package runs unchanged on
Node, Cloudflare Workers, Deno, Bun and Vercel Edge.

```ts
import { type StitchEnv, stitch } from '@stitchapi/hono';
import { Hono } from 'hono';
import { seam } from 'stitchapi';

// Build (and own) the seam once at startup.
const api = seam({ baseUrl: 'https://api.example.com' });

const app = new Hono<StitchEnv>();

// Put a principal-bound seam on every request's context.
app.use(stitch({ seam: api, principal: (c) => c.get('user')?.id }));

app.get('/me', (c) => c.json(c.get('stitch').stitch('/me')()));
```

## The middleware: `stitch({ seam, principal? })`

On each request the middleware sets `c.set('stitch', …)`:

-   `principal` returns an id → the context seam is `seam.as(id)` — a
    **principal-bound** handle (separate auth sessions per principal, one shared
    throttle bucket). The principal lives in the closure, never in a call
    argument, so a handler can't impersonate another identity (ADR 0002 §2).
-   `principal` returns `undefined` (or is omitted) → the **root** seam, unbound.

Parametrise your app with `StitchEnv` so `c.get('stitch')` is typed. Have other
variables? Intersect: `new Hono<StitchEnv & MyEnv>()`.

**Borrow, don't own.** The middleware never calls `seam.close()` — the seam
outlives any single request. You build it at startup and close it on shutdown,
mirroring StitchAPI's borrow-don't-own rule.

## Streaming: `streamStitchSse(c, source, options?)`

Stream a streaming/SSE stitch's `.stream()` to the client as Server-Sent Events,
via Hono's `streamSSE`. Each `delta` becomes a `data:` message; a terminal
`error` event (or a throw) becomes a final `event: error` message; control events
(`start`/`progress`/`result`/`done`/…) are consumed but not forwarded. On client
disconnect the upstream stitch stream is aborted.

```ts
import { sseSurface } from 'stitchapi/sse';

app.get('/chat', (c) => {
    const completion = c
        .get('stitch')
        .stitch({ kind: sseSurface, path: '/v1/messages' });
    return streamStitchSse(
        c,
        completion.stream({ body: { prompt: c.req.query('q') } }),
        {
            data: (chunk: any) => chunk.data, // pull the parsed event payload out of each delta
        },
    );
});
```

## Errors: `stitchError(err)` / `stitchOnError(options?)`

A failed stitch rejects with a `StitchError` carrying the upstream `status`.
Register `stitchOnError()` as your app's `onError` so handlers need no per-route
try/catch:

```ts
app.onError(stitchOnError());
// default 502, body `{ error: 'Bad Gateway' }` — neither the upstream's
// 401/404/etc. status nor the raw error message is leaked to your client (a
// transport failure would otherwise read like `getaddrinfo ENOTFOUND
// payments.internal.corp`, disclosing internal topology).

// propagate the upstream status instead:
app.onError(stitchOnError({ status: (e) => e.status ?? 502 }));

// or shape your own error envelope (this opts in to the raw message):
app.onError(stitchOnError({ body: (e) => ({ error: e.message }) }));
```

Or map a single error by hand — `stitchError` returns a Hono `HTTPException`, or
`undefined` for a non-Stitch error so you can rethrow it untouched:

```ts
try {
    return c.json(await c.get('stitch').stitch('/users')());
} catch (err) {
    throw stitchError(err) ?? err;
}
```

## Pairing with a store

On Cloudflare Workers / multi-runtime deployments, pair the seam with a shared
store so throttle + sessions are fleet-wide — see
[`@stitchapi/redis`](https://stitchapi.dev). (A Workers-KV store pairing is a
tracked follow-up.)

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
