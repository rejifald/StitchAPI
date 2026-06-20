// expoFetchAdapter — a streaming transport for Expo.
//
// Unlike bare React Native, Expo ships `expo/fetch`: a WinterCG-compliant fetch
// whose `Response#body` is a real `ReadableStream` (facebook/react-native#27741 is
// solved at the Expo layer). Core's `fetchAdapter` already hands back `response.body`
// unchanged when `req.stream` is set, so streaming on Expo is just `fetchAdapter`
// pointed at `expo/fetch` — no XHR shim, no `ReadableStream`/`TextDecoder` polyfills.
import { fetch as expoFetch } from 'expo/fetch';
import { fetchAdapter } from 'stitchapi';
import type { Adapter } from 'stitchapi';

/** Options for {@link expoFetchAdapter}. */
export interface ExpoFetchAdapterOptions {
    /**
     * Override the fetch implementation (testing / a custom build). Defaults to
     * `expo/fetch`'s streaming-capable `fetch`.
     */
    fetch?: typeof fetch;
}

/**
 * A stitch {@link Adapter} backed by `expo/fetch`, with full streaming support.
 *
 * ```ts
 * import { seam } from 'stitchapi';
 * import { expoFetchAdapter } from '@stitchapi/expo';
 *
 * const api = seam({ adapter: expoFetchAdapter() });
 * ```
 */
export function expoFetchAdapter(opts: ExpoFetchAdapterOptions = {}): Adapter {
    return fetchAdapter({ fetch: opts.fetch ?? expoFetch });
}
