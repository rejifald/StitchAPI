# @stitchapi/swr

[![npm](https://img.shields.io/npm/v/@stitchapi/swr?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/swr)

[SWR](https://swr.vercel.app) bindings for [StitchAPI](https://stitchapi.dev). `useStitchSWR` runs a stitch as an SWR fetcher, so SWR keeps owning caching, deduping, and revalidation while the stitch stays the **typed, validated, traced** call.

Reach for this when your app is already on SWR. If you want StitchAPI to own the lifecycle directly — especially **streaming** (`useStitchStream`), which SWR doesn't model — use [`@stitchapi/react`](../react) instead.

## Install

```sh
pnpm add @stitchapi/swr stitchapi swr react
```

`stitchapi`, `swr` (`^2`), and `react` (`^18 || ^19`) are peer dependencies. There is **no** `@stitchapi/query-core` dependency — SWR is the store.

## `useStitchSWR`

```tsx
import { useStitchSWR } from '@stitchapi/swr';
import { stitch } from 'stitchapi';

const getUser = stitch({
    baseUrl: 'https://api.example.com',
    path: '/users/{id}',
});

function Profile({ id }: { id: string }) {
    const { data, error, isLoading } = useStitchSWR(getUser, {
        params: { id },
    });
    if (isLoading) return <Spinner />;
    if (error) return <Retry />;
    return <h1>{data?.name}</h1>;
}
```

The return value is SWR's own `SWRResponse` — `data`, `error`, `isLoading`, `isValidating`, `mutate`. Pass SWR options as the third argument:

```tsx
useStitchSWR(getUser, { params: { id } }, { refreshInterval: 5000 });
```

The cache key is the stitch's `name` plus the input, so two components calling the same stitch with the same input **dedupe** to one request.

## Conditional fetching & `mutate`

`swrKey(stitch, input)` returns that key, for SWR's null-key conditional pattern or a targeted `mutate`:

```tsx
import { swrKey } from '@stitchapi/swr';
import useSWR from 'swr';

// Skip the request until `id` exists.
const { data } = useSWR(id ? swrKey(getUser, { params: { id } }) : null, () =>
    getUser({ params: { id } }),
);
```

## License

Apache-2.0
