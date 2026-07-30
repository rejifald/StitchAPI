# @stitchapi/next

[![npm](https://img.shields.io/npm/v/@stitchapi/next?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/next)

[Next.js](https://nextjs.org) helpers for [StitchAPI](https://stitchapi.dev).

Next App Router route handlers are Web-standard — they take a `Request` and return a `Response` — so a stitch already runs in one directly: define a `seam` once and call it in the handler. What's worth a helper is the two bits you'd otherwise hand-roll on the Web platform:

-   **`streamStitchSse(stitch.stream())`** — turn a streaming stitch into a `text/event-stream` `Response`.
-   **`stitchErrorResponse(err)`** — map a thrown `StitchError` to a `Response` with a safe status, or `undefined` for anything else so you can rethrow it.

Built on Web standards only (`Response`, `ReadableStream`, `TextEncoder`) — **no `next` import** — so the same helpers also work in Remix, SvelteKit endpoints, Bun, Deno, and Workers.

## Install

```sh
pnpm add @stitchapi/next@rc stitchapi@rc
```

`stitchapi` is the only peer dependency.

## A route handler

A non-streaming endpoint is just the stitch plus the error helper:

```ts
// app/api/users/[id]/route.ts
import { getUser } from '@/lib/api';

import { stitchErrorResponse } from '@stitchapi/next';

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params;
    try {
        return Response.json(await getUser({ params: { id } }));
    } catch (err) {
        const mapped = stitchErrorResponse(err);
        if (mapped) return mapped; // a Stitch failure → safe JSON Response
        throw err; // anything else falls through untouched
    }
}
```

`stitchErrorResponse` maps a `StitchError` to `502` by default (never leaking the upstream's status) and returns `undefined` for any other error, so the map-or-rethrow composition stays one branch; pass `{ status: (e) => e.status ?? 502 }` to propagate the upstream status. The body is a generic, status-tied message (`{ error: 'Bad Gateway' }`) — the raw `err.message` is withheld, since it can leak an internal hostname (`getaddrinfo ENOTFOUND payments.internal.corp`) or the upstream's status (`HTTP 401`). Opt in with `{ body: (e) => ({ error: e.message }) }` when the upstream messages are safe to expose.

## Streaming with SSE

`streamStitchSse` streams a stitch's events as `text/event-stream`. Each `delta` becomes one frame; an `error` event ends with a named `event: error` frame (a generic `data: error` by default — see below):

```ts
// app/api/chat/route.ts
import { chat } from '@/lib/api';

import { streamStitchSse } from '@stitchapi/next';

export async function POST(request: Request) {
    const { prompt } = await request.json();
    return streamStitchSse(chat({ body: { prompt } }).stream(), {
        delta: (c) => String(c), // pull text out of each chunk
        signal: request.signal, // abort the upstream if the client leaves
    });
}
```

Pass `request.signal` so a client disconnect tears the stitch down rather than leaving it running.

By default the `error` frame carries a generic `data: error` token, **not** the raw error message — echoing it can disclose internal network topology (a transport failure reads like `getaddrinfo ENOTFOUND payments.internal.corp`) or the upstream's status (`HTTP 401`) to the client. Pass `error` to opt in when the upstream messages are known safe to expose:

```ts
return streamStitchSse(chat({ body: { prompt } }).stream(), {
    error: (e) => e.message, // opt in to the raw upstream message
});
```

Both `delta` and `error` also take the full object form — `delta: { data, event, id }` and `error: { data, event, observe }` — e.g. `error.observe` logs the real failure server-side while the client still gets the generic token.

## License

Apache-2.0

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
