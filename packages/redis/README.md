# @stitchapi/redis

A **Redis-backed [`StitchStore`](https://stitchapi.dev)** for StitchAPI. Attach
it and two process-local pieces of a stitch become fleet-wide, with **no change
to the call site** (DESIGN §13):

-   **Throttle** — rate counters live in Redis, so the rate budget is shared across
    every worker (distributed rate limiting).
-   **Auth** — the cookie jar / token cache lives in Redis, so sessions & tokens are
    shared across workers and survive restarts.

```ts
import { fromIoredis, redisStore } from '@stitchapi/redis';
import Redis from 'ioredis';
import { seam } from 'stitchapi';

const api = seam({
    store: redisStore(fromIoredis(new Redis(process.env.REDIS_URL))),
});
```

## Bring your own driver

This package **imports no Redis client**. It runs on a small normalized
`RedisDriver` surface, and ships adapters for the popular clients — pick the one
you already use. `ioredis` and `redis` are **optional** peer dependencies;
`@upstash/redis` is matched **structurally** (no declared dependency at all — just
install it in your own app), so the edge client never weighs on Node-only users:

```ts
// ioredis
import { fromIoredis, redisStore } from '@stitchapi/redis';
import Redis from 'ioredis';

const store = redisStore(fromIoredis(new Redis(process.env.REDIS_URL)));
```

```ts
// node-redis (v4 / v5) — connect first
import { fromNodeRedis, redisStore } from '@stitchapi/redis';
import { createClient } from 'redis';

const client = await createClient({ url: process.env.REDIS_URL }).connect();
const store = redisStore(fromNodeRedis(client));
```

```ts
// @upstash/redis — edge / serverless HTTP Redis, no socket
import { fromUpstash, redisStore } from '@stitchapi/redis';
import { Redis } from '@upstash/redis';

const store = redisStore(fromUpstash(Redis.fromEnv()));
```

`fromUpstash` is the edge path: Upstash speaks Redis over HTTP, so the **same**
store (same atomic INCR+EXPIRE Lua) runs from Vercel/Cloudflare edge functions
with no TCP connection — only the dialect differs (`set { px }`, positional
`eval(script, keys, args)`, JSON auto-deserialized replies, no `quit`).

```ts
// anything else — satisfy RedisDriver yourself (cluster proxy, mock, another client)
import { redisStore } from '@stitchapi/redis';

const store = redisStore({
    get: (k) => myClient.get(k),
    set: (k, v, ttlMs) => myClient.set(k, v, ttlMs),
    del: (k) => myClient.del(k),
    incr: (k, ttlMs) => myClient.incrWithTtl(k, ttlMs), // atomic INCR + first-time PEXPIRE
});
```

`incr` must be **atomic** and set the key's TTL **only when it creates the
counter** — `fromIoredis` / `fromNodeRedis` do this with a single Lua `EVAL`
(`INCR`, then `PEXPIRE` only when the value is `1`), so a window can't slide
forever and a crash can't strand an immortal counter.

The store owns no connection: `store.close()` delegates to the driver, so you
decide when the client shuts down.

`keyPrefix` namespaces every key for sharing one Redis with other data:

```ts
redisStore(fromIoredis(client), { keyPrefix: 'myapp:' });
```

## Distributed pacing

With a shared store the rate limiter is **even-spaced across the fleet**: grants
land one `window / limit` apart, the same cadence the in-process limiter uses — no
fixed-window boundary bursts. **Concurrency limits stay in-process** (a shared
store distributes the rate budget, not the concurrency semaphore). Under
_sustained_ overload (offered load above the limit for longer than one window),
distributed pacing is approximate at window edges; see the
[pluggable-store guide](https://stitchapi.dev/docs/guides/state/pluggable-store)
for the exact semantics.

## Conformance

Compliance with the store seam is proven against `verifyStoreContract` from
`stitchapi/testing`, for all three driver adapters (`fromIoredis`,
`fromNodeRedis`, `fromUpstash`). Set `REDIS_URL` to additionally run the contract
against a live Redis:

```bash
REDIS_URL=redis://localhost:6379 pnpm --filter @stitchapi/redis test
```
