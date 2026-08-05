# A `bigint` in `params` silently vanishes, while `query` handles it exactly

**Status:** drafted, not filed
**Scenario:** [precision-loss](../precision-loss.md)
**Proofs:** `docs/scenarios/proofs/precision-loss/` (8 scripts, 191 checks, offline)

## 1. BUG — the two URL positions disagree, and one of them loses data silently

Surveyed all four outbound positions with the same `1234567890123456789n`:

| position     | bigint outcome                                                                         |
| ------------ | -------------------------------------------------------------------------------------- |
| `query`      | **exact** — `?since=1234567890123456789`                                               |
| `form` body  | **exact** — `id=1234567890123456789`                                                   |
| JSON `body`  | **throws** `Do not know how to serialize a BigInt`, no request made — loud and correct |
| **`params`** | **vanishes** — URL becomes `https://api.vendor.test/v1/things/`, no error, no event    |

`expandTemplateVar` (`packages/core/src/util.ts:392`) branches on
`string | number | boolean`:

```ts
if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
) {
```

A `bigint` falls through, and `Object.entries(<bigint>)` is `[]`, so the segment expands to
nothing. The sibling `query` walker (`stringifyLeaf`, `util.ts:332`) **does** list `bigint`.

The asymmetry is the bug: the same value in the same URL is exact in one slot and gone in the
other, and the failing one fails silently. A request to `/v1/things/` is a request for a
different resource — likely a list endpoint — not an error.

**Ask:** add `bigint` to `expandTemplateVar`'s branch, matching `stringifyLeaf`. If a bigint path
param is genuinely unsupported, throw rather than emit an empty segment.

## 2. Why this slot in particular

`params` is where an ID goes. And IDs above 2⁵³ are exactly where `bigint` is the correct type —
so the one slot that drops bigints is the one that receives them.

The end-to-end shape, measured in eight lines: read an id from a vendor response, hand it
straight back as a path param, and the request goes to `/v1/things/1234567890123456800`. That is
a **third** distinct digit string — not the `…789` the vendor sent, and not the `…768` a debugger
shows you — because `JSON.parse` rounds on the way in and `String(number)` renders the
shortest round-trip form on the way out. This is the well-known
[Discord `Unknown Channel`](https://github.com/openclaw/openclaw/issues/23170) shape, and nothing
in the event spine reports it.

## 3. Smaller, same area

- **`JSON.stringify(report)` throws under a bigint body** with `Do not know how to serialize a
BigInt`. `.report()` is documented as safe to log, so a diagnostic added while debugging a
  precision problem is itself a crash. (`trace.ts` gets this right — it ships a `bigintSafe`
  replacer explicitly so tracing cannot break the call it observes. `.report()` could borrow it.)
- **A JSON-serialising `store` throws on the write and the throw is fatal** (`ok: false`), not a
  degraded cache miss. `memoryStore` survives, holding values by reference.
- **`wire.response` and `transform` are independent keys.** Setting `wire: { response: 'text' }`
  and forgetting `transform` silently returns a **string** where an object is expected — no
  throw. They are independent at the type level too: `transform` is `(body: unknown) => unknown`,
  so a parser written `(text: string)` does not typecheck in the slot even though
  `wire.response: 'text'` guarantees a string at runtime. A narrowed `transform` signature under
  `wire.response: 'text'`, or a warning when one is set without the other, would close it.
- **`wire.response` has no guide page.** It is the one config key that recovers a corrupted ID,
  and it appears in the docs only in passing — in the GraphQL guide's list of what `wire.body`
  does _not_ do. Worth documenting on its own, with this scenario as the motivating example.

## Not a bug, recorded so a fix doesn't chase it

`JSON.parse` corrupting integers above 2⁵³ is JavaScript, not StitchAPI, and the library's own
default (`http-adapter.ts:135`) is the correct default. The finding worth acting on is only that
**nothing reports it** — the spine is four events with zero drift, zero error and zero info — and
that `wire: { response: 'text' }` already solves it for anyone who knows the key exists.

---

_Found by an automated scenario pass. Line references verified against `main` at the time of
filing. Runnable proof scripts live under `docs/scenarios/proofs/precision-loss/` on the branch
`claude/api-integration-scenarios-436a38`._
