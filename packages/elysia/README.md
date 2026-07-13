# @stitchapi/elysia

[![npm](https://img.shields.io/npm/v/@stitchapi/elysia?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/elysia)

An **[Elysia](https://elysiajs.com) plugin** for [StitchAPI](https://stitchapi.dev).
`.use()` it and every request gets a [`seam`](https://stitchapi.dev) on its
context — a **request-scoped principal** bound per request — plus two bridges into
Elysia's Web-standard world: **SSE** streaming and a stitch-error → HTTP mapping.

```ts
import { stitch } from '@stitchapi/elysia';
import { Elysia } from 'elysia';
import { seam } from 'stitchapi';

const api = seam({ baseUrl: 'https://api.example.com' });

const app = new Elysia()
    .use(stitch({ seam: api, principal: ({ request }) => userOf(request) }))
    .get('/me', ({ stitch }) => stitch.stitch('/me')())
    .listen(3000);
```

Elysia is **Bun-first**, but the plugin imports only `elysia` and `stitchapi`
(no `node:*`), so it runs unchanged on Bun, Node, Deno and the edge.

## What it does

-   **Puts a seam on the context.** `.derive` runs per request and adds `stitch`
    to the context, so a handler reads it off the destructured context:
    `({ stitch }) => stitch.stitch('/path')()`.
-   **Binds a request-scoped principal.** With a `principal` resolver, every
    request's `stitch` is a `seam.as(principal)` handle — a separate session/token
    over the **shared** store + throttle. This is the trusted boundary StitchAPI's
    seam exists for: the principal lives in the closure, so a handler can never name
    another identity (ADR 0002).
-   **SSE bridge.** `streamStitchSse(stream)` turns a stitch's `.stream()` output
    into a `text/event-stream` `Response` you return straight from a handler.
-   **Error bridge.** A thrown `StitchError` is mapped to an HTTP response
    (`502` by default) via the plugin's `.onError`, so handlers need no try/catch.

## Seam: borrow, don't own

The plugin **borrows** the seam — it never closes it. Build it once at startup and
`seam.close()` it on shutdown yourself (the seam outlives any single request):

```ts
const api = seam({ baseUrl: 'https://api.example.com' });
const app = new Elysia().use(stitch({ seam: api }));
// on shutdown: await api.close();
```

## Principal binding

```ts
new Elysia().use(
    stitch({
        seam: api,
        principal: ({ request }) =>
            request.headers.get('x-tenant') ?? undefined,
    }),
);
```

Return `undefined` to fall back to the unbound root seam for that request (e.g.
anonymous). The principal-bound handle is **lifecycle-free** — only the root seam
the app owns carries `close` / `flush` / `invalidate`.

## SSE streaming

```ts
import { streamStitchSse } from '@stitchapi/elysia';
import { sseSurface } from 'stitchapi/sse';

app.get('/chat', ({ stitch, query }) => {
    const chat = stitch.stitch({ kind: sseSurface, path: '/v1/messages' });
    return streamStitchSse(chat.stream({ body: { prompt: query.q } }), {
        data: (chunk: any) => chunk.data, // pull text out of a structured chunk
    });
});
```

Each `delta` chunk becomes one SSE message; an `error` event ends the stream as a
named `event: error` message; stream end closes the response; and a client
disconnect cancels the body and aborts the upstream stitch stream rather than
leaving it running. Control events (`start`/`progress`/`result`/`done`/…) are not
forwarded.

By default the `error` frame carries a generic `data: error` token, **not** the raw
error message — echoing it can disclose internal network topology (a transport failure
reads like `getaddrinfo ENOTFOUND payments.internal.corp`) or the upstream's status
(`HTTP 401`) to the client. Pass `errorData` to opt in when the upstream messages are
known safe (`errorData: (e) => e.message`); `onError` still receives the real failure
server-side.

## Error handling

The plugin registers an `.onError` that maps a `StitchError` to an HTTP response
and lets every other error fall through to Elysia's default handling. By default
the status is `502` **and** the body is a generic, status-tied message
(`{ error: 'Bad Gateway' }`) — the raw `err.message` is withheld, because it can
leak an internal hostname (`getaddrinfo ENOTFOUND payments.internal.corp`) or the
upstream's status (`HTTP 401`) to an untrusted client:

```ts
new Elysia().use(
    stitch({
        seam: api,
        // propagate the upstream status instead of the safe 502 default:
        errorHandler: { status: (e) => e.status ?? 502 },
        // opt in to the raw message (only when upstream messages are safe to expose):
        // errorHandler: { body: (e) => ({ error: e.message }) },
    }),
);
```

Set `errorHandler: false` to register none and wire your own with
`stitchOnError(options)` or `stitchErrorResponse(err, options)`.

## API

| Export                | Kind     | Purpose                                            |
| --------------------- | -------- | -------------------------------------------------- |
| `stitch`              | function | The plugin — `.use(stitch({ seam, principal? }))`  |
| `streamStitchSse`     | function | Stream a stitch's `.stream()` as an SSE `Response` |
| `stitchOnError`       | function | An `.onError`-compatible StitchError → HTTP mapper |
| `stitchErrorResponse` | function | Map a StitchError to a `Response` (one-off)        |
| `isStitchError`       | function | Narrow an unknown error to a `StitchError`         |

`stitchapi` and `elysia` are **peer dependencies** — bring your own.

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
