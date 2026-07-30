# @stitchapi/query-core

[![npm](https://img.shields.io/npm/v/@stitchapi/query-core?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/query-core)

A tiny, **framework-agnostic** reactive store wrapping a [StitchAPI](https://stitchapi.dev) call. It turns a one-shot `stitch(...)` into a `subscribe` / `getSnapshot` handle — the kind React's `useSyncExternalStore` (and the equivalent primitives in Vue, Svelte, and Solid) consume directly.

This package imports **no framework** and **no `node:*`**, so it is browser- and edge-safe. It is the shared core behind [`@stitchapi/react`](../react); the React hooks are a thin binding over it, which is what makes Vue/Svelte/Solid bindings cheap follow-ons.

## Why

A `stitch` is a typed declarative call: invoking it returns a `StitchResult<T>` that is both **awaitable** (the validated output) and **streamable** (`.stream()` yields `delta` chunks and a terminal `result`). StitchAPI deliberately is **not** a UI state library — it leaves the reactive lifecycle (status transitions, cancellation, re-fetching, streaming re-renders) to the host. This store owns exactly that lifecycle, and nothing more.

## Install

```sh
pnpm add @stitchapi/query-core@rc stitchapi@rc
```

`stitchapi` is a peer dependency (`^1.0.0-rc.1`).

## API

### `createStitchQuery(stitch, input, options?)`

Returns a `StitchQuery<T>`:

```ts
interface StitchQuery<T> {
    subscribe(listener: () => void): () => void;
    getSnapshot(): StitchQueryResult<T>;
    refetch(): void;
    cancel(): void;
    destroy(): void;
}
```

### `StitchQueryResult<T>`

```ts
interface StitchQueryResult<T> {
    status: 'idle' | 'pending' | 'streaming' | 'success' | 'error';
    data: T | undefined;
    error: unknown;
    chunks: readonly unknown[];
    isPending: boolean;
    isError: boolean;
    isSuccess: boolean;
    isStreaming: boolean;
}
```

Snapshots are **identity-stable** between real changes — the store only hands out a new object when something actually changed, so `useSyncExternalStore` never tears or loops.

### Options

| Option      | Default    | Meaning                                                                                                   |
| ----------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `streaming` | `false`    | Drive the call through `.stream()` and update state per `delta` (for `sse`/`stream` surfaces).            |
| `mode`      | `'append'` | Streaming fold: `'append'` collects chunks into `data`/`chunks`; `'replace'` keeps only the latest chunk. |
| `enabled`   | `true`     | Run immediately on creation. `false` starts `idle`; fetch lazily via `refetch()`.                         |
| `onSuccess` | —          | Called with the validated value on success.                                                               |
| `onError`   | —          | Called with the thrown reason on failure.                                                                 |

### TanStack Query interop

`@stitchapi/query-core` also owns the one shared implementation behind every framework binding's TanStack adapter — the key format cannot drift between frameworks:

```ts
import { deriveQueryKey, stitchQueryOptions } from '@stitchapi/query-core';
import type { StitchQueryOptions } from '@stitchapi/query-core';

// [name, sanitised input] — signal/onProgress dropped, secret header values redacted
const key = deriveQueryKey(getUser, { params: { id: '1' } });

// A TanStack-compatible `{ queryKey, queryFn }` POJO — no @tanstack/* dependency
const options = stitchQueryOptions(getUser, { params: { id: '1' } });
```

- **`stitchQueryOptions(stitch, input)`** returns a `StitchQueryOptions<T>` (`{ queryKey, queryFn }` — TanStack's own field names, kept verbatim as a standards-interop carve-out). Pass it straight to `useQuery` / `createQuery` / `injectQuery`.
- **`deriveQueryKey(stitch, input)`** builds the canonical cache key: a stable stitch name plus a sanitised input.
- **`nameOf(stitch)`** and **`keyInputFor(input)`** expose the two key segments for bindings that compose keys themselves. `keyInputFor` never puts the raw input in a key: it drops runtime-only `signal`/`onProgress` and redacts the values of secret-bearing headers (`authorization`, `cookie`, `*-token`, `*-api-key`, plus core's `isSecretKey` names — including anything widened via `registerSecretKey`).

## Example

```ts
import { createStitchQuery } from '@stitchapi/query-core';
import { stitch } from 'stitchapi';

const getUser = stitch({
    baseUrl: 'https://api.example.com',
    path: '/users/{id}',
});

const q = createStitchQuery(getUser, { params: { id: '1' } });
q.subscribe(() => {
    const s = q.getSnapshot();
    if (s.isSuccess) console.log(s.data);
});
```

### Streaming

```ts
// a streaming surface
import { createStitchQuery } from '@stitchapi/query-core';
import { sse } from 'stitchapi';

const tokens = sse({ url: 'https://api.example.com/chat' });
const q = createStitchQuery(tokens, undefined, { streaming: true });
// q.getSnapshot().chunks grows as each `delta` arrives; status is 'streaming'
// until the terminal `result`, then 'success'.
```

## License

Apache-2.0

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
