# @stitchapi/expo

[![npm](https://img.shields.io/npm/v/@stitchapi/expo?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/expo)

Expo bindings for [StitchAPI](https://stitchapi.dev). Expo ships [`expo/fetch`](https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api), a WinterCG-compliant fetch whose `Response#body` is a real `ReadableStream` — so the streaming gap bare React Native has is already solved at the Expo layer. This package is therefore thin:

-   **`expoFetchAdapter`** — a streaming transport, just core's `fetchAdapter` pointed at `expo/fetch`. **No XHR shim, no `TextDecoder` / `ReadableStream` polyfills.**
-   **`expoSecureStore`** — a `StitchStore` over [`expo-secure-store`](https://docs.expo.dev/versions/latest/sdk/securestore/), so auth tokens and cookie jars are stored **encrypted** at rest.

Everything else — the `useStitch` / `useStitchStream` hooks, the `asyncStorageStore`, and the `useAppActiveRefetch` / `useReconnectRefetch` lifecycle helpers — is re-exported from [`@stitchapi/react-native`](../react-native), so you import it all from `@stitchapi/expo`.

## Install

```sh
pnpm add @stitchapi/expo@rc @stitchapi/react@rc @stitchapi/query-core@rc stitchapi@rc
```

`stitchapi`, `react`, `react-native`, and `expo` are peer dependencies. `expo-secure-store`, `@react-native-async-storage/async-storage`, and `@react-native-community/netinfo` are **optional** peers — install the ones whose helpers you use.

## Wire it into a seam

```ts
import { expoFetchAdapter, expoSecureStore } from '@stitchapi/expo';
import * as SecureStore from 'expo-secure-store';
import { seam } from 'stitchapi';

export const api = seam({
    baseUrl: 'https://api.example.com',
    adapter: expoFetchAdapter(), // streaming via expo/fetch
    secretStore: expoSecureStore(SecureStore), // encrypted token / cookie vault
});
```

## Stream tokens into a component

```tsx
import { expoFetchAdapter, useStitchStream } from '@stitchapi/expo';
import { sse } from 'stitchapi/sse';

const chat = sse({
    url: 'https://api.example.com/chat',
    adapter: expoFetchAdapter(),
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

## Refetch on foreground / reconnect

These helpers come straight through from `@stitchapi/react-native` (they use RN's built-in `AppState`, which Expo apps have):

```tsx
import NetInfo from '@react-native-community/netinfo';
import {
    useAppActiveRefetch,
    useReconnectRefetch,
    useStitch,
} from '@stitchapi/expo';

const q = useStitch(getInbox, {});
useAppActiveRefetch(q);
useReconnectRefetch(q, NetInfo);
```

## The secure store

`expoSecureStore(SecureStore, options?)` reuses the AsyncStorage store's logic (JSON envelope, TTL, serialized atomic `incr`) over SecureStore's `*Async` methods. Engine keys are hex-encoded into SecureStore's restricted key charset (`[A-Za-z0-9._-]`). Keep individual values under SecureStore's ~2 KB limit — auth tokens fit comfortably. For non-secret throttle counters, pair it with the re-exported `asyncStorageStore`.

## License

Apache-2.0

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
