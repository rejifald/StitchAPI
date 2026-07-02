# @stitchapi/fastify

[![npm](https://img.shields.io/npm/v/@stitchapi/fastify?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/fastify)

A **[Fastify](https://fastify.dev) plugin** for [StitchAPI](https://stitchapi.dev).
Register it and your app gets a shared [`seam`](https://stitchapi.dev) decorated
on the instance, a **request-scoped principal** bound per request, and three
bridges into Fastify's world: its built-in **Pino logger**, **SSE** streaming,
and a stitch-error → HTTP **error handler**.

```ts
import { stitchPlugin } from '@stitchapi/fastify';
import Fastify from 'fastify';

const app = Fastify({ logger: true });

await app.register(stitchPlugin, {
    seamConfig: { baseUrl: 'https://api.example.com' },
    principal: (req) => req.headers['x-tenant'] as string | undefined,
});

app.get('/me', async (request) => request.stitch.stitch({ path: '/me' })());
```

The plugin is wrapped with `fastify-plugin`, so the `fastify.stitch` /
`request.stitch` decorators (and `currentStitch()`) escape the plugin's
encapsulation and are visible app-wide.

## What it does

-   **Decorates the app** with the root `seam` at `fastify.stitch`.
-   **Binds a request-scoped principal.** With a `principal` resolver, every
    request gets a `seam.as(principal)` handle — a separate session/token over the
    **shared** store + throttle — on `request.stitch`. This is the trusted boundary
    StitchAPI's seam exists for: the caller can never name another principal.
-   **Ambient principal via `AsyncLocalStorage`.** `currentStitch()` reads the
    request's bound seam from Node's `AsyncLocalStorage`, so handlers and services
    don't have to thread `request.stitch` through every call — a value-add a Node
    integration can offer that the browser-first core cannot.
-   **Pino logger bridge.** `fastify.log` becomes the seam's `TraceSink`
    (default on). It logs **only metadata** (name, method, scrubbed URL, status,
    attempts, timing), never request/response bodies or headers, so it is safe on a
    secret-bearing seam.
-   **SSE bridge.** `sendStitchSse(reply, stream)` streams a stitch's `.stream()`
    output to a `text/event-stream` reply.
-   **Error bridge.** A thrown `StitchError` is mapped to an HTTP response
    (`502` by default) so handlers need no try/catch.

## Seam: build or borrow

Pass a **prebuilt** seam the app owns…

```ts
import { seam } from 'stitchapi';

const api = seam({ baseUrl: 'https://api.example.com' });

await app.register(stitchPlugin, { seam: api });
// borrowed — the plugin never closes it; the app owns its lifecycle.
```

…or let the plugin **build and own** one from a `SeamConfig`:

```ts
await app.register(stitchPlugin, {
    seamConfig: { baseUrl: 'https://api.example.com', retry: { attempts: 3 } },
});
// built — the plugin closes it on `app.close()`.
```

The ownership rule mirrors `@stitchapi/nest`: a seam the plugin **built** is
closed on the Fastify `onClose` hook; a **borrowed** seam is never closed by the
plugin. Override with `closeSeam: true | false`.

## Ambient principal (`currentStitch()`)

```ts
import { currentStitch } from '@stitchapi/fastify';

// In a service called from a handler — no `request` threaded through:
async function loadProfile() {
    const api = currentStitch(); // the request's principal-bound seam
    return api?.stitch({ path: '/profile' })();
}
```

`currentStitch()` returns `undefined` outside a request, so a caller can fall
back to an explicit seam.

## SSE streaming

```ts
import { sendStitchSse } from '@stitchapi/fastify';

app.get('/chat', (req, reply) =>
    sendStitchSse(reply, chat.stream({ query: { q: String(req.query.q) } }), {
        data: (c) => c.text, // pull text out of a structured chunk
    }),
);
```

Each `delta` chunk becomes one SSE frame; an `error` event ends the stream as a
named `error` frame; stream end closes the response; and a client disconnect
aborts the upstream stitch generator rather than leaving it running.

By default the `error` frame carries a generic `data: error` token, **not** the raw
error message — echoing it can disclose internal network topology (a transport
failure reads like `getaddrinfo ENOTFOUND payments.internal.corp`) or the upstream's
status (`HTTP 401`) to the client. Pass `errorData` to opt in when the upstream
messages are known safe to expose:

```ts
sendStitchSse(reply, chat.stream({ query: { q: String(req.query.q) } }), {
    errorData: (e) => e.message, // opt in to the raw upstream message
});
```

## Error handling

The plugin registers a `setErrorHandler` that maps a `StitchError` to an HTTP
response and rethrows everything else (so Fastify's default handler stays in
charge). By default the status is `502` **and** the body is a generic,
status-tied message (`{ error: 'Bad Gateway' }`) — the raw `error.message` is
withheld, because it can leak an internal hostname (`getaddrinfo ENOTFOUND
payments.internal.corp`) or the upstream's status (`HTTP 401`) to an untrusted
client:

```ts
await app.register(stitchPlugin, {
    seamConfig: { baseUrl: '…' },
    // propagate the upstream status instead of the safe 502 default:
    errorHandler: { status: (e) => e.status ?? 502 },
    // opt in to the raw message (only when upstream messages are safe to expose):
    // errorHandler: { body: (e) => ({ error: e.message }) },
});
```

Set `errorHandler: false` to register none and wire your own with
`stitchErrorHandler(options)`.

## Logger

By default `fastify.log` is bridged as the seam's trace sink. Disable it
(`logger: false`) or tune it (`logger: { lifecycle: false }` to drop happy-path
events and log only retries, drift, and errors). A seam built with its own
`trace` keeps it; a borrowed seam keeps whatever sink it was created with.

## API

| Export               | Kind     | Purpose                                           |
| -------------------- | -------- | ------------------------------------------------- |
| `stitchPlugin`       | plugin   | `fastify.register(stitchPlugin, options)`         |
| `currentStitch()`    | function | The request's ambient principal-bound seam        |
| `sendStitchSse`      | function | Stream a stitch's `.stream()` to an SSE reply     |
| `stitchErrorHandler` | function | A `setErrorHandler`-compatible StitchError mapper |
| `fastifyLoggerSink`  | function | `fastify.log` → seam `TraceSink` bridge           |
| `isStitchError`      | function | Narrow an unknown error to a `StitchError`        |

`stitchapi` and `fastify` are **peer dependencies** — bring your own.

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
