# Proposal — a generated schema for `StitchConfig`

**Status:** proposed · **Scope:** build-time generation + one cold subpath; no runtime change to `packages/core`'s hot path · **Target branch:** `main`
**Builds on:** [`packages/core/src/config-anatomy.ts`](../../packages/core/src/config-anatomy.ts) (landed in [#477](https://github.com/rejifald/StitchAPI/pull/477)) · [`packages/completions-plugin`](../../packages/completions-plugin)

> [!NOTE]
>
> This is a design record, not yet implemented. It came out of the #477 review,
> which found the same set of config-slot names hand-written in eight places.
> Seven of those are now derived from a type-level anatomy. This proposal asks
> whether the anatomy should also carry the config's **structure**, and what
> that would buy.

---

## TL;DR

`StitchConfig` is described three separate times in this repository:

1. **`packages/core/src/types.ts`** — the authored TypeScript interface. The source of truth for shape.
2. **`packages/core/src/config-anatomy.ts`** — the behavioral facts TypeScript cannot express: which slots have a scalar shorthand and what field it folds into, which carry author closures, which never reach the public `__config`, where each sits in the pipeline read-out.
3. **`packages/completions-plugin`** — which reconstructs (1) by parsing `packages/core`'s `*Config` interfaces at build time, to feed the playground's editor completions.

(3) is a full second derivation of (1). Nothing checks it against (2) at all.

The proposal: emit **one artifact** at build time that carries both halves — structure generated from the TypeScript types, behavior generated from the anatomy and attached as annotations — and make the completions plugin its first consumer rather than a parallel derivation. Runtime config validation becomes possible on top of it, opt-in and behind a subpath, but is explicitly **not** the first deliverable.

The load-bearing constraint: **the type facts must be generated, never hand-written.** Hand-writing them into the anatomy would recreate, at 35 slots × their nested option interfaces, exactly the drift class #477 spent four commits closing.

---

## 1. What the anatomy holds today, and what it deliberately does not

After #477, `StitchConfigAnatomy` describes every slot of `StitchConfig` once:

| fact            | meaning                                                             |
| --------------- | ------------------------------------------------------------------- |
| `shorthand`     | dominant field a scalar folds into (`retry: 3` → `{ attempts: 3 }`) |
| `toggle`        | `true`/`false` normalises to the object form, or removal            |
| `fns`           | carries author closures at depth 1; fn-stripped for `__config`      |
| `dropped`       | `'redact'` / `'redact-if-fn'` / `'compose'`                         |
| `project`       | replaced on `__config` by a non-secret projection                   |
| `stage`         | position in the pipeline read-out                                   |
| `policy`        | reported in the `mcp` `policies` summary                            |
| `normalized`    | `compose` rewrites it, so the resolved type re-declares it          |
| `carriesSchema` | holds a Standard Schema validator — P0's one exemption              |

Every one of those is a fact **about behavior**, not about shape. There is deliberately nothing saying `retry.attempts` is a number or `method` is a string, because the interface in `types.ts` already says that and a second copy would drift.

That division is what this proposal preserves.

---

## 2. Who would consume a config schema

Four consumers, in descending order of how well-established the need is.

### 2.1 The completions plugin (established — it already does this)

`@stitchapi/completions-plugin` parses `packages/core` for `*Config` interfaces and emits `playground-completions.generated.ts`. A yakir tether (`playground-completions`) drift-checks it by re-running the generator with `--emit` and diffing.

It reconstructs structure and knows nothing about behavior — so the playground can complete `retry:` but cannot tell you that `retry: 3` is legal shorthand, or that `retry.on` never survives onto `__config`. A combined artifact would make it strictly better **and** remove a whole derivation.

### 2.2 Editor support for config-as-data

There is no JSON Schema for a stitch config today. Emitting one gives `$schema`-driven completion and validation in any JSON/YAML config a user writes, in any editor, with no StitchAPI-specific tooling.

### 2.3 Runtime validation where a config arrives as data

This is the consumer to be honest about: **TypeScript already covers the common case.** A config authored as a typed literal in a `.ts` file needs no runtime check. The genuine gaps are narrower:

-   JavaScript consumers with no typechecking at all.
-   A config read from JSON/YAML and passed through — the shape is asserted by a cast, not checked.
-   `forRootAsync`'s `useFactory` in [`packages/nest`](../../packages/nest/src/module.ts), where values arrive from `ConfigService` (env, JSON) even though the factory's return type is checked.
-   A `__config` round-tripped through JSON and re-fed as an `extends` fragment.
-   The playground, where the config is typed into a browser editor.

Real, but not universal. Which is why validation is phase 3, opt-in, and behind a subpath.

### 2.4 The anatomy's own consumers (speculative)

If the schema were a runtime value, `redactConfig` could walk it directly instead of walking three `as const` arrays. **This proposal recommends against that** — see §3.1.

---

## 3. The two constraints that decide the shape

### 3.1 Bundle

`packages/core` measures **24.81 / 20.01 KB gzip** against a **24.90 / 20.10** budget — 0.09 KB of headroom, after a deliberate bump in #477. `redactConfig` runs in every `makeStitch`, so it sits in the lean `import { stitch }` entry.

The anatomy is type-only by construction and emits no runtime value. That is why the #477 refactor came in at **−0.18 KB minified** rather than positive: it replaced repeated key lists with walks over small arrays and added no table.

A 35-slot runtime schema in the lean entry would reverse that. Therefore:

-   the generated artifact **must not** be imported by anything reachable from `index.ts`'s hot path;
-   it ships in its own module, consumed by build tooling and by an opt-in subpath;
-   `redactConfig` keeps its `as const` arrays and its type-level coverage asserts.

Any prototype must report the delta against these two numbers, measured the same way (`node packages/core/scripts/bundle-size.mjs` after a build). Local measurements on macOS have matched CI exactly when the source matches; the one divergence in this session came from comparing against a stale merge base.

### 3.2 "Bring your own validator"

Core has **zero runtime dependencies and no built-in validator**, on principle — it is validator-agnostic and takes Standard Schema from the user. ADR 0011 rejected a `pattern` primitive on the grounds that Standard Schema exposes only `validate()`, making generic composition impossible.

Validating its _own_ config is not the same as prescribing a validator for user data, but it is close enough to the line to need a deliberate answer. Two ways out, both viable:

-   **emit JSON Schema and stop** — the user validates with whatever they already have (ajv, a CI step, their editor). Zero new machinery, consistent with BYO.
-   **ship a tiny purpose-built checker** in a cold subpath, scoped strictly to `StitchConfig` and never exposed as a general validator.

The proposal defaults to the first and treats the second as a follow-up requiring its own justification.

---

## 4. The design

One generated artifact, two halves:

**Structure**, generated from `types.ts` via the machinery `@stitchapi/completions-plugin` already has — the slot's type, whether it is optional, its enum members where the type is a union of literals, and its nested option interface where it has one.

**Behavior**, generated from `StitchConfigAnatomy`, attached as annotations:

```jsonc
{
    "properties": {
        "retry": {
            "anyOf": [{ "type": "number" }, { "$ref": "#/$defs/RetryOptions" }],
            "x-stitch-shorthand": "attempts", // retry: 3 folds to { attempts: 3 }
            "x-stitch-fns": true, // retry.on never reaches __config
            "x-stitch-policy": true, // reported in the mcp policies summary
            "x-stitch-stage": 3, // position in the pipeline read-out
        },
        "trace": {
            "x-stitch-dropped": "redact", // never on __config at all
        },
    },
}
```

The result says both _"`retry.attempts` is a number"_ and _"`retry: 3` folds to it, and `retry.on` is stripped"_ — which no consumer can currently learn from one place.

Generation must be **drift-gated the way the completions output already is**: a `--emit` mode plus a yakir tether that re-runs it and diffs against the committed artifact, so a stale schema fails CI rather than rotting.

---

## 5. Phases

Each phase is independently landable and independently useful.

| #   | Deliverable                                                            | Runtime cost | Proves                                                              |
| --- | ---------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------- |
| 1   | Emit the artifact (structure + annotations) with a `--emit` drift gate | none         | that both halves can be generated and stay honest                   |
| 2   | Rewire `@stitchapi/completions-plugin` to consume it                   | none         | that it is strictly better than the parallel derivation it replaces |
| 3   | Publish it as JSON Schema for `$schema`-driven editor support          | none         | the config-as-data story, with no StitchAPI-specific tooling        |
| 4   | Opt-in `assertConfig()` in a cold subpath                              | subpath only | runtime checking for the data paths in §2.3                         |

Phase 1 is the one worth doing first regardless of whether 3 and 4 ever ship: it proves the generation before anything depends on it.

---

## 6. Open questions

1. **Where does the generator live?** Extending `@stitchapi/completions-plugin` reuses its TypeScript-parsing machinery but makes a docs-adjacent package the owner of a core artifact. A new `packages/config-schema` is cleaner ownership and more moving parts.
2. **Is the emitted artifact committed or built?** Committed matches `playground-completions.generated.ts` and gets drift-gated for free. Built keeps the tree clean but needs the schema available wherever it is consumed.
3. **Does the JSON Schema ship in the npm package?** It is the thing that makes `$schema` work for users, which argues yes — but it is also bytes in the tarball and a public artifact to keep stable.
4. **How much of the nested option interfaces does phase 1 cover?** Depth 1 (top-level slots) is what the completions plugin does today. Full depth is more useful and much more generation surface.
5. **Does `carriesSchema` need a schema-of-a-schema?** `input`/`output` hold Standard Schema validators. The annotation can say "this is a validator" without describing its interior; that is probably the right stopping point.
6. **Does this subsume anything?** `stitch export --openapi` already emits schemas for _endpoints_ via a BYO `toJsonSchema` (`--schema-module`). This is schemas for _configs_ — adjacent, not the same, but worth checking for shared machinery before building.

---

## 7. Alternatives considered

**Hand-write the type facts into the anatomy.** Rejected. It would mirror `types.ts` across 35 slots plus their nested interfaces — the exact hand-mirror drift class #477 closed, reintroduced at larger scale and with nothing cross-checking it.

**Make the anatomy a runtime value core walks.** Rejected for now. It would put a 35-slot table in the lean entry against 0.09 KB of headroom, and give back the −0.18 KB the type-only design won. Revisit only if the budget is deliberately raised for another reason.

**Validate at `stitch()` unconditionally.** Rejected. It taxes every construction on the hot path to serve the minority of call sites where the config is untyped data, and it makes core opinionated about validation in a way the BYO principle rejects.

**Do nothing.** Defensible. The completions plugin works, TypeScript covers authored configs, and the anatomy already closed the drift that actually caused a bug. The honest case for acting is (2.1) — one derivation deleted — more than (2.3).
