# @stitchapi/rtk-query

[![npm](https://img.shields.io/npm/v/@stitchapi/rtk-query?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/rtk-query)

[RTK Query](https://redux-toolkit.js.org/rtk-query/overview) bindings for [StitchAPI](https://stitchapi.dev). Use a stitch inside an RTK Query endpoint: RTK Query keeps owning the cache, tags, and generated hooks, while the stitch stays the **typed, validated, traced** call.

Reach for this when your app is already on Redux Toolkit / RTK Query. The adapters are plain functions (no React), so they work with both `@reduxjs/toolkit/query` and `@reduxjs/toolkit/query/react`.

## Install

```sh
pnpm add @stitchapi/rtk-query@rc stitchapi@rc @reduxjs/toolkit
```

`stitchapi` and `@reduxjs/toolkit` (`^2`) are peer dependencies. There is **no** `@stitchapi/query-core` dependency — RTK Query is the store.

## `stitchQueryFn` — a stitch as an endpoint

`stitchQueryFn(stitch)` returns an endpoint `queryFn`: on success `{ data }` with the validated output, on a throw `{ error }` with a **serialisable** error (so Redux holds no non-serialisable value). The error keeps the thrown error's `name` (the discriminator), `message`, and every JSON-survivable own field — for a `StitchError` / `RateLimitError` that is the full `status` / `attempts` / `body` / `url` set, so you can branch on a stored error exactly as on the thrown one. Fields that would not survive `JSON.stringify` (functions, class instances, the raw `response` carrier) are dropped.

```ts
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import { stitchQueryFn } from '@stitchapi/rtk-query';
import { stitch } from 'stitchapi';

const getUser = stitch({
    baseUrl: 'https://api.example.com',
    path: '/users/{id}',
});

export const api = createApi({
    baseQuery: fakeBaseQuery(),
    endpoints: (build) => ({
        getUser: build.query({ queryFn: stitchQueryFn(getUser) }),
    }),
});

export const { useGetUserQuery } = api;
// useGetUserQuery({ params: { id } })
```

`queryFn` bypasses the `baseQuery`, so `fakeBaseQuery()` is the natural base when every endpoint is a stitch; mix with a real `baseQuery` to keep both.

## `stitchStreamUpdater` — streaming into the cache

RTK Query is the one cache lib here that models streaming. `stitchStreamUpdater(stitch)` returns an endpoint `onCacheEntryAdded` that folds a streaming stitch's `delta` chunks into the cached array. Seed the endpoint with an empty array:

```ts
chat: build.query<number[], { prompt: string }>({
    queryFn: () => ({ data: [] }),
    onCacheEntryAdded: stitchStreamUpdater<number>(chat),
}),
```

The cached data is the accumulated chunks (`'append'`, default) or the latest chunk — pass the mode directly: `stitchStreamUpdater(chat, 'replace')` (≡ `{ mode: 'replace' }`). Streaming stops when the cache entry is removed (the last component unsubscribes).

## License

Apache-2.0

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
