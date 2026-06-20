// Minimal `expo/fetch` stub so the adapter module imports cleanly under vitest
// (node). Tests inject their own fetch, so this only needs to exist — it falls
// back to node's global fetch and is never the thing under test.
export const fetch = globalThis.fetch;
