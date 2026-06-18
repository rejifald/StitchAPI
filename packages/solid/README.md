# @stitchapi/solid

Solid bindings for [StitchAPI](https://stitchapi.dev). `createStitch` / `createStitchStream` primitives that reconcile a Solid `createStore` from the query store, plus an optional [TanStack Query](https://tanstack.com/query) adapter.

**Streaming-first.** A `stitch` can stream (`sse` / `stream` surfaces) — `createStitchStream` reconciles each `delta` chunk into the store as it arrives. That's the differentiator over plain request/response query libraries.

These primitives are a thin layer over [`@stitchapi/query-core`](../query-core), the framework-agnostic store that owns the reactive lifecycle. React / Vue / Svelte / Solid bindings are the same few lines against their own reactive primitive.

## Install

```sh
pnpm add @stitchapi/solid @stitchapi/query-core stitchapi solid-js
```

`stitchapi`, `@stitchapi/query-core`, and `solid-js` (`^1.8`) are peer dependencies. `@tanstack/solid-query` is an **optional** peer — only needed if you use `queryOptions`.

## `createStitch` — request / response

```tsx
import { createStitch } from '@stitchapi/solid';
import { stitch } from 'stitchapi';
import { Show } from 'solid-js';

const getUser = stitch({
    baseUrl: 'https://api.example.com',
    path: '/users/{id}',
});

function Profile(props: { id: string }) {
    // Pass an accessor so the query re-fetches when `props.id` changes.
    const user = createStitch(getUser, () => ({ params: { id: props.id } }));

    return (
        <Show when={!user.state.isPending} fallback={<Spinner />}>
            <Show when={!user.state.isError} fallback={<Retry onClick={user.refetch} />}>
                <h1>{user.state.data?.name}</h1>
            </Show>
        </Show>
    );
}
```

`input` and `options` may be plain values (read once) or accessors (`() => props.id`, a signal getter) — when an accessor's value changes the handle is recreated and re-fetched. The in-flight run is aborted on scope teardown (`onCleanup`).

## `createStitchStream` — live deltas

```tsx
import { createStitchStream } from '@stitchapi/solid';
import { sse } from 'stitchapi';
import { For } from 'solid-js';

const chat = sse({ url: 'https://api.example.com/chat' });

function Chat(props: { prompt: string }) {
    const c = createStitchStream(chat, () => ({ body: { prompt: props.prompt } }));
    return (
        <div>
            <For each={c.state.chunks as string[]}>{(chunk) => <span>{chunk}</span>}</For>
            <Show when={c.state.isStreaming}>
                <Cursor />
            </Show>
        </div>
    );
}
```

Same store shape as `createStitch`. `state.data` is the accumulated chunks (`mode: 'append'`, default) or the latest chunk (`mode: 'replace'`); `state.chunks` is the running list; `state.status` is `'streaming'` until the terminal `result`, then `'success'`.

## Store shape

```ts
interface StitchStore<T> {
    state: {
        status: 'idle' | 'pending' | 'streaming' | 'success' | 'error';
        data: T | undefined;
        error: unknown;
        chunks: readonly unknown[];
        isPending: boolean;
        isError: boolean;
        isSuccess: boolean;
        isStreaming: boolean;
    };
    refetch: () => void;
    cancel: () => void;
}
```

`state` is a Solid store proxy — read its fields inside JSX or an effect to track them fine-grained.

## Optional: TanStack Query

`queryOptions(stitch, input)` returns a plain `{ queryKey, queryFn }` object — no import of `@tanstack/solid-query` required, so it works even if you never install it.

```tsx
import { queryOptions } from '@stitchapi/solid';
import { createQuery } from '@tanstack/solid-query';

const query = createQuery(() => queryOptions(getUser, { params: { id: id() } }));
```

## License

Apache-2.0
