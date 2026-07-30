# ADR 0014 — Publishing stitch-based API clients: recipe + scaffold, `defineClient` gated on demand

- **Status:** Proposed (leaning: recipe + scaffold now; `defineClient` only if the override-contract earns it)
- **Date:** 2026-06-28
- **Tags:** packaging, authoring, seam, publishing, recipe, primitive-bar, contract-not-dependency

> [!NOTE]
>
> Companion to [ADR 0013](./0013-gen-selective-eject-codegen-from-openapi.md). The
> generator _produces_ a stitch tree; this ADR is about a vendor _publishing_ one
> as an installable package. A generated client is exactly the kind of artifact
> one would publish, so the two compose: generate → publish.

## Context

A service owner wants to let others call their API without hand-writing a full
SDK: declare the API once as stitches, export it as a package, and let anyone
`pnpm add @vendor/foo-api` and call typed operations.

The load-bearing observation is that **[`seam()`](../../packages/core/src/seam.ts)
already _is_ the client** ([ADR 0002](./0002-seam-primitive-and-principal-scoped-auth.md)):
a base URL plus shared `auth` / `retry` / `throttle` with typed `stitch` members
hung off it. So "publish a client" is overwhelmingly a **packaging recipe**, not
new core surface — and this project's bar (the `inferBearer` rejection in #6, the
`pattern` rejection in [ADR 0011](./0011-no-pattern-primitive-schema-reuse-is-the-validators-job.md))
declines primitives a recipe can serve.

The honest baseline recipe:

- **Export a factory, not a seam instance.** The published entry is
  `createFooClient({ auth, baseUrl? }) => seam({ ...fixed, ...consumer })`,
  because the consumer supplies their own credential.
- **Secrets are never baked in.** `env()` / `secretFrom()` resolve at call time
  on the consumer's machine — already true today.
- **Types just work.** Ship `.d.ts`; the consumer gets fully typed
  `getUser({ params: { id } })` with no codegen on their side.
- **Ship a `drift()` snapshot with the package** so the consumer is _told_ when
  the upstream API diverges from what the package was built against — something
  hand-rolled SDKs do not do. Pure convention (a `contract.json` + a prepublish
  script).

The one thing raw `seam` **cannot declare** is the boundary between author-fixed
config, consumer-**required** config (`auth`), and consumer-**overridable** config
(`baseUrl`, for staging / self-host), plus tighten-only **locks** (`throttle`).
`seam`'s merge is tighten-only for some fields, but the author cannot express
_"you MUST supply auth / you MAY override baseUrl / you may not loosen this
throttle."_ That declared override-contract is the only candidate justification
for a primitive.

## Decision

1.  **Ship the recipe now.** A docs page (the factory pattern + `env()` + `.d.ts`

    - bundled drift snapshot) — zero core code, holds every gate, exactly like
      [ADR 0011](./0011-no-pattern-primitive-schema-reuse-is-the-validators-job.md)'s
      "Define an entity once."

2.  **Ship a scaffold — this is the highest-leverage piece and is pure tooling.**
    `create-stitch-package` / `stitch init-package` emits a package with the
    correct `exports`, `"sideEffects": false`, ESM + `.d.ts` build, the
    `createFooClient` factory stub, the contract-snapshot prepublish script, and a
    README. It turns the whole recipe into one command. No new runtime surface.

3.  **Treat `defineClient` as a _candidate thin primitive_, gated on demonstrated
    demand.** It is justified **only** by the declared override-contract above.
    If real publishers want enforced consumer boundaries, add a small
    `defineClient` that compiles to a seam factory and whose policy is **plain
    serializable data** (`require: ['auth']`, `allowOverride: ['baseUrl']`,
    `lock: { throttle: … }`) so it round-trips as JSON like every other stitch
    contract:

    ```ts
    export default defineClient({
        baseUrl: 'https://api.foo.com',
        operations: { getUser, listUsers },
        require: ['auth'], // consumer MUST supply
        allowOverride: ['baseUrl'], // consumer MAY supply (self-host/staging)
        lock: { throttle: { rate: '10/s' } }, // may tighten, never loosen
    });
    // → typed factory: createFooClient({ auth, baseUrl? })
    ```

    If the demand does not materialise, the recipe is the answer and
    `defineClient` stays unbuilt — the same disposition as `pattern` in ADR 0011.
    Either way it is **authoring sugar over `seam`**, never a new runtime engine.

## Why gate `defineClient` (the primitive bar)

- **The recipe already delivers ~90%** — factory, call-time secrets, typed
  `.d.ts`, drift snapshot. The override-contract is the only delta.
- **The delta is small and serializable**, so it _could_ be core — but the
  project rejects primitives without **repeated, demonstrated** demand (#6,
  ADR 0011). One imagined publisher is not demand.
- **The generator may create the demand.** [ADR 0013](./0013-gen-selective-eject-codegen-from-openapi.md)
  makes publishable clients cheap to produce; once people actually publish them,
  we will learn whether enforced consumer boundaries are wanted. Correct
  sequence: ship generator + recipe + scaffold, watch, then decide.

## Gates

- **Contract-not-dependency.** The override policy is **data** (`require` /
  `allowOverride` / `lock` arrays + objects); `auth` stays a descriptor plus a
  call-time closure. The published declaration round-trips as JSON.
- **Bundle-frugal.** `defineClient` (if built) is type-level / a thin wrapper
  over `seam`; the scaffold is build-time tooling. Neither adds weight to
  `import { stitch }`.
- **Zero-deps.** No core dependency in any branch of this decision.

## Out of scope (considered, deferred)

- **A registry / marketplace of stitch clients.**
- **Automatic semver-coupling of the client package to the API contract** — the
  drift snapshot _surfaces_ divergence; it does not version the package for you.
- **Runtime negotiation of the override policy** — the policy is a build/author-
  time declaration, enforced when the factory is called, not negotiated over the
  wire.

## Revisit if

- Repeated publisher demand for **enforced consumer boundaries** appears — then
  build the thin, serializable `defineClient` of Decision 3. Until then, the
  recipe (Decision 1) and the scaffold (Decision 2) are the whole answer.
