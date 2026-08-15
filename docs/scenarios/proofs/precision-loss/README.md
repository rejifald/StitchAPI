# Proofs — the ID that changed on the way in

Runnable evidence for the claims in [`../../precision-loss.md`](../../precision-loss.md).

**C1 is confirmed. C2 — the claim the scenario turns on — is half refuted, and the half that fell
is the capture's conclusion.** The corruption is real and completely silent: `1234567890123456789`
arrives as `1234567890123456768`, on a four-event spine with zero findings, and the sent digits
appear nowhere in it. But the capture's two structural conclusions do not survive measurement.
Validation _can_ separate a corrupted id from an intact one, and the `Adapter` is _not_ the only
seam that can see the raw bytes — `wire: { response: 'text' }` is published config that hands the
verbatim string to `transform`, on the stock `fetchAdapter`.

Along the way the survey found a library bug that is not in the claims list at all: **a `bigint` in
`params` silently vanished**, producing a request to the wrong URL with no error and no event
(C5(a)). That finding was drafted
([issue draft](../../issue-drafts/bigint-in-params-vanishes.md)) and #661 fixed it before the
issue was filed; C5(a) now pins the repaired behaviour — the exact digits in the URL.

Every script is standalone and offline. The transport under test is the library's **real**
`fetchAdapter`, fed a fake `fetch` that returns a real `Response` — so `http-adapter.ts:135`
(`parsed = text === '' ? undefined : JSON.parse(text)`) runs verbatim rather than being imitated.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/precision-loss/c2-detection.ts

# all of them
for f in docs/scenarios/proofs/precision-loss/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path, so
they test the working tree, not the published bundle.

They typecheck under `packages/core`'s full strict set:

```sh
cd packages/core && pnpm exec tsc --noEmit --ignoreConfig \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/precision-loss/*.ts
```

### Why the fixtures are strings

Every other proof directory in this repo starts from a fixture **object**. This one cannot. The
whole scenario is the gap between the bytes a vendor sent and the value JavaScript ended up holding,
and an object literal has already closed that gap the wrong way: `1234567890123456789` typed into a
`.ts` file **is** `1234567890123456768`, because the TypeScript source is parsed by the same lexer.
So the fixtures in [`wire.ts`](wire.ts) are string constants, and digits are only ever asserted
against strings.

The same trap bit this directory twice while it was being written, and both are recorded in the
source rather than quietly fixed:

- C7(e)'s first sampler built random ids with `Math.floor(rand() * 3e17)`. That product is itself a
  double above 2^53, so every id it could produce was already exactly representable — the measured
  false-positive rate came out **17× too high** (9.15% instead of 0.535%). The generator now
  assembles ids entirely in `BigInt`.
- C3's first sentinel was a control character (`\u0000`), the collision-free choice — and
  `JSON.parse` rejects a raw control character inside a string literal. The printable sentinel that
  replaced it has one residual false positive, and C3(a2) measures it instead of hiding it.

### Why this directory imports Zod by path

Same reason as [`../stale-fixture/zod.ts`](../stale-fixture/zod.ts): C2 asks what `z.number().int()`,
`z.bigint()` and `z.string()` actually do when handed a corrupted double, and a hand-rolled
`{ validate }` stub would let this directory invent the answer. In application code the spelling is
`import { z } from 'zod'`.

## What each script establishes

| Script                 | Question                                 | Measured                                                                                                                |
| ---------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `c1-corruption.ts`     | does the default path corrupt, silently? | **Yes, and totally silent.** 3 of 8 values corrupted, 4-event spine, 0 findings. Money does **not** corrupt on the wire |
| `c2-detection.ts`      | can anything downstream detect it?       | **9 seams parsed-only, 2 see raw text.** `isSafeInteger` works — and Zod 4's `.int()` now rejects a corrupted id too    |
| `c3-custom-adapter.ts` | can a custom adapter fix it, and cost?   | **Yes, 84 lines.** `JSON.stringify` throws; trace sinks **survive** — `trace.ts` already ships `bigintSafe`             |
| `c4-cache.ts`          | does `cache` survive a BigInt body?      | **`memoryStore` yes, JSON store throws.** With a replacer, `typeof` differs between a cache hit and a miss              |
| `c5-request-side.ts`   | does a large ID survive going out?       | **bigint: 3 work, 1 throws.** The `params` vanish this survey found is fixed (#661); a `number` still corrupts          |
| `c6-streams.ts`        | are the streaming surfaces safer?        | **Split by decoder, not surface.** bytes/lines/download lossless; ndjson/json/sse corrupt                               |
| `c7-detector.ts`       | is there a spelling that is loud?        | **Yes — a `warn` drift finding, non-fatal.** 15 lines. 0 false negatives; 0.535% false positives on real snowflakes     |
| `c8-assembled.ts`      | the safest setup, and what it costs?     | **Two setups: 16 lines to repair, 18 to detect.** 5 seams prevent, 1 reports, 6 cannot see it at all                    |

## Files

- `wire.ts` — the digits, as string constants (`SNOWFLAKE`, `TWO53_PLUS_1`, `BIGINT_PK`, `MAX_SAFE`,
  `SMALL_ID`, `MONEY`), the wire payloads assembled from them by concatenation, and the transports.
  `wireAdapter` is the library's **real** `fetchAdapter` with a fake `fetch` underneath, so the parse
  under test is `http-adapter.ts:135` itself. Also `quoteBigInts` — the single-pass, string-aware
  scanner C3 puts under test — and the two revivers built on it.
- `harness.ts` — `check` / `checkDigits` / `checkStr` / `checkSeq` / `note` / `heading` / `finish`,
  plus the one thing this scenario needed that the others did not: `digits()`, which routes an
  integral double through `BigInt` so the printed value is the exact integer the double **is**,
  never the shortest round-tripping form. Three digit strings exist for one id and the harness has
  to be able to tell them apart. Also the two table printers (`printWireTable`, `printSeamTable`).
- `zod.ts` — real Zod, imported by relative path.

## The three digit strings

Worth stating once, because several rows below only make sense with it. For the id
`1234567890123456789`:

| What                                              | Digits                |
| ------------------------------------------------- | --------------------- |
| the vendor sent                                   | `1234567890123456789` |
| the double actually holds (`BigInt(n)`)           | `1234567890123456768` |
| `JSON.stringify(n)` / `String(n)` — shortest form | `1234567890123456800` |

The third is what appears in a log, in a `TraceSink` record, and in the URL when you hand the id
back (C5). So an id read and re-sent goes out as the **third** of these — not the second, which is what you
would see if you inspected the value in a debugger.

## What each downstream seam sees, for one corrupted ID

Sent on the wire: `{"id":1234567890123456789}`. Measured in C2.

| Seam                             | Holds        | Observed                                                             |
| -------------------------------- | ------------ | -------------------------------------------------------------------- |
| `output: z.number().int()`       | parsed body  | rejects it — Zod 4 caps `.int()` at 2⁵³−1 (`Too big`)                |
| `output: z.bigint()`             | parsed body  | rejects — and rejects the intact id too (100% false positive)        |
| `output: z.string()`             | parsed body  | same                                                                 |
| `output: .refine(isSafeInteger)` | parsed body  | **rejects corrupted, accepts intact** — a working detector           |
| `drift()`                        | parsed body  | `warn\|coerced\|id\|number -> string`, value `"1234567890123456800"` |
| `.inspect().raw`                 | parsed body  | an object; `.id` is the **number** `1234567890123456768`             |
| `.report()`                      | parsed body  | 9 enumerable keys, `findings: []`, `source: 'live'`                  |
| `hooks.onResponse`               | parsed body  | `ctx = {attempt,name,res}`; `ctx.res = {body,headers,status,url}`    |
| `Surface.interpret`              | parsed body  | `res.body.id = 1234567890123456768`                                  |
| `TraceSink`                      | parsed body  | 4 events, no wire text, no symbol channels                           |
| **`wire:{response:'text'}`**     | **raw text** | `ctx.res.body === '{"id":1234567890123456789}'`                      |
| **`transform` (under text)**     | **raw text** | repaired to `"1234567890123456789"`, no custom adapter               |

`raw` means _pre-validation_, not _pre-parse_. That one word is the whole of C2.

## What was refuted

The capture made four structural predictions that measurement contradicted.

1. **"Validation cannot help."** `z.number().refine(Number.isSafeInteger)` rejects the corrupted id
   and accepts the intact one. Walking the boundary (2^53−1 / 2^53 / 2^53+1 / 2^53+2) shows
   `lossless=false` never co-occurs with `flagged=false`: **false negatives are impossible**, because
   any integer a double cannot represent is above 2^53 and so is its parse. The cost is false
   positives on large-but-representable integers — 0.535% over 20 000 real-shaped snowflakes.
   (Since the workspace moved to Zod 4, the capture's own example fell too: `.int()` now enforces
   the safe-integer range, so `z.number().int()` rejects the corrupted id with
   `Too big: expected int to be <=9007199254740991` instead of accepting it silently.)
2. **"That makes the `Adapter` the only candidate seam."** `wire: { response: 'text' }` is published
   `StitchConfig`, honoured by the stock `fetchAdapter` at line 123 — _before_ the JSON branch at
   133–135. The body handed to the engine is the unparsed string, and `transform` then runs on it.
   C2(j) recovers the exact sent digits with no custom adapter.
3. **"Trace sinks break on a BigInt body."** They do not. `trace.ts` ships a `bigintSafe` replacer,
   commented "Tracing must never break the call it observes". `fileSink` wrote
   `{"id":"1234567890123456789n"}` — the one diagnostic surface in this whole scenario that ends up
   holding the vendor's actual digits. The cache **key** encoder handles bigint deliberately too
   (`cache.ts:43`).
4. **"Money has the same shape."** It does not, on the wire. `19.99` round-trips to the token
   `"19.99"`, because the nearest double's shortest form _is_ `"19.99"`. The value is still inexact
   (`19.98999999999999843681`, and `19.99 * 100 === 1998.9999999999998`) — so decimals fail in
   **arithmetic**, integers above 2^53 fail in **transport**. Only the second is a wire-fidelity bug,
   and only the second is detectable by comparing digits.

## Found outside the claims list

- **`bigint` in `params` silently vanished — found here, drafted, fixed by #661** (C5(a)).
  `expandTemplateVar` branched on `string | number | boolean`; a bigint matched none, fell to the
  object arm, and `Object.entries(<bigint>)` is `[]` — so nothing was emitted. The measured URL was
  `https://api.snowflake.test/v1/things/`, with **no error and no event**: a pipeline repaired per
  C3 that handed its BigInt id back to a path parameter requested the collection instead of the
  item, while the sibling position, `query`, handled bigint correctly (`stringifyLeaf`,
  `util.ts:371`) — the two URL positions disagreed with each other. Drafted as
  [bigint-in-params-vanishes](../../issue-drafts/bigint-in-params-vanishes.md); #661 fixed it
  before the issue was filed: the scalar arm (`util.ts:421`) now lists `bigint`, and C5(a)
  measures the exact digits in the URL — the two URL positions agree again.
- **`z.coerce.number()` silently undoes the C3 repair**, back to `1234567890123456768` (C3(c)).
- **A cache hit and a cache miss can return different TYPES** (C4(d)): with a bigint-aware store
  replacer, `typeof data.id` is `bigint` on a miss and `string` on a hit — invisible to any test
  suite that starts cold.
- **`JSON.stringify(report)` throws** on a BigInt body (C3(f)), and `.report()` is documented as safe
  to log. It is safe to _read_ and throws when logged.
- **`transform` and `wire.response` are independent at the type level** (C8(c)): `transform` is
  `(body: unknown) => unknown`, so a parser written `(text: string)` does not typecheck in the slot
  even though `wire.response: 'text'` guarantees a string at runtime.
- **`transform` is redacted out of `__config`** (it is a function), so "is this stitch repaired?" is
  only half auditable — `wire` shows, `transform` does not.
