# @stitchapi/deno-kv

[![npm](https://img.shields.io/npm/v/@stitchapi/deno-kv?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/deno-kv)

A **[Deno KV](https://docs.deno.com/deploy/kv/manual/)-backed
[`StitchStore`](https://stitchapi.dev)** for StitchAPI. Attach it and two
process-local pieces of a stitch become fleet-wide, with **no change to the call
site** (DESIGN §13):

-   **Throttle** — rate counters live in Deno KV, so the rate budget is shared
    across every isolate (distributed rate limiting).
-   **Auth** — the cookie jar / token cache lives in Deno KV, so sessions & tokens
    are shared across isolates and survive restarts.

On Deno Deploy the same `Deno.openKv()` handle is replicated globally, so a
stitch's state becomes edge-native for free.

```ts
import { denoKvStore } from '@stitchapi/deno-kv';
import { seam } from 'stitchapi';

const api = seam({ store: denoKvStore(await Deno.openKv()) });
```

## Bring your own handle

This package **imports no Deno KV client** and never touches the `Deno` global.
It runs on a small structural `DenoKvLike` surface that a real `Deno.Kv` (from
`Deno.openKv()`, or the npm [`@deno/kv`](https://www.npmjs.com/package/@deno/kv)
package on Node/Bun) satisfies as-is — so the package has **zero runtime
dependencies** and is portable across runtimes:

```ts
// Deno / Deno Deploy
import { denoKvStore } from '@stitchapi/deno-kv';

const store = denoKvStore(await Deno.openKv());
```

```ts
// Node or Bun, via the @deno/kv npm package
import { openKv } from '@deno/kv';
import { denoKvStore } from '@stitchapi/deno-kv';

const store = denoKvStore(await openKv(process.env.DENO_KV_URL));
```

Anything that satisfies `DenoKvLike` (a test double, a proxy) is a drop-in.

## Atomic counters

Deno KV has no `INCR`, so `incr` is implemented as an **atomic compare-and-set
loop**: read the current value + its `versionstamp`, then
`atomic().check({ key, versionstamp }).set(key, next, { expireIn }).commit()`. If
another isolate raced us, the versionstamp moved, the commit returns `ok: false`,
and the loop re-reads and retries — so N concurrent increments net **exactly +N**
(proven by the store contract's "20 concurrent incrs net +20" rule).

The counter is a **fixed window** (matching the Redis adapter): the first increment
pins an absolute deadline `now + ttl`, and every increment inside that window keeps
the same deadline — so once the window elapses the next increment restarts at `1`.
Because Deno KV's `set` **replaces the whole entry, clearing any expiry** (unlike
Redis `INCR`, which _preserves_ the key's TTL), the counter is stored as a
`{ n, deadline }` value and each commit re-derives `expireIn` from the pinned
deadline. That keeps the window's expiry alive across every write instead of a
later increment silently wiping it and leaking the key forever. (`get` unwraps this
envelope back to the plain count, so nothing downstream sees the internal shape.)
The TTL unit is **milliseconds** — the same unit as the contract's `ttl`, and Deno
KV's own `expireIn` unit, so there's no conversion at the seam. An `incr` without
a `ttl` (or with `ttl <= 0`) has **no window**: the counter accumulates forever
and the key never expires — the same "absent `ttl` = no expiry" rule `set`
follows. `incrRetries` (default `100`) bounds the loop under pathological
contention.

The store owns no connection: `store.close()` delegates to the handle, so you
decide when KV shuts down.

`keyPrefix` namespaces every key — a string key `k` maps to `[keyPrefix, k]`
instead of the flat `[k]` — for sharing one KV database with other data:

```ts
denoKvStore(await Deno.openKv(), { keyPrefix: 'myapp' });
```

## Conformance

Compliance with the store seam is proven against `verifyStoreContract` from
`stitchapi/testing`, run hermetically against an in-memory `Deno.Kv` fake (a Map
with expiry + a monotonic versionstamp + an atomic builder that fails a commit
when a checked versionstamp is stale — so the compare-and-set retry path is
genuinely exercised). See `test/conformance.spec.ts`.

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
