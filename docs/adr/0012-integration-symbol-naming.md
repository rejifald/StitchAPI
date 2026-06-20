# ADR 0012 — Integration symbol naming (ecosystem-qualified adapters)

-   **Status:** Accepted (2026-06-20). Applies to every `@stitchapi/*` adapter package; the first enforcement pass renames `@stitchapi/nest`'s `loggerSink` / `LoggerLike` (the only violators at the time of writing).
-   **Date:** 2026-06-20
-   **Tags:** naming, conventions, public-api, packaging, adapters, integrations, dx

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

-   **OpenTelemetry** — `@opentelemetry/instrumentation-pino` exports
    `PinoInstrumentation`; `@opentelemetry/instrumentation-fastify` exports
    `FastifyInstrumentation`. It also drops _redundant_ tokens: it is
    `PinoInstrumentation`, not `PinoLoggerInstrumentation`.
-   **Auth.js** — `@auth/prisma-adapter` exports `PrismaAdapter`,
    `@auth/drizzle-adapter` exports `DrizzleAdapter`.
-   The bare-export camp (Vite/Rollup plugins → default `react()`, `vue()`) still
    names the export after the **target ecosystem**, never the host runtime — the same
    principle by a different mechanism.

## Decision

**1. Two package archetypes, two rules for the _primary_ surface.**

-   **Host adapters** — you plug Stitch _into_ a framework (`fastify`, `hono`, `nest`,
    `react`). The primary surface is **`Stitch`-branded**, because the thing you
    register/use _is_ Stitch: `stitchPlugin`, `stitch` (middleware), `StitchModule`,
    `useStitch`.
-   **Capability providers** — an external library _backs_ a Stitch capability
    (`pino`, `redis`). The primary surface is **`{provider}`-branded**, because the
    name's job is to say _which_ backing it is: `pinoSink`, `redisStore`.

**2. Cross-cutting bridge/adapter helpers are ecosystem-qualified.** A helper that
adapts one of a host's subsystems (its logger, its config) into a Stitch seam is named
`{ecosystem}{Subsystem}` — `fastifyLoggerSink`, `nestLoggerSink` — with the matching
`{Ecosystem}{Subsystem}Options` and `{Ecosystem}{Subsystem}Like` duck-type.

**3. Use the _minimal_ subsystem token (the OTel refinement).** Qualify with the
ecosystem plus only the token needed to answer _"which subsystem of that ecosystem?"_

-   A logger library already _is_ a logger, so the token is redundant: `pinoSink`
    (not `pinoLoggerSink`).
-   A web framework is not a logger, so name the subsystem you are bridging:
    `fastifyLoggerSink`, `nestLoggerSink` (you are bridging its `.log`, not its router).

**4. Constructors that adapt a foreign instance use `from{Source}`.** e.g.
`fromIoredis`, `fromNodeRedis`, `fromConfig`. The source token names the thing being
adapted.

**5. The generic base in `core` stays bare.** `core`'s `loggerSink` / `LoggerSinkOptions`
/ `LoggerLike` / `consoleSink` / `fileSink` / `memoryStore` are the _unqualified_
primitives. Bare is correct there precisely because they are the generic base every
qualified adapter specializes — and it keeps the qualified names meaningful as
"the {ecosystem} flavor of the core thing."

## Conformance at adoption (2026-06-20)

| Package               | Verdict                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `stitchapi` (core)    | ✅ generic base — bare names are correct                                                    |
| `@stitchapi/fastify`  | ✅ already canonical (`fastifyLoggerSink`, `FastifyLoggerLike`, `FastifyLoggerSinkOptions`) |
| `@stitchapi/hono`     | ✅ `Stitch`-branded surface; no logger bridge                                               |
| `@stitchapi/pino`     | ✅ `pinoSink` (the `Logger` token is rightly elided for a logger library)                   |
| `@stitchapi/redis`    | ✅ `redisStore`, `fromIoredis`, `fromNodeRedis`                                             |
| `@stitchapi/react`    | ✅ `Stitch`-branded surface (`useStitch`, `createStitchQuery`)                              |
| **`@stitchapi/nest`** | **⚠️ → fixed here:** `loggerSink` → `nestLoggerSink`, `LoggerLike` → `NestLoggerLike`       |

`@stitchapi/nest` was the only violator. `NestLoggerSinkOptions`, `fromConfig`,
`borrowStore`, and `ConfigServiceLike` were already on-pattern and are unchanged.

## Migration & deprecation

Every package is pre-GA (`1.0.0-rc.2`), so this is the cheap moment to align. The
rename ships with `@deprecated` re-export aliases for the old names
(`loggerSink = nestLoggerSink`, `type LoggerLike = NestLoggerLike`) so no `rc`
consumer hard-breaks. **The aliases are removed at the 1.0 GA cut.** A test pins the
alias identity until then ([`module.spec.ts`](../../packages/nest/test/module.spec.ts)).

## Enforcement

-   **Review gate.** This ADR is the reference; new adapter packages and exports are
    checked against rules 1–5 in review. `pnpm check:exports` surfaces the full public
    surface of each package so a reviewer can eyeball it.
-   **Future (optional).** A small lint over each package's `index.ts` could assert
    "a host-adapter package exports no bare `loggerSink` / `LoggerLike` / `*Sink`."
    Deferred until a second violation justifies the machinery — one ADR + review has
    covered every package so far.

## Alternatives considered

-   **Drop the prefix everywhere** (`loggerSink` / `LoggerLike` in every package).
    Rejected: it re-creates the exact core collision nest already suffered and leans on
    the Go stutter rule, whose premise (mandatory qualification) JS named imports
    violate.
-   **Uniform `{ecosystem}LoggerSink` everywhere**, including `pinoSink` →
    `pinoLoggerSink`. Rejected for the minimal-token form (rule 3): it adds a
    redundant token to logger libraries and churns `@stitchapi/pino` for no clarity
    gain, against OTel precedent (`PinoInstrumentation`, not
    `PinoLoggerInstrumentation`).
-   **`Stitch`-brand the bridges** (`stitchLoggerSink`). Rejected: the sink bridges the
    _host's_ logger, not Stitch's — the ecosystem token is the informative one.

## References

-   [ADR 0001 — package naming & distribution](./0001-package-naming-and-distribution.md) (the `@stitchapi/<name>` adapter tier this refines)
-   [ADR 0006 — NestJS integration](./0006-nestjs-integration.md) (the renamed bridge sink; see its 2026-06-20 addendum)
-   OpenTelemetry JS instrumentation packages (`{Target}Instrumentation`)
-   Auth.js database adapters (`{Backing}Adapter`)
