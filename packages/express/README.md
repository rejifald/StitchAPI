# @stitchapi/express

[![npm](https://img.shields.io/npm/v/@stitchapi/express?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/express)

**Express middleware + helpers for [StitchAPI](https://stitchapi.dev).** Attach a
`seam` to every request, stream a stitch's SSE output to the client, and map
Stitch errors to HTTP — three thin bridges between StitchAPI's backend primitive
(the `seam`, ADR 0002) and Express's `req`/`res`.

Express has no plugin/lifecycle/logger structure to bridge (cf.
[`@stitchapi/fastify`](https://stitchapi.dev)), so this is the **shallow**
binding: a request handler, an SSE writer, and an error-handling middleware.
Works on Express 4 and 5.

```ts
import { stitch, stitchErrorHandler } from '@stitchapi/express';
import express from 'express';
import { seam } from 'stitchapi';

// Build (and own) the seam once at startup.
const api = seam({ baseUrl: 'https://api.example.com' });

const app = express();

// Put a principal-bound seam on every request.
app.use(stitch({ seam: api, principal: (req) => req.user?.id }));

app.get('/me', async (req, res) => res.json(await req.stitch.stitch('/me')()));

// Map a thrown StitchError to an HTTP response (register after your routes).
app.use(stitchErrorHandler());
```

Importing the package augments Express's `Request` type, so `req.stitch` is typed
everywhere.

## The middleware: `stitch({ seam, principal? })`

On each request the middleware sets `req.stitch` (and mirrors it on
`res.locals.stitch`):

-   `principal` returns an id → `req.stitch` is `seam.as(id)` — a
    **principal-bound** handle (separate auth sessions per principal, one shared
    throttle bucket). The principal lives in the closure, never in a call
    argument, so a handler can't impersonate another identity (ADR 0002 §2).
-   `principal` returns `undefined` (or is omitted) → the **root** seam, unbound.

`currentStitch(req)` reads the same handle back as a typed value (and throws if
the middleware never ran, so a missing `app.use(stitch(...))` fails loudly).

**Borrow, don't own.** The middleware never calls `seam.close()` — the seam
outlives any single request. You build it at startup and close it on shutdown,
mirroring StitchAPI's borrow-don't-own rule.

## Streaming: `streamStitchSse(res, source, options?)`

Stream a streaming/SSE stitch's `.stream()` to `res` as Server-Sent Events, by
writing `text/event-stream` frames straight to the socket. Each `delta` becomes a
`data:` frame; a terminal `error` event becomes a final `event: error` frame;
control events (`start`/`progress`/`result`/`done`/…) are consumed but not
forwarded. On client disconnect (`res` — or `req`, when passed — emits `close`)
the upstream stitch stream is aborted.

```ts
import { sseSurface } from 'stitchapi/sse';

app.get('/chat', (req, res) => {
    const completion = req.stitch.stitch({
        kind: sseSurface,
        path: '/v1/messages',
    });
    return streamStitchSse(
        res,
        completion.stream({ body: { prompt: req.query.q } }),
        {
            data: (chunk: any) => chunk.data, // pull the parsed payload out of each delta
            req, // also tear down if the request socket signals disconnect
        },
    );
});
```

Do not also `res.send()`/`res.json()` from the same handler — the helper owns the
response.

## Errors: `stitchErrorHandler(options?)`

A failed stitch throws a `StitchError` carrying the upstream `status`. Register
`stitchErrorHandler()` **after your routes** so handlers need no per-route
try/catch — it maps a StitchError to a JSON response and `next(err)`s everything
else (so Express's default handler, and any error middleware after it, stays in
charge):

```ts
app.use(stitchErrorHandler());
// default 502 — an upstream's 401/404/etc. is never leaked to your client.

// propagate the upstream status instead:
app.use(stitchErrorHandler({ status: (e) => e.status ?? 502 }));

// or shape your own error envelope:
app.use(
    stitchErrorHandler({
        body: (e, status) => ({ code: status, msg: e.message }),
    }),
);
```

Note: an Express error middleware is matched by its 4-arg arity — `stitchErrorHandler`
returns a `(err, req, res, next)` function for exactly that reason.
