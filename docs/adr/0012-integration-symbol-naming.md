# ADR 0012 — Integration symbol naming (ecosystem-qualified adapters)

- **Status:** Accepted (2026-06-20). Applies to every published `@stitchapi/*` package. The enforcement sweep qualifies the bare adapter exports in `@stitchapi/nest` (5), `@stitchapi/hono` (1), and `@stitchapi/react` (1); the rest were already on-pattern.
- **Date:** 2026-06-20
- **Tags:** naming, conventions, public-api, packaging, adapters, integrations, dx

> [!NOTE]
>
> This ADR is a **naming rule**, not a feature. It standardizes how the exported
> symbols of the integration packages are named so the same concept reads the same
> way across `core`, `@stitchapi/fastify`, `@stitchapi/nest`, `@stitchapi/pino`,
> `@stitchapi/redis`, and friends. It changes no runtime behavior.

## Context

The `@stitchapi/*` integration packages were written at different times and their
public symbols drifted into three competing conventions. The sharpest example is the
helper that bridges a host's logger into a Stitch `TraceSink` — **one concept with
four spellings**:

| Concept   | `core` (generic)    | `@stitchapi/fastify`       | `@stitchapi/nest`       | `@stitchapi/pino` |
| --------- | ------------------- | -------------------------- | ----------------------- | ----------------- |
| sink fn   | `loggerSink`        | `fastifyLoggerSink`        | `loggerSink` ⚠️         | `pinoSink`        |
| options   | `LoggerSinkOptions` | `FastifyLoggerSinkOptions` | `NestLoggerSinkOptions` | `PinoSinkOptions` |
| duck-type | `LoggerLike`        | `FastifyLoggerLike`        | `LoggerLike` ⚠️         | `PinoLoggerLike`  |

⚠️ `@stitchapi/nest` exported a function literally named `loggerSink` and an
interface literally named `LoggerLike` — **the same identifiers core already
exports** for its generic versions. The collision was real enough that
[`bridges.ts`](../../packages/nest/src/bridges.ts) had to import core's as
`coreLoggerSink` / `CoreLoggerLike` just to compile. Anyone assembling observability
from `core` + `@stitchapi/nest` hit the same alias tax.

### Why "the package path already says it" does not settle the question

The instinct to drop the prefix (`fastifyLoggerSink` → `loggerSink`, because the
import path is already `@stitchapi/fastify`) is the **Go "avoid stutter" rule** —
`http.Server`, not `http.HTTPServer`. That rule is load-bearing _only because Go
forces qualified access_: the package name is structurally present at every call
site, so repeating it is pure noise.

**JavaScript/TypeScript named imports do the opposite — they strip the qualifier.**

```ts
import { loggerSink } from '@stitchapi/nest';

// 400 lines later, far from the import:
trace: loggerSink(app.get(Logger)); // which loggerSink? core's? nest's? a local?
```

After a named import the package scope is gone; the **symbol is the only surviving
carrier of meaning**. So the premise the stutter rule depends on does not hold here.
Collision with core is just the most visible symptom of a deeper set of costs:

1.  **Call-site clarity** once the package scope is flattened away (the primary one).
2.  **Re-export barrels / user observability modules** — bare `Sink` / `LoggerLike`
    names clash and lose meaning the moment two packages are re-exported together.
3.  **Grep / discoverability** — `fastifyLoggerSink` is uniquely findable; `loggerSink`
    returns core, nest, and every local variable.
4.  **Family regularity** — seeing `fastifyLoggerSink` lets a reader _guess_ that
    `nestLoggerSink` exists.

The lone cost on the other side — stutter (`fastify.fastifyLoggerSink`) — only
appears under _namespace_ imports (`import * as fastify`), which nobody uses with
these packages.

### What comparable projects do

The JS projects shaped most like StitchAPI — a vendor-neutral runtime with one
adapter package per host/library — **qualify the symbol with the ecosystem**, despite
the package path already naming it:

- **OpenTelemetry** — `@opentelemetry/instrumentation-pino` exports
  `PinoInstrumentation`; `@opentelemetry/instrumentation-fastify` exports
  `FastifyInstrumentation`. It also drops _redundant_ tokens: it is
  `PinoInstrumentation`, not `PinoLoggerInstrumentation`.
- **Auth.js** — `@auth/prisma-adapter` exports `PrismaAdapter`,
  `@auth/drizzle-adapter` exports `DrizzleAdapter`.
- The bare-export camp (Vite/Rollup plugins → default `react()`, `vue()`) still
  names the export after the **target ecosystem**, never the host runtime — the same
  principle by a different mechanism.

## Decision

**1. Two package archetypes, two rules for the _primary_ surface.**

- **Host adapters** — you plug Stitch _into_ a framework (`fastify`, `hono`, `nest`,
  `react`). The primary surface is **`Stitch`-branded**, because the thing you
  register/use _is_ Stitch: `stitchPlugin`, `stitch` (middleware), `StitchModule`,
  `useStitch`.
- **Capability providers** — an external library _backs_ a Stitch capability
  (`pino`, `redis`). The primary surface is **`{provider}`-branded**, because the
  name's job is to say _which_ backing it is: `pinoSink`, `redisStore`.

**2. Cross-cutting bridge/adapter helpers are ecosystem-qualified.** A helper that
adapts one of a host's subsystems (its logger, its config) into a Stitch seam is named
`{ecosystem}{Subsystem}` — `fastifyLoggerSink`, `nestLoggerSink` — with the matching
`{Ecosystem}{Subsystem}Options` and `{Ecosystem}{Subsystem}Like` duck-type.

**3. Use the _minimal_ subsystem token (the OTel refinement).** Qualify with the
ecosystem plus only the token needed to answer _"which subsystem of that ecosystem?"_

- A logger library already _is_ a logger, so the token is redundant: `pinoSink`
  (not `pinoLoggerSink`).
- A web framework is not a logger, so name the subsystem you are bridging:
  `fastifyLoggerSink`, `nestLoggerSink` (you are bridging its `.log`, not its router).

**4. Constructors that adapt a foreign instance use `from{Source}` — and the source
token must be specific enough not to collide.** A concrete library name is its own
qualifier: `fromIoredis`, `fromNodeRedis` (nobody else ships an `ioredis` adapter). A
_generic_ source word is not, so it carries the ecosystem: **`fromNestConfig`**, not a
bare `fromConfig` (every framework has a "config"). The test is the flattened import:
would two packages plausibly export this exact identifier? If yes, qualify it.

**5. The generic base packages (`core`, `query-core`) stay bare.** `core`'s
`loggerSink` / `LoggerSinkOptions` / `LoggerLike` / `consoleSink` / `fileSink` /
`memoryStore`, and `query-core`'s `StitchQuery*` / `QueryInput` / `QueryOutput` /
`StreamableResult`, are the _unqualified_ primitives. Bare is correct there precisely
because they are the generic base every adapter specializes or re-exports — and it
keeps the qualified names meaningful as "the {ecosystem} flavor of the core thing."

**6. Qualify proactively, not only on a live collision.** A bare, non-branded export in
an adapter/provider package is a latent collision — the cost lands later, on whoever
first imports two packages together, as a silent shadow or a forced alias. So an
adapter export that is neither `Stitch`-branded (rule 1) nor `{provider}`-branded
(rule 1) nor a specific `from{Lib}` (rule 4) gets its ecosystem qualifier _now_, even
if nothing collides today. This is why `@stitchapi/nest`'s `fromConfig` / `borrowStore`
/ `ConfigServiceLike`, `@stitchapi/hono`'s `RequestSeam`, and `@stitchapi/react`'s
`queryOptions` are all qualified, not just the names that already clashed. (Private,
unpublished packages — `eval-harness`, `sandbox-sim`, `completions-plugin` — are not
public surface and are out of scope.)

## Conformance at adoption (2026-06-20)

A sweep of every **published** package's public surface:

| Package                    | Verdict                                                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stitchapi` (core)         | ✅ generic base — bare names are correct                                                                                                                                                  |
| `@stitchapi/query-core`    | ✅ generic base (the framework-agnostic query engine) — bare names are correct                                                                                                            |
| `@stitchapi/fastify`       | ✅ already canonical (`fastifyLoggerSink`, `FastifyLoggerLike`, `FastifyLoggerSinkOptions`)                                                                                               |
| `@stitchapi/pino`          | ✅ `pinoSink` (the `Logger` token is rightly elided for a logger library)                                                                                                                 |
| `@stitchapi/redis`         | ✅ `redisStore`, `fromIoredis`, `fromNodeRedis` (specific-lib `from{Lib}` constructors)                                                                                                   |
| `@stitchapi/fingerprint-*` | ✅ five packages, each `{lib}Fingerprinter` (`zodFingerprinter`, `valibotFingerprinter`, …) — the exemplar of the rule                                                                    |
| `@stitchapi/shell`         | ✅ surface package — `shell` / `ShellOptions` named for the surface                                                                                                                       |
| **`@stitchapi/nest`**      | **⚠️ → fixed:** `loggerSink`→`nestLoggerSink`, `LoggerLike`→`NestLoggerLike`, `fromConfig`→`fromNestConfig`, `borrowStore`→`nestBorrowStore`, `ConfigServiceLike`→`NestConfigServiceLike` |
| **`@stitchapi/hono`**      | **⚠️ → fixed:** `RequestSeam` → `HonoRequestSeam` (the rest of the surface is `Stitch`-branded)                                                                                           |
| **`@stitchapi/react`**     | **⚠️ → fixed:** `queryOptions` → `stitchQueryOptions` (it clashed with TanStack Query's own `queryOptions`; the rest is `Stitch`-branded)                                                 |

Three packages carried bare, non-branded adapter exports; all are renamed here, with
`@deprecated` aliases. `@stitchapi/nest`'s `NestLoggerSinkOptions` was already
on-pattern. Private packages (`eval-harness`, `sandbox-sim`, `completions-plugin`) are
not public surface and are out of scope.

## Migration & deprecation

Every package is pre-GA (`1.0.0-rc.2`), so this is the cheap moment to align. Each
rename ships with a `@deprecated` re-export alias for the old name, so no `rc` consumer
hard-breaks:

| Old (deprecated)    | Canonical               | Package            |
| ------------------- | ----------------------- | ------------------ |
| `loggerSink`        | `nestLoggerSink`        | `@stitchapi/nest`  |
| `LoggerLike`        | `NestLoggerLike`        | `@stitchapi/nest`  |
| `fromConfig`        | `fromNestConfig`        | `@stitchapi/nest`  |
| `borrowStore`       | `nestBorrowStore`       | `@stitchapi/nest`  |
| `ConfigServiceLike` | `NestConfigServiceLike` | `@stitchapi/nest`  |
| `RequestSeam`       | `HonoRequestSeam`       | `@stitchapi/hono`  |
| `queryOptions`      | `stitchQueryOptions`    | `@stitchapi/react` |

**The aliases are removed at the 1.0 GA cut.** Tests pin the alias identity until then
([nest](../../packages/nest/test/module.spec.ts),
[react](../../packages/react/test/hooks.spec.tsx)).

## Enforcement

- **Review gate.** This ADR is the reference; new adapter packages and exports are
  checked against rules 1–6 in review. `pnpm check:exports` surfaces the full public
  surface of each package so a reviewer can eyeball it.
- **Future (optional).** A small lint over each published package's `index.ts` could
  assert "an adapter/provider package exports no bare, non-branded identifier" (no
  export that is neither `Stitch`-/`{provider}`-prefixed nor a specific `from{Lib}`).
  That would mechanize rule 6. Deferred until the surface grows enough to justify the
  machinery — this sweep covered every published package by hand.

## Alternatives considered

- **Drop the prefix everywhere** (`loggerSink` / `LoggerLike` in every package).
  Rejected: it re-creates the exact core collision nest already suffered and leans on
  the Go stutter rule, whose premise (mandatory qualification) JS named imports
  violate.
- **Uniform `{ecosystem}LoggerSink` everywhere**, including `pinoSink` →
  `pinoLoggerSink`. Rejected for the minimal-token form (rule 3): it adds a
  redundant token to logger libraries and churns `@stitchapi/pino` for no clarity
  gain, against OTel precedent (`PinoInstrumentation`, not
  `PinoLoggerInstrumentation`).
- **`Stitch`-brand the bridges** (`stitchLoggerSink`). Rejected: the sink bridges the
  _host's_ logger, not Stitch's — the ecosystem token is the informative one.

## Addenda

The 2026-06-20 conformance table above is left **exactly as it was** — it is the record of
what was examined that day, and rewriting it would erase the omissions rather than record
them. Packages the sweep never reached, and rule gaps it could not have seen, are added here
with a date.

### 2026-08-28 — three host adapters were never adjudicated, and rule 6 reads one symbol at a time

The conformance table swept **ten** published packages. `@stitchapi/express` (#207),
`@stitchapi/elysia` (#208) and `@stitchapi/next` (#222) all merged **2026-06-19**, one day
before this ADR was accepted, and appear in **neither** the conformance table nor the
migration table. They are adjudicated here: all three were already `Stitch`-branded on their
primary surface (rule 1) and carried no bare, non-branded adapter export — **rules 1–6 pass,
no rename owed under this ADR.**

That clean verdict is the point. Those three packages were nonetheless carrying two of the
**four competing spellings** of a single concept — the "a stitch failed, turn it into HTTP"
helper, which read `stitchError` (hono), `stitchErrorResponse` (elysia _and_ next),
`toHttpException` (nest), plus `stitchErrorHandler` (express, fastify) and `stitchOnError`
(hono, elysia) for the handler. That is the same one-concept-four-spellings defect this ADR's
own **Context** section opens with, in a different family, and **rules 1–6 cannot express it**:
every rule here adjudicates _one symbol's_ qualification in isolation, so a set of names that
are each individually well-formed but collectively inconsistent passes cleanly. Folded to one
`stitchError` namespace per package (CONTRACT.md §6, 2026-08-28); the missed coverage was a
contributing cause, not the whole one.

`@stitchapi/nest`'s `toHttpException` is the counter-example that fixes the reading: nest
**was** in the table, marked ⚠️→fixed for five other exports, and this bare, non-branded
adapter export — a live **rule 6** violation — was missed anyway. The sweep read the
logger-sink family and stopped, so coverage of a _package_ did not mean coverage of its
_surface_.

**Consequence for the Enforcement section's deferred lint:** the proposed check ("an
adapter/provider package exports no bare, non-branded identifier") would have caught
`toHttpException` and **nothing else** in this family. Cross-package spelling consistency is a
separate rule that no gate in the repo implements — CONTRACT.md's R5 is the only cross-package
lint and it runs the opposite direction, flagging identifiers that are the _same_ in ≥2
packages. Found by reading; guarded per-package by tests.

## References

- [ADR 0001 — package naming & distribution](./0001-package-naming-and-distribution.md) (the `@stitchapi/<name>` adapter tier this refines)
- [ADR 0006 — NestJS integration](./0006-nestjs-integration.md) (the renamed bridge sink; see its 2026-06-20 addendum)
- OpenTelemetry JS instrumentation packages (`{Target}Instrumentation`)
- Auth.js database adapters (`{Backing}Adapter`)
