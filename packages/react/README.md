# @stitchapi/react

[![npm](https://img.shields.io/npm/v/@stitchapi/react?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/react)

React bindings for [StitchAPI](https://stitchapi.dev). Tearing-free `useStitch` / `useStitchStream` hooks built on `React.useSyncExternalStore`, plus an optional [TanStack Query](https://tanstack.com/query) adapter.

**Streaming-first.** A `stitch` can stream (`sse` / `stream` surfaces) — `useStitchStream` re-renders as each `delta` chunk arrives. That's the differentiator over plain request/response query libraries.

These hooks are a thin layer over [`@stitchapi/query-core`](../query-core), the framework-agnostic store that owns the reactive lifecycle. Vue / Svelte / Solid bindings are the same few lines against their own external-store primitive.

## Install

```sh
pnpm add @stitchapi/react@rc @stitchapi/query-core@rc stitchapi@rc react
```

`stitchapi` (`>=0.7.0`) and `react` (`^18 || ^19`) are peer dependencies. `@tanstack/react-query` is an **optional** peer — only needed if you use `stitchQueryOptions`.

## `useStitch` — request / response

```tsx
import { useStitch } from '@stitchapi/react';
import { stitch } from 'stitchapi';

const getUser = stitch({
    baseUrl: 'https://api.example.com',
    path: '/users/{id}',
});

function Profile({ id }: { id: string }) {
    const { data, isPending, isError, refetch } = useStitch(getUser, {
        params: { id },
    });

    if (isPending) return <Spinner />;
    if (isError) return <Retry onClick={refetch} />;
    return <h1>{data.name}</h1>;
}
```

The query is re-created (and re-fetched) when the stitch identity or a structural key of `input` changes; pass `options.deps` to control that explicitly. The in-flight run is aborted on unmount.

## `useStitchStream` — live deltas

```tsx
import { useStitchStream } from '@stitchapi/react';
import { sse } from 'stitchapi';

const chat = sse({ url: 'https://api.example.com/chat' });

function Chat({ prompt }: { prompt: string }) {
    const { chunks, isStreaming } = useStitchStream(chat, { body: { prompt } });
    return (
        <div>
            {(chunks as string[]).map((c, i) => (
                <span key={i}>{c}</span>
            ))}
            {isStreaming && <Cursor />}
        </div>
    );
}
```

Same result shape as `useStitch`. `data` is the accumulated chunks (`mode: 'append'`, default) or the latest chunk (`mode: 'replace'`); `chunks` is the running list; `status` is `'streaming'` until the terminal `result`, then `'success'`.

## Result shape

```ts
interface UseStitchResult<T> {
    status: 'idle' | 'pending' | 'streaming' | 'success' | 'error';
    data: T | undefined;
    error: unknown;
    chunks: readonly unknown[];
    isPending: boolean;
    isError: boolean;
    isSuccess: boolean;
    isStreaming: boolean;
    refetch: () => void;
    cancel: () => void;
}
```

## Optional: TanStack Query

`stitchQueryOptions(stitch, input)` returns a plain `{ queryKey, queryFn }` object — no import of `@tanstack/react-query` required, so it works even if you never install it.

```tsx
import { stitchQueryOptions } from '@stitchapi/react';
import { useQuery } from '@tanstack/react-query';

const { data } = useQuery(stitchQueryOptions(getUser, { params: { id } }));
```

> [!NOTE]
>
> It is `stitchQueryOptions`, not a bare `queryOptions`, because TanStack Query
> exports its own `queryOptions` — the bare name would clash on import
> ([ADR 0012](../../docs/adr/0012-integration-symbol-naming.md)).

## License

Apache-2.0

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
