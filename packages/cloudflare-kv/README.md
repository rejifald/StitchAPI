# @stitchapi/cloudflare-kv

[![npm](https://img.shields.io/npm/v/@stitchapi/cloudflare-kv?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/cloudflare-kv)

A **[Cloudflare Workers KV](https://developers.cloudflare.com/kv/)-backed
[`StitchStore`](https://stitchapi.dev)** for StitchAPI. Attach it on the edge and
the read-heavy halves of a stitch become fleet-wide, with **no change to the call
site** (DESIGN §13):

- **Cache** — cached responses live in KV, shared across every isolate and
  surviving cold starts.
- **Auth** — the cookie jar / token cache lives in KV, so sessions & tokens are
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

## A `get`/`set` store — what that means per feature

Workers KV is last-write-wins `get`/`put`/`delete` with **no atomic
read-modify-write**, so `cloudflareKvStore` implements only the two verbs the
`StitchStore` contract requires, `get` and `set`. It has none of the optional
capabilities — no `increment` counter, no `reserve` pacing cell, no
`lease`/`release` semaphore — rather than fake them. StitchAPI uses a capability
only when the store has it:

- **Cache** — fully supported, bulk invalidation included (a generation bump is a
  plain `set`).
- **Auth** — fully supported: cookie jars and tokens are `get`/`set`.
- **Throttle** — `rate` and `concurrency` hold **per isolate**, not across the
  fleet. The throttle says so once, with an `info` event (topic
  `throttle.per-process`) on its first call.

If you need a **fleet-wide throttle** at the edge, back it with a
**[Durable Object](https://developers.cloudflare.com/durable-objects/)**-based
`StitchStore` (a single writer, strongly consistent) or run `@stitchapi/redis`
over Upstash's HTTP API. KV remains the right backend for the rest — **cache and
shared sessions/tokens**, which is the overwhelmingly common edge need.

The store passes the base group of `conformance.store` from `stitchapi/testing`,
which checks the capabilities a store implements.

## Eventual consistency

KV is eventually consistent: a write can take **about 60 seconds** to reach every
location. A cache invalidation is a write, so for up to a minute a reader in
another location may still serve the entries you just invalidated.

Workers KV also allows **one write per second to the same key**. A bulk
invalidation (`cache.invalidate()`, `seam.invalidate()`) writes one generation
key, so rapid back-to-back calls can be rejected with a `429` — invalidate once
per change, or debounce.

## TTL semantics

KV's `expirationTtl` is in **seconds** and has a **60-second minimum**. The store
reconciles this with the StitchStore contract's millisecond TTLs for you:

- `ttl` (ms) → `Math.max(60, Math.ceil(ttl / 1000))` seconds.
- So a value asked to live for 5s lives for 60s (harmless for caches/sessions).
- No `ttl` → no expiry.

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
