# @stitchapi/svelte

Svelte bindings for [StitchAPI](https://stitchapi.dev). `stitchStore` / `stitchStreamStore` are real Svelte stores (`{ subscribe }`) wrapping a stitch call, plus an optional [TanStack Query](https://tanstack.com/query) adapter. Works on **Svelte 4 and 5** (built on `readable` from `svelte/store`, the surface that is unchanged across both).

**Streaming-first.** A `stitch` can stream (`sse` / `stream` surfaces) — `stitchStreamStore` emits a new state as each `delta` chunk arrives. That's the differentiator over plain request/response query libraries.

These stores are a thin layer over [`@stitchapi/query-core`](../query-core), the framework-agnostic store that owns the reactive lifecycle. React / Vue / Solid bindings are the same few lines against their own external-store primitive.

## Install

```sh
pnpm add @stitchapi/svelte @stitchapi/query-core stitchapi svelte
```

`stitchapi` and `svelte` (`^4 || ^5`) are peer dependencies. `@tanstack/svelte-query` is an **optional** peer — only needed if you use `queryOptions`.

## `stitchStore` — request / response

```svelte
<script lang="ts">
    import { stitchStore } from '@stitchapi/svelte';
    import { stitch } from 'stitchapi';

    const getUser = stitch({
        baseUrl: 'https://api.example.com',
        path: '/users/{id}',
    });

    export let id: string;
    const user = stitchStore(getUser, { params: { id } });
</script>

{#if $user.isPending}
    <Spinner />
{:else if $user.isError}
    <Retry onclick={user.refetch} />
{:else}
    <h1>{$user.data?.name}</h1>
{/if}
```

The run starts on the store's first subscriber (so `$user` fetches when the component mounts) and is aborted when the last subscriber leaves (component teardown). Call `refetch()` to re-run, `cancel()` to abort. Re-create the store when `input` changes — derive it in a `$:` block keyed on the input.

## `stitchStreamStore` — live deltas

```svelte
<script lang="ts">
    import { stitchStreamStore } from '@stitchapi/svelte';
    import { sse } from 'stitchapi';

    const chat = sse({ url: 'https://api.example.com/chat' });
    export let prompt: string;
    const tokens = stitchStreamStore(chat, { body: { prompt } });
</script>

{#each $tokens.chunks as c}<span>{c}</span>{/each}
{#if $tokens.isStreaming}<Cursor />{/if}
```

Same state shape as `stitchStore`. `data` is the accumulated chunks (`mode: 'append'`, default) or the latest chunk (`mode: 'replace'`); `chunks` is the running list; `status` is `'streaming'` until the terminal `result`, then `'success'`.

`useStitch` / `useStitchStream` are aliases of these two, for callers who prefer the `use*` naming.

## State shape

```ts
interface StitchQueryState<T> {
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

The store value is this state; `refetch` / `cancel` are attached as methods on the store.

## Optional: TanStack Query

`queryOptions(stitch, input)` returns a plain `{ queryKey, queryFn }` object — no import of `@tanstack/svelte-query` required, so it works even if you never install it.

```ts
import { queryOptions } from '@stitchapi/svelte';
import { createQuery } from '@tanstack/svelte-query';

const query = createQuery(queryOptions(getUser, { params: { id } }));
```

## License

Apache-2.0
