# ADR 0011 — No `pattern` primitive: schema reuse is the validator's job

- **Status:** Rejected
- **Date:** 2026-06-18
- **Tags:** validation, schema, primitive, validator-agnostic, contract-not-dependency, browser-first, rejected

> [!NOTE]
>
> This records a primitive we considered and **declined to build**. The
> motivation behind it is real and is served instead by a recipe
> ([Define an entity once](../../apps/docs/content/docs/recipes/define-an-entity-once.mdx)),
> not new core surface. The load-bearing reason is the same bar that rejected
> `inferBearer` (#6) and generic spec-only fingerprinting ([ADR 0004](./0004-standard-schema-fingerprint-for-cache-invalidation.md)): a capability that cannot be built on the contract core speaks, only by adopting a dependency or re-implementing one, does not belong in core.

## Context

A proposal surfaced for a new primitive — working name `pattern` — that would
"combine schema and validator." A user would define a shape once and pass it to
many stitches as `input.body`, `output`, `input.params`, and so on. The pattern
would carry TypeScript-style structural methods — `.partial()`, `.required()`,
`.pick()`, `.omit()`, `.extend()` — so one definition could be reshaped per
endpoint:

```ts
// The proposed shape (NOT shipped)
const User = pattern({ id: number, name: string, createdAt: string });
const createUser = stitch({
    input: { body: User.omit('id', 'createdAt') },
    output: User,
});
const updateUser = stitch({ input: { body: User.partial() }, output: User });
```

The kernel is legitimate. REST is resource-oriented: you have a `User`, and the
endpoints are CRUD over it — create body is `User` minus the server-assigned
fields, update body is `User` partial, the response is the full `User`. Defining
that entity once and deriving the request/response shapes from it is a real,
common need (it is what Prisma, Orval, and the OpenAPI codegens lean on). The
question this ADR answers is **not** "is entity-first reuse worth supporting" —
it is — but "should StitchAPI own that abstraction as a core primitive."

## Decision

**No.** We will **not** add a `pattern` primitive (or any core schema type with
structural composition methods). Schema definition and composition stay the
**validator's** responsibility; StitchAPI consumes the result through the
existing `SchemaLike` → `toValidator()` path. The entity-first need is served by
documentation — the [Define an entity
once](../../apps/docs/content/docs/recipes/define-an-entity-once.mdx) recipe —
which uses the validator's own methods (`z.object().omit()/.partial()/.pick()`,
and the Valibot/ArkType/Effect equivalents).

## Why — the primitive fights the architecture

Five reasons, four of them tied directly to the gates in
[principles](../../apps/docs/content/docs/concepts/principles.mdx):

1.  **The premise is already satisfied.** "Combine schema and validator" assumes
    a split that modern validators do not have. A `z.object({...})` (or Valibot
    / ArkType / Effect schema) **is** both the structural description and the
    runtime validator. StitchAPI already unifies them: `SchemaLike` →
    `toValidator()` ([`validator.ts`](../../packages/core/src/validator.ts))
    normalizes any schema to a `Validator<T>` at compose time, and inference
    reads the phantom output type through it
    ([`infer.ts`](../../packages/core/src/infer.ts)). There is nothing left to
    combine.

2.  **Standard Schema — the contract core actually speaks — exposes only
    `validate()`.** The interface
    ([`standard-schema.ts`](../../packages/core/src/standard-schema.ts)) is
    deliberately `{ '~standard': { version, vendor, validate, types? } }`. It
    has **no** `.partial()`, `.pick()`, `.omit()`, or `.extend()`. Structural
    composition lives on the concrete validator object, not on the contract. So
    a generic `pattern.partial()` cannot be implemented over what core consumes.
    The only ways to build it are:

    - **(a)** build a schema AST with its own composition semantics — which
      **is** building a validator, the one thing core refuses (zero validator
      imports in `src/`; zod is a devDependency only); or
    - **(b)** parse JSON Schema and re-emit a validator — lossy and generically
      impossible (the same wall [ADR 0004](./0004-standard-schema-fingerprint-for-cache-invalidation.md) hit: `~standard` is opaque, JSON Schema is lossy); or
    - **(c)** dispatch to each validator's native methods through a per-vendor
      adapter registry (see "The only version that adds value").

3.  **It fails contract-not-dependency.** Capabilities in StitchAPI must
    round-trip as JSON — `kind` collapses to a string id on `__config`, `auth`
    to a descriptor, and so on. A `pattern` object carrying live `.pick()` /
    `.omit()` closures does not serialize; it is live JS with methods. A core
    primitive whose whole value is its methods sits on the wrong side of the
    line the library already draws (where `transform`, `paginate.next`, and
    `cache.key` are acknowledged non-serializable **sugar**, not core contract).

4.  **It fails bundle-frugal and zero-deps.** A schema engine in core — option
    (a) — is exactly the weight the project refuses. Core is 0 runtime/peer deps
    and the main entry is budgeted in single-digit-over-20 kB; a composition
    engine would blow both, to re-create what the user's validator already
    ships.

5.  **It is already achievable today, with no new API.** The validator the user
    has chosen already does all of this. The recipe is the proof:

    ```ts
    const User = z.object({
        id: z.number(),
        name: z.string(),
        createdAt: z.string(),
    });
    const NewUser = User.omit({ id: true, createdAt: true });
    const UserPatch = NewUser.partial();
    // stitch({ input: { body: toValidator(NewUser) }, output: toValidator(User) })
    ```

## The only version that would add value — and why it is rejected too

The single thing `pattern` could offer beyond "use your validator's methods" is
a **uniform composition API across all validators** — one `.partial()` that
works whether the user is on Zod, Valibot, ArkType, or Effect. The only way to
build that is option (c): a `SchemaShaper` registry mirroring the fingerprint
design — `packages/shape-zod`, `shape-valibot`, … — each mapping
`partial/pick/omit/required/extend` onto that vendor's native calls, dispatched
by `~standard.vendor`.

We reject this as well, on the same grounds as `inferBearer` and generic
fingerprinting:

- **The demand is near-zero.** People pick **one** validator and stay there.
  Cross-validator uniform composition solves a problem almost no one has.
- **The surface is large and permanent.** Five vendors × six operations ×
  their structural quirks (refinements, transforms, effects that do not
  survive a `.partial()`) is a maintenance burden that re-creates each
  validator's own API — slightly worse, forever.
- **It earns its keep only at the seam between two validators**, which is not a
  place real codebases live.

If credible, repeated demand for cross-validator uniform composition ever
appears, the door is the opt-in `shape-*` peer-dependency family — **never**
core. Until then it is not worth a line of code.

## What we ship instead

- **A recipe**:
  [Define an entity once, derive every request shape](../../apps/docs/content/docs/recipes/define-an-entity-once.mdx)
  — the entity-first pattern with the validator's own methods, feeding both
  runtime validation (every slot) and the TS type (`z.infer`). Zero core code;
  holds every gate; doubles as in-context teaching for the
  agent-recommendation work.
- **The genuinely StitchAPI-shaped "define once" already exists**: deriving
  _artifacts_ from one schema — `toOpenApi` and the BYO `toJsonSchema`
  converter (`stitch export --openapi --schema-module`). That is "define once,
  emit many" done as a contract, not as a live primitive.

## Consequences

- Schema authoring and composition remain entirely the validator's job; core's
  only schema contract stays `validate()` via Standard Schema.
- "Why isn't there a `Schema`/`pattern` type?" is now a settled question with a
  referenceable answer, for both humans and agents reading the source.
- Reversible: this rejects a primitive, not the motivation. The recipe can grow,
  and the `shape-*` registry remains available as an opt-in escape hatch if the
  demand ever materializes.

## Revisit if

- Standard Schema (or a successor contract) gains a **serializable** structural
  description that composition could be defined over without adopting a vendor.
- Multiple independent adopters demonstrate real need for cross-validator
  uniform composition — at which point the answer is `shape-*` peer packages,
  not core.
