# @stitchapi/cloudflare-kv

[![npm](https://img.shields.io/npm/v/@stitchapi/cloudflare-kv?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/cloudflare-kv)

A **[Cloudflare Workers KV](https://developers.cloudflare.com/kv/)-backed
[`StitchStore`](https://stitchapi.dev)** for StitchAPI. Attach it on the edge and
the read-heavy halves of a stitch become fleet-wide, with **no change to the call
site** (DESIGN §13):

-   **Cache** — cached responses live in KV, shared across every isolate and
    surviving cold starts.
-   **Auth** — the cookie jar / token cache lives in KV, so sessions & tokens are
    shared across isolates and persist between requests.

```ts
import { cloudflareKvStore } from '@stitchapi/cloudflare-kv';
import { seam } from 'stitchapi';

export default {
    async fetch(req, env) {
        const api = seam({ store: cloudflareKvStore(env.MY_KV) });
        // ...use `api`
    },
};
```

The package is **Web-API only** (no `node:*`), so it runs in a Worker, in Pages
Functions, and in any other edge runtime. It **imports no Cloudflare runtime
types** — it runs on a small structural `KVNamespaceLike` surface that a real
`KVNamespace` binding satisfies as-is, so there's no `@cloudflare/workers-types`
dependency and a test double is a drop-in.

## `increment` is unsupported on Workers KV — use a Durable Object

> **Workers KV has no atomic increment.** It is last-write-wins `get`/`put`/
> `delete` only, so a distributed throttle counter built on it would **undercount
> under concurrency and silently break rate limiting**. Rather than do that,
> `cloudflareKvStore(...).increment(...)` **throws** a clear, documented error.

If you need a **distributed throttle**, back it with a
**[Durable Object](https://developers.cloudflare.com/durable-objects/)**-based
`StitchStore` instead: a Durable Object gives you the single-writer,
strongly-consistent counter that an atomic `increment` requires. KV remains the right
backend for the rest — **cache and shared sessions/tokens** (`get`/`set`), which
is the overwhelmingly common edge need.

## TTL semantics

KV's `expirationTtl` is in **seconds** and has a **60-second minimum**. The store
reconciles this with the StitchStore contract's millisecond TTLs for you:

-   `ttl` (ms) → `Math.max(60, Math.ceil(ttl / 1000))` seconds.
-   So a value asked to live for 5s lives for 60s (harmless for caches/sessions).
-   No `ttl` → no expiry (`ttl` is optional on both `set` and `increment`).

`set(key, undefined)` deletes the key (the cache's delete, ADR 0003 §8). The store
owns no connection, so there is no `close()`.

## `keyPrefix`

Namespace every key for sharing one KV namespace with other data:

```ts
cloudflareKvStore(env.MY_KV, { keyPrefix: 'myapp:' });
```

## Bring your own namespace

Anything satisfying `KVNamespaceLike` works — a real binding, a proxy, or a mock:

```ts
import { cloudflareKvStore } from '@stitchapi/cloudflare-kv';

const store = cloudflareKvStore({
    get: (k) => myKv.get(k),
    put: (k, v, opts) => myKv.put(k, v, opts), // opts.expirationTtl in seconds
    delete: (k) => myKv.delete(k),
});
```

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
