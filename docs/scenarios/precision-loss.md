# Scenario: the ID that changed on the way in

**Researched:** 2026-08-05 · **Re-verified:** 2026-08-15 (Zod 4, post-#661) · **Status:** ✅
verified (8 claims, 191 checks, offline) · page shipped
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
  plausible ID. A schema that says `z.number().int()` passes it. _(True on Zod 3, when this was
  captured; Zod 4's `.int()` caps at 2⁵³−1 and now rejects it — see the verification result.)_
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

---

## Verification result

**All 8 claims verified**, 191 checks across 8 scripts, re-run by me before writing up.

| Claim                                   | Verdict                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| C1 — does the default path corrupt?     | **CONFIRMED and silent** — 4 events, 0 findings; sent digits appear nowhere in the spine                  |
| C2 — can anything downstream detect it? | **PARTIALLY REFUTED** — 2 seams see raw text; a `refine` detector works; Zod 4's `.int()` now rejects too |
| C3 — custom adapter cost                | 84 lines; trace sinks survive (against prediction)                                                        |
| C4 — cache + BigInt                     | `memoryStore` survives; a JSON store throws **fatally**                                                   |
| C5 — request side                       | Four positions — the `params` bigint-vanish found here is **fixed (#661)**; a `number` still corrupts     |
| C6 — streams                            | Split by **decoder**, not surface: bytes/lines/download lossless; ndjson/json/sse corrupt                 |
| C7 — a loud detector                    | 15 lines, **0 false negatives** over 20,000 snowflakes, 0.535% FP                                         |
| C8 — assembled                          | Two setups: REPAIR 16 lines, DETECT 18 lines                                                              |

### Hypotheses that were wrong

**The big one, and it changes the answer.** I wrote _"that makes the `Adapter` the only candidate
seam."_ It is not. `wire: { response: 'text' }` is **published config** honoured at
`http-adapter.ts:123` — an `else if` that returns _before_ the JSON branch at `:135`. The repair
is 16 lines on the **stock transport**, not a custom adapter. I reasoned from
`AdapterResponse.body` being pre-parsed and never checked whether config could stop the parse
happening.

**"Validation cannot help."** `z.number().refine(Number.isSafeInteger)` separates corrupted from
intact, and the boundary walk shows `lossless=false` never co-occurs with `flagged=false` — false
negatives are **impossible**, not merely unobserved. Zod 4 later retired the capture's example
outright: `.int()` now enforces the safe-integer range, so `z.number().int()` rejects the
corrupted id (`Too big: expected int to be <=9007199254740991`) instead of passing it.

**"Trace sinks break under BigInt."** `trace.ts` ships a `bigintSafe` replacer deliberately, so a
`fileSink` is the one diagnostic surface that ends up holding the vendor's real digits.

**"Money has the same shape."** It does not, on the wire — `19.99` round-trips because the nearest
double's shortest form _is_ `"19.99"`. Decimals fail in **arithmetic**; integers above 2⁵³ fail in
**transport**. Two different bugs that I had merged into one.

### Outputs

- Page: [precision-loss.mdx](../../apps/docs/content/docs/scenarios/precision-loss.mdx)
- Draft: [bigint-in-params-vanishes](issue-drafts/bigint-in-params-vanishes.md) — superseded:
  fixed by #661 before the issue was filed
