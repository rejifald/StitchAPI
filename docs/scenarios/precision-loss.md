# Scenario: the ID that changed on the way in

**Researched:** 2026-08-05 · **Status:** research captured, verification pending
**Slug:** `precision-loss`

---

## The use case

You integrate an API whose IDs are 64-bit integers — Discord and Twitter/X snowflakes, most
database primary keys, Stripe-style amounts in a `bigint` column. The vendor sends them as JSON
numbers. You read them in JavaScript.

Some of them arrive as a **different number than the one that was sent**, and nothing anywhere
reports an error.

## Why it is not straightforward

`JSON.parse` produces IEEE 754 doubles. Integers above `Number.MAX_SAFE_INTEGER`
(`9007199254740991`, i.e. 2⁵³−1) are not all representable, so consecutive integers start
sharing a single double. `JSON.parse('9007199254740993')` returns `9007199254740992`. No throw,
no warning, no flag.

Three properties make this genuinely hard rather than merely annoying:

- **The damage happens before your code runs.** By the time any application-level hook, schema
  or interceptor sees the value, it is already a `Number` and the original digits are gone.
  Validation cannot help: the corrupted value is a perfectly valid number, and often a perfectly
  plausible ID. A schema that says `z.number().int()` passes it.
- **It is silent and data-dependent.** IDs below 2⁵³ round-trip perfectly, so the bug does not
  appear in dev, in tests, or for the first several years of a vendor's ID sequence. Snowflake
  IDs are time-ordered, which means **the failure arrives on a date**, fleet-wide, for everyone
  at once.
- **The fix is not local.** The only real repair is to not use `JSON.parse` — which means a
  different parser, which means the values are now `BigInt` or `string`, which breaks
  `JSON.stringify`, structured cloning, most cache serialisers, arithmetic, and every schema
  validator expecting `number`. You trade a silent bug for a loud cascade.

And it is a **cross-language interoperability** bug specifically: Python and Java parse the same
payload exactly. The vendor's own tests pass. The bug exists only on your side of the wire, which
makes it very hard to report and very easy to be told it is your problem.

## Evidence this bites real projects

- **The canonical shape** — [`JSON.parse` loses precision on Discord snowflake IDs](https://github.com/openclaw/openclaw/issues/23170):
  a tool call carrying a channel ID like `1234567890123456789` silently rounds, and the request
  fails with `Unknown Channel` — an error message that points nowhere near the cause.
- **Why stringify-the-id became the convention** —
  [JavaScript-compatible snowflake IDs](https://samifayoumi.ca/blog/001_53bit-snowflakeid/):
  vendors that care ship IDs as strings precisely because of this, and Twitter famously added an
  `id_str` field alongside `id` for exactly this reason.
- **The general problem** —
  [Safely handling large integers in JSON](https://www.pullrequest.com/blog/safely-handling-large-integers-in-json-best-practices-and-pitfalls/)
  and [JSON number precision: IEEE 754, BigInt and decimal](https://jsonic.io/guides/json-number-precision).
- **Money has the same shape** — a decimal amount is not exactly representable either, which is
  why financial APIs send integer minor units or decimal strings.

## The common solutions, and what each costs

| Approach                          | What it is                         | Where it breaks                                                                                                 |
| --------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Use the vendor's string field** | Read `id_str` instead of `id`.     | Correct and free — when the vendor provides one. Most do not.                                                   |
| **`json-bigint` / custom parser** | Replace `JSON.parse` wholesale.    | Correct at the boundary, and now every consumer must handle `BigInt`: no `JSON.stringify`, no mixed arithmetic. |
| **Reviver on `JSON.parse`**       | `JSON.parse(text, reviver)`.       | **Does not work** — the reviver receives the already-parsed `Number`. The digits are gone before it is called.  |
| **Regex the raw text first**      | Quote big integers before parsing. | Works, and is a JSON parser written in regex. Breaks on numbers inside strings.                                 |
| **Keep everything as strings**    | Treat all IDs as opaque text.      | The most robust answer, and it must be enforced by convention across every layer.                               |
| **Hope**                          | Most IDs are under 2⁵³ today.      | Time-ordered IDs mean this expires on a schedule you do not control.                                            |

**Summary of the state of the art:** intercept before `JSON.parse`, or get a string from the
vendor. There is no post-hoc repair, because the information is destroyed at parse time.

---

## What to verify against StitchAPI

The library's own type comment settles where the damage happens:

```ts
// Parsed JSON when possible, else text — OR a `ReadableStream<Uint8Array>` when `stream` was set.
body: unknown;
```

`AdapterResponse.body` is **already parsed** (`http-adapter.ts:135`,
`parsed = text === '' ? undefined : JSON.parse(text)`). So every seam this pass has relied on —
`Surface.interpret`, `transform`, `output`, `drift()`, `hooks.onResponse` — runs **downstream of
the corruption**, and none of them can see the raw text.

That makes the `Adapter` the only candidate seam, which is the one place the previous nineteen
scenarios have mostly treated as fixed infrastructure.

**Claims to test with runnable offline code:**

1. **C1** — **DECIDING CLAIM.** Does the default path corrupt? Measure exact in/out values for a
   snowflake ID, `2^53+1`, a large `bigint` primary key, and a decimal amount. Confirm it is
   silent — no event, no finding, no warning.
2. **C2** — **DECIDING CLAIM.** Can **anything** downstream detect it? Try `output` with
   `z.number().int()`, `z.bigint()`, `z.string()`; `drift()` (does it compare against raw text or
   against the parsed body?); `.inspect().raw`; `hooks.onResponse`; a `TraceSink`. My prediction
   is that all fail, because `raw` is already the parsed body — **verify or refute that**.
3. **C3** — can a custom `Adapter` fix it, and what does that cost? Swap in a bigint-aware parse
   and report what breaks: `cache` serialisation, `.inspect()`, `__config` round-trip, trace
   sinks, `output` validators.
4. **C4** — does `cache` survive a `BigInt` body? A store that `JSON.stringify`s will throw
   `Do not know how to serialize a BigInt`. Test `memoryStore` and a JSON-backed store.
5. **C5** — the **request** side: does a large ID survive going out — in `params`, `query`, and a
   JSON `body`? A `bigint` in a request body is a `JSON.stringify` throw, not silent corruption.
6. **C6** — do the `stream` / `download` / `sse` surfaces see raw bytes, and does that make them
   a safer path for a precision-sensitive payload?
7. **C7** — is there any spelling that makes this **loud** rather than silent — a drift finding,
   an `info` event, anything? What is the minimum user code for a detector?
8. **C8** — assemble the safest available setup; report seams and line count, and state plainly
   what it costs the rest of the config.

C1 and C2 decide this. C1 establishes the damage; C2 asks whether a library whose flagship
feature is **contract drift detection** can notice its most basic form — a value that is not the
value the vendor sent.
