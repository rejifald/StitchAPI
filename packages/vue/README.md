# @stitchapi/vue

[![npm](https://img.shields.io/npm/v/@stitchapi/vue?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/vue)

Vue 3 bindings for [StitchAPI](https://stitchapi.dev). Reactive `useStitch` / `useStitchStream` composables backed by Vue's reactivity, plus an optional [TanStack Query](https://tanstack.com/query) adapter.

**Streaming-first.** A `stitch` can stream (`sse` / `stream` surfaces) — `useStitchStream` re-renders as each `delta` chunk arrives. That's the differentiator over plain request/response query libraries.

These composables are a thin layer over [`@stitchapi/query-core`](../query-core), the framework-agnostic store that owns the reactive lifecycle. React / Svelte / Solid bindings are the same few lines against their own reactive primitive.

## Install

```sh
pnpm add @stitchapi/vue@rc @stitchapi/query-core@rc stitchapi@rc vue
```

`stitchapi` (`>=0.7.0`) and `vue` (`^3.4`) are peer dependencies. `@tanstack/vue-query` is **not** required — `stitchQueryOptions` returns a plain object.

## `useStitch` — request / response

```vue
<script setup lang="ts">
import { useStitch } from '@stitchapi/vue';
import { stitch } from 'stitchapi';

const props = defineProps<{ id: string }>();

const getUser = stitch({
    baseUrl: 'https://api.example.com',
    path: '/users/{id}',
});

// `input` may be a value, a `ref`, or a getter — a getter re-fetches when its
// structural key changes.
const { data, isPending, isError, refetch } = useStitch(getUser, () => ({
    params: { id: props.id },
}));
</script>

<template>
    <Spinner v-if="isPending" />
    <Retry v-else-if="isError" @click="refetch" />
    <h1 v-else>{{ data?.name }}</h1>
</template>
```

The query is re-created (and re-fetched) when the stitch's name or a structural key of `input` changes. The in-flight run is aborted when the component's scope is disposed.

## `useStitchStream` — live deltas

```vue
<script setup lang="ts">
import { useStitchStream } from '@stitchapi/vue';
import { sse } from 'stitchapi';

const props = defineProps<{ prompt: string }>();
const chat = sse({ url: 'https://api.example.com/chat' });

const { chunks, isStreaming } = useStitchStream(chat, () => ({
    body: { prompt: props.prompt },
}));
</script>

<template>
    <span v-for="(c, i) in chunks" :key="i">{{ c }}</span>
    <Cursor v-if="isStreaming" />
</template>
```

Same return shape as `useStitch`. `data` is the accumulated chunks (`mode: 'append'`, default) or the latest chunk (`mode: 'replace'`); `chunks` is the running list; `status` is `'streaming'` until the terminal `result`, then `'success'`.

## Return shape

Each field is a `ComputedRef`, so destructuring keeps reactivity (and `.value` is unwrapped automatically in templates):

```ts
interface VueUseStitchResult<T> {
    status: ComputedRef<'idle' | 'pending' | 'streaming' | 'success' | 'error'>;
    data: ComputedRef<T | undefined>;
    error: ComputedRef<unknown>;
    chunks: ComputedRef<readonly unknown[]>;
    isPending: ComputedRef<boolean>;
    isError: ComputedRef<boolean>;
    isSuccess: ComputedRef<boolean>;
    isStreaming: ComputedRef<boolean>;
    refetch: () => void;
    cancel: () => void;
}
```

## Optional: TanStack Query

`stitchQueryOptions(stitch, input)` returns a plain `{ queryKey, queryFn }` object — no import of `@tanstack/vue-query` required, so it works even if you never install it.

```ts
import { stitchQueryOptions } from '@stitchapi/vue';
import { useQuery } from '@tanstack/vue-query';

const { data } = useQuery(stitchQueryOptions(getUser, { params: { id } }));
```

## License

Apache-2.0

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
