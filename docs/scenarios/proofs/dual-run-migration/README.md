# Proofs — the migration you have to run twice

Runnable evidence for the claims in
[`../../dual-run-migration.md`](../../dual-run-migration.md).

**Both pre-registered predictions were tested. C2's is confirmed outright; C1's is confirmed only in
the two configurations a dual-run is most likely to land in, and refuted in three others — which
turns out to be the more dangerous shape.** Resilience state is not shared by default. It is shared
on a **key collision**, and the collision is invisible in the config: two stitches share a breaker
iff they land on the same store _and_ the same string out of
`circuit.key ?? name ?? path ?? 'stitch'`. Measured across five configurations, the primary was
fast-failed on the shadow's breaker in exactly two of them — a v2 that keeps the path and changes
the origin, and `throttle: { pool: 'host' }`, which is the setting a consumer reaches for
_precisely because_ the two versions share the vendor's meter.

The capture asks about four channels. There are **five**, and the one it does not list is the worst:
`all()` auto-cancels its members on the first failure (`pipe.ts:115`), so a shadow that fails fast
**kills the primary's in-flight request** — measured as `aborted: true` on the wire, not merely as an
error the caller sees.

Three more things the capture does not contain:

- **A bare `void v2(input)` sends zero requests.** `StitchResult` is a lazy `PromiseLike`
  (`types.ts:1905`), so the most natural fire-and-forget spelling in the language does not fail
  loudly — it does not run at all. No request, no rejection, no `unhandledRejection`. A dual-run
  written that way silently compares nothing, forever. The spelling that both fires and cannot
  reject is `void v2.safe(input)` (C1 b).
- **`.with()` partially rescues `all`, and that is a trap.** A bound partial _does_ survive
  `runMember`'s broadcast — but it binds a **constant**, so a group built once and called twice sent
  the shadow to the wrong customer while the primary followed the new input (C2).
- **A seam already accounts for the shadow's cost correctly.** `seamBucket` re-keys every acquire
  onto one seam id (`seam.ts:51-69`), so a seam-level `throttle` is one bucket across both versions.
  This is the one cost question in the scenario the library already answers (C7).

Every script is standalone and offline. The transport is a fake in-memory `Adapter`; nothing is
written to disk and nothing touches the network.

Each script prints one `PASS`/`FAIL` line and exits non-zero on failure.

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/dual-run-migration/c1-shadow-isolation.ts

# all of them
for f in docs/scenarios/proofs/dual-run-migration/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path, so
they test the working tree, not the published bundle.

They typecheck under `packages/core`'s full strict set:

```sh
cd packages/core && pnpm exec tsc --noEmit \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node ../../docs/scenarios/proofs/dual-run-migration/*.ts
```

## The method: counts on the wire, not intentions in the config

Every claim here reduces to one question — _how many requests did the vendor actually receive, and
what was in them?_ — so the primitive is a count and a literal URL string taken from the fake
transport in [`vendor.ts`](vendor.ts), which is the only thing in the process that can observe a
request. A row of any table in this directory is a measurement of the wire. Nothing is inferred from
what a config appears to promise.

The fake vendor puts **both versions on one host**, because that is the situation: `api.vendor.test`
is retiring `/v1`, and as the consumer you spend the same meter, hit the same breaker key material,
and share the same origin for both. A fake pointing v2 at a second host would have quietly dissolved
half the scenario.

The two versions disagree the way real versions do:

|        | v1                                                | v2                                                                                |
| ------ | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| input  | `GET /v1/customers/{id}` — id is a **path** param | `GET /v2/customers?customer_id=` — id moved to a **query** param, and was renamed |
| output | `created` (epoch int), `tags` in one order        | `created_at` (ISO string), `tags` reordered, `livemode` added                     |

…plus **one genuine regression**: `balance_cents` is `41250` in v1 and `41520` in v2. A wrong _value_
of the right type at the right path is the diff a schema cannot catch and the one a dual-run exists
to find. `CREATED_EPOCH` and `CREATED_ISO` denote the same instant, and C4 asserts the round-trip
rather than trusting the pair.

### Timing

Scenario 19 measured that `manualClock()` does **not** drive `timeout.total`, `cache.ttl`, event
`at` / `done.elapsed`, OAuth2 expiry, or SigV4. Two consequences, stated in
[`harness.ts`](harness.ts) and inherited by every script:

- **Caller-observed latency is wall-clock by definition**, so C1 (a), C7 and C8 use
  `performance.now()` and a real `setTimeout` in the fake adapter. Every latency number in this
  directory is **real time** and is asserted as a **band**, never an exact figure.
- **Circuit cooldown and retry backoff _are_ manual-clock driven** — which is why the retry channel
  (C1 c) deliberately uses a real clock with a 1 ms fixed backoff instead: nothing advances a
  `manualClock`, so the first backoff sleep never resolves and the script would hang. That channel
  measures counts, not timing, so a real clock costs nothing and is honest.

## What each script establishes

| script                                             | verdict                                       | the number that decides it                                               |
| -------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ |
| [`c1-shadow-isolation.ts`](c1-shadow-isolation.ts) | **PARTIAL** — 1 of 5 channels safe by default | 5 circuit configurations: primary got 1, 1, **0**, **0**, 1 requests     |
| [`c2-different-inputs.ts`](c2-different-inputs.ts) | **CONFIRMED**                                 | the shadow's literal URL: `/v2/customers` — no id at all                 |
| [`c3-comparison.ts`](c3-comparison.ts)             | **PARTIAL**                                   | 17 public subpaths, 0 of them export a value-vs-value comparator         |
| [`c4-relevancy.ts`](c4-relevancy.ts)               | **MEASURED**                                  | 7 raw diff ops per call on a _correct_ v2; 6 benign                      |
| [`c5-writes.ts`](c5-writes.ts)                     | **NO GUARD EXISTS**                           | 3 shadow write attempts, 0 reached the wire behind an 8-line adapter     |
| [`c6-cutover.ts`](c6-cutover.ts)                   | **PARTIAL**                                   | a thunk moves origin _and_ path; input shape and `output` it cannot move |
| [`c7-cost.ts`](c7-cost.ts)                         | **MEASURED**                                  | exactly **2.000x**; 5 lines of sampling take it to 1.045x                |
| [`c8-assembled.ts`](c8-assembled.ts)               | **ASSEMBLED**                                 | naive 0-of-4 vs safe 4-of-4 user-facing calls, same flaky v2             |

## The C1 table — four channels, and the fifth

| channel          | safe by default? | measured                                                | what it takes                                                          |
| ---------------- | ---------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| **(a) latency**  | **NO**           | `all()` 122 ms vs floated 12 ms, primary alone 13 ms    | do not await the shadow. No combinator does this — user code           |
| **(b) thrown**   | **NO**           | `all()` threw `StitchError`; `.safe()` gave `ok: false` | `void v2.safe(input)` — fires **and** cannot reject                    |
| **(c) retry**    | **YES**          | primary got 1 request of 1 while the shadow burned 3    | — (the budget is a per-call loop counter, `engine.ts:610,624`)         |
| **(c\*) cancel** | **NO**           | primary request `aborted: true`, `completed: false`     | never put the shadow in `all()`                                        |
| **(d) circuit**  | **NO**           | 1 · 1 · **0** · **0** · 1 primary requests across d1–d5 | a distinct `circuit.key` per version, and never unkeyed `pool: 'host'` |

Only **one** channel is safe by default, and it is the one the capture was least worried about.

### The five circuit configurations (C1 d)

The breaker's identity is `(store instance) × ('circuit:' + (circuit.key ?? name ?? path ?? 'stitch'))`
— `resilience.ts:353` over `engine.ts:857-862`, `engine.ts:265-274`, `engine.ts:140`.

|     | configuration                             | result     | why                                                     |
| --- | ----------------------------------------- | ---------- | ------------------------------------------------------- |
| d1  | standalone stitches, distinct paths       | isolated   | each builds its own `memoryStore()`                     |
| d2  | one seam, distinct paths                  | isolated   | shared store, but the key is the path                   |
| d3  | one seam, **same path**, different origin | **SHARED** | `nameOf` reads `path`; both key on `circuit:/customers` |
| d4  | one seam + `throttle: { pool: 'host' }`   | **SHARED** | `hostKey` returns the URL host instead of the name      |
| d5  | explicit distinct `circuit.key`           | isolated   | the only lever; a static string, no `keyOf`             |

d3 and d4 are both ordinary ways to ship a dual-run. In each, the caller received `circuit open` on a
breaker only the shadow ever opened.

## The relevancy ledger (C4)

| v1 → v2 change           | declarative?                   | user code needed?                                           |
| ------------------------ | ------------------------------ | ----------------------------------------------------------- |
| `livemode` added         | **yes** — `ignore: 'livemode'` | —                                                           |
| `tags[]` reordered       | partly — `ignore: 'tags[]'`    | **yes**: `ignore` _suppresses_, it cannot compare unordered |
| `created` → `created_at` | partly — ignore both paths     | **yes**: no aliasing option exists                          |
| epoch → ISO              | **no**                         | **yes**: no coercion hook                                   |
| `balance_cents`          | (must survive every filter)    | —                                                           |

`DriftOptions.ignore` is the only declarative filter in the tree, and it reaches 7 → 1 with four
clauses. But it does so by refusing to look: the clause that silences the benign tag reorder also
silences a **real** tag change, and the clause that silences the rename also silences a v2 reporting
the **wrong instant** — both measured. A 24-line normalizer reaches the same count and still catches
what `ignore` hid.

## What is not reachable (C3)

| symbol                     | compares                          | reachable from                             |
| -------------------------- | --------------------------------- | ------------------------------------------ |
| `drift(schema, opts)`      | nothing — it tags a schema        | `stitchapi` — **public**                   |
| `classifyDiff(a, b, opts)` | value vs value, **with** `ignore` | `packages/core/src/drift.ts` — source only |
| `diff(before, after)`      | value vs value                    | `packages/core/src/diff.ts` — source only  |

The comparison primitive is not missing. It exists **twice**, in exactly the right shape, and neither
copy is exported from any of the 17 subpaths in the package `exports` map. `classifyDiff` is also the
wrong tool for a regression report even when reached: it renders the planted `balance_cents`
regression as the detail `"number -> number"`, a type delta with no numbers in it.

## The tension C8 exists to name

The two ways to make the **meter** accounting correct are not equivalent, and the scenario walks
straight into the bad one. A seam-level `throttle` pools both versions and leaves the breaker keyed
per path. `throttle: { pool: 'host' }` also pools correctly — and silently re-keys the **circuit**
onto the host, which is the exact configuration measured fast-failing the primary. A consumer
reaching for `pool: 'host'` is reaching for it for a good reason, and gets an unasked-for shared
breaker.

C8's safe construction is **55 executable lines across 5 seams**: `readsOnly` on the shadow's adapter
only, one seam for the throttle, distinct `circuit.key` strings, a hand-written normalizer, and a
floated `.safe()` at the call site. Four of the five are ordinary config. The fifth is not config at
all — there is no declarative surface anywhere in the library for _"these two field names mean the
same thing"_ or _"compare this array unordered"_ — so the relevancy model is code you write and
maintain, which is exactly the part the field guidance says the effort goes into.

Three things no amount of user code fixes, and they bound the technique rather than the library:

- a write can only be **refused**, never shadowed;
- the shadow's correctness depends on the caller mapping the input twice, and getting it wrong is
  **silent** — C2 measured a bound shadow querying the wrong customer forever;
- the comparator is vendored, so a library-side improvement to `diff` never reaches it.
