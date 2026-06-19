/**
 * S5 — Browser fetch-shim adapter (entry point).
 *
 * Re-exports `createFetchShim` from the shared `./fetch-shim` core. Returns a
 * function with the WHATWG `fetch(input, init?)` signature, backed entirely by
 * the sandbox-sim dispatch core. No real network is ever opened; an unknown
 * host/route returns the sandbox-404 response.
 *
 * Designed for injection into a Web Worker's scope:
 *   self.fetch = createFetchShim(handlers);
 *
 * This module is the place to specialise if a future browser-only surface ever
 * needs to diverge from the Node adapter; today both share one implementation.
 *
 * Environment assumptions: WHATWG `URL`, `Headers`, `Response`, `ReadableStream`,
 * and `TextEncoder` are available as globals (true in all modern Workers).
 */
export { createFetchShim } from './fetch-shim';
