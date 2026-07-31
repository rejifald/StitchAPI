# @stitchapi/react-native

[![npm](https://img.shields.io/npm/v/@stitchapi/react-native?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/react-native)

React Native bindings for [StitchAPI](https://stitchapi.dev). The `useStitch` / `useStitchStream` hooks are re-exported verbatim from [`@stitchapi/react`](../react) — they are pure `useSyncExternalStore` over the shared [`@stitchapi/query-core`](../query-core) store and run unchanged on React Native. What this package **adds** is the platform glue bare RN needs:

- **`rnStreamAdapter`** — a streaming transport. RN's global `fetch` cannot stream (`response.body` is `undefined`, [facebook/react-native#27741](https://github.com/facebook/react-native/issues/27741)); this reads `XMLHttpRequest.responseText` incrementally and surfaces it as a `ReadableStream`, which is exactly what core's `sse` / `stream` decoders consume.
- **`asyncStorageStore`** — a `StitchStore` over AsyncStorage, so login sessions, cookie jars, and tokens survive app restarts.
- **`useAppActiveRefetch` / `useReconnectRefetch`** — refetch on app-foreground / on reconnect, the data lifecycle a mobile app expects.

> On **Expo**, use [`@stitchapi/expo`](../expo) instead — `expo/fetch` streams natively, so it needs no XHR shim or polyfills.

## Install

```sh
pnpm add @stitchapi/react-native@rc @stitchapi/react@rc @stitchapi/query-core@rc stitchapi@rc
```

`stitchapi`, `react`, and `react-native` are peer dependencies. `@react-native-async-storage/async-storage` and `@react-native-community/netinfo` are **optional** peers — install them only for the store / reconnect helpers.

### Polyfills (streaming only)

Hermes ships no `TextEncoder` / `TextDecoder` / `ReadableStream`, which the streaming decoder needs. Install them once at your app's entry:

```ts
import 'react-native-polyfill-globals/auto';
```

`rnStreamAdapter` throws a precise error (via `assertStreamingPolyfills`) if they're missing. **Non-streaming** stitches work without any polyfill.

## Wire it into a seam

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { asyncStorageStore, rnStreamAdapter } from '@stitchapi/react-native';
import { seam } from 'stitchapi';

export const api = seam({
    baseUrl: 'https://api.example.com',
    adapter: rnStreamAdapter(), // streams when asked, buffers (xhrAdapter) otherwise
    store: asyncStorageStore(AsyncStorage), // sessions/tokens persist across restarts
});
```

## Stream tokens into a component

```tsx
import { useStitchStream } from '@stitchapi/react-native';
import { sse } from 'stitchapi/sse';

const chat = sse({
    url: 'https://api.example.com/chat',
    adapter: rnStreamAdapter(),
});

function Chat({ prompt }: { prompt: string }) {
    const { chunks, isStreaming } = useStitchStream(chat, { body: { prompt } });
    return (
        <Text>
            {(chunks as string[]).join('')}
            {isStreaming ? '▌' : null}
        </Text>
    );
}
```

`useStitch` / `useStitchStream` / `stitchQueryOptions` and their types are re-exported here, so you import everything from `@stitchapi/react-native`.

## Refetch on foreground / reconnect

```tsx
import NetInfo from '@react-native-community/netinfo';
import {
    useAppActiveRefetch,
    useReconnectRefetch,
    useStitch,
} from '@stitchapi/react-native';

function Inbox() {
    const q = useStitch(getInbox, {});
    useAppActiveRefetch(q); // refetch when the app returns to the foreground
    useReconnectRefetch(q, NetInfo); // refetch when connectivity returns
    // ...
}
```

`useReconnectRefetch` takes the NetInfo module positionally; pass the options envelope (`{ netInfo, enabled }`) when you also need `enabled`. Both subscriptions are also available as plain functions — `onAppActive(appState, cb)` and `onReconnect(netInfo, cb)` — for use outside React.

## The persistent store

`asyncStorageStore(storage, options?)` accepts any client matching `{ getItem, setItem, removeItem }` (the community AsyncStorage module, an MMKV shim, a test double). Values ride in a JSON envelope with an absolute expiry (AsyncStorage has no native TTL); `increment` is serialized so concurrent increments stay atomic — the throttle counter behaves exactly as it does on Redis. Pass `keyPrefix` to namespace (default `'stitch:'` — AsyncStorage is the app's one shared bucket, so the store namespaces by default), `now` to inject a clock in tests.

## License

Apache-2.0

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
