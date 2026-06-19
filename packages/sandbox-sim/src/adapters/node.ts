/**
 * S5 — Node fetch-shim adapter (entry point).
 *
 * Re-exports `createFetchShim` from the shared `./fetch-shim` core. Node 18+
 * ships the same WHATWG `URL`, `Headers`, `Response`, and `ReadableStream`
 * globals as the browser Worker environment, so the Node and browser adapters
 * currently share one implementation.
 *
 * This module is the place to specialise if a future Node-only surface needs a
 * divergent body reader (e.g. `Buffer`, `node:stream` `Readable`): swap the
 * re-export for a bespoke `createFetchShim` here.
 *
 * Environment assumptions: Node 18+ with `--experimental-fetch` (default on)
 * or Node 21+ where the fetch globals are stable.
 */
export { createFetchShim } from './fetch-shim';
