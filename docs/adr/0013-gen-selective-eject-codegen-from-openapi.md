# ADR 0013 — `stitch gen`: selective, eject-model codegen from OpenAPI

-   **Status:** Proposed
-   **Date:** 2026-06-28
-   **Tags:** codegen, openapi, cli, eject, bundle-frugal, contract-not-dependency, atomicity, audit, lint

> [!NOTE]
>
> This is the **ingestion** counterpart to the export that already ships.
> [`stitch export --openapi`](../../packages/core/src/openapi.ts) emits OpenAPI
> 3.1 _from_ a registry of stitches; [`from-curl`](../../packages/core/src/from-curl.ts)
> emits a paste-ready stitch _from_ a curl command. There is no path **into**
> stitches from a spec. [ADR 0011](./0011-no-pattern-primitive-schema-reuse-is-the-validators-job.md)
> already named the OpenAPI codegens (Orval et al.) as the legitimate home of
> "define once, emit many" — done as an **artifact**, not a runtime primitive.
> This ADR builds that home.

## Context

The request: a vendor (or a consumer) has an OpenAPI document and wants stitches
out of it. Two framings collapsed into one design over the course of the
discussion that produced this ADR:

-   **API client authors** want to publish a stitch-based client instead of
    hand-writing an SDK. The publishing half of that is a packaging recipe and is
    handled separately in [ADR 0014](./0014-publishing-stitch-based-clients.md);
    the **generation** half — "turn my spec into stitches" — is this ADR.
-   **Spec import** as a standalone feature.

The first goal is explicitly **not** "scaffold a whole API integration from a
schema." It is a **selective, surgical** tool: the user decides _which_
operations become stitches and skips the rest, the files land in an output
directory the user **owns and reshuffles afterward**, and the generator does not
come back to manage them. Eject, not managed regeneration.

The second hard constraint is **frontend bundle size** — "these stitches can be
used on the frontend where every bit counts." That single sentence drives the
whole file-layout decision (atomicity), the validator-tier defaults, and the
self-owned orphan detection below.

## Decision

1.  **Eject, not regenerate.** The generator is a **one-shot emit** of readable
    stitch source that the author then owns outright. No managed
    regenerate-on-change, no overlay sidecar that must stay in sync, no merge
    engine. Re-running against an updated spec is _re-emit into a scratch dir and
    diff_, never a three-way merge. This resolves the one real architectural fork
    (eject vs. managed-regen) in favour of eject, because the stated goal —
    cherry-pick operations and then **reorganise the files freely** — is exactly
    what a managed regenerator fights (a regenerator must own the tree to keep it
    in sync). A managed mode can be added later as an opt-in (see _Out of scope_),
    but it is not the first goal.

2.  **Selection is the spine, not an afterthought.** Because "pick what to stitch,
    skip the rest" _is_ the feature:

    -   **Interactive (default):** parse the spec, present a multi-select list of
        operations grouped by tag (`METHOD path — operationId`), generate only
        the checked ones.
    -   **Non-interactive (CI/scripting):** `--only`, `--tag <t>`,
        `--operation <id>`, `--grep '<glob>'`, `--all`.

    This is what makes the tool "cherry-pick into stitches" rather than "scaffold
    the entire API."

3.  **Co-locate by operation; the stitch directory is the unit of deletion.** The
    layout groups **by operation**, not by kind. Everything private to an
    operation lives inside that operation's directory and dies with it — delete
    the directory and its types/schemas vanish with no orphans left behind. The
    seam (base URL + shared defaults) is `client.ts`; anything shared across
    operations is hoisted to `_shared/` (Decision 4).

    ```
    src/foo/
      client.ts          # the seam: baseUrl, default auth/retry/throttle (TODOs)
      _shared/
        user.ts          # referenced by ≥2 selected operations
      get-user/
        index.ts         # the stitch
        schema.ts        # types/schemas used ONLY by get-user
      list-users/
        index.ts
        schema.ts
    ```

    This is the inverse of the conventional `schemas/` + `operations/` layout,
    chosen because group-by-kind leaves dead types behind in a central file when
    an operation is removed — the opposite of the atomicity goal.

4.  **Ownership by fan-in over the _condensed_ `$ref` graph.** Where a schema
    lives is decided by how many _selected_ operations reference it, not by where
    it sits in the spec's `components`:

    -   referenced by exactly **one** selected operation → emit it private, inside
        that operation's directory (dies with it);
    -   referenced by **two or more** → hoist to `_shared/`.

    The reference count is computed on the **condensation** of the `$ref` graph
    (collapse each strongly-connected component into a single node, then count
    fan-in on the condensed node). This guarantees that a mutually-recursive
    cluster (`User ↔ Post`) is placed as a **unit** — it can never be split
    across owners such that deleting one operation orphans half a cycle. The same
    cycle detection feeds Decision 5's `lazy` wrapping. This fan-in-on-the-
    condensed-graph pass is the only genuinely new algorithm in the feature, and
    it is a single pass over the selected closure.

5.  **Atomic schemas _and_ atomic types — one component per file.** For runtime
    validators this is a **bundle** decision: with one schema per file, an
    operation pulls **exactly the transitive `$ref` closure it references and
    nothing more** — the import graph _is_ the bundle graph. A single
    `schemas.ts` barrel defeats this in practice, because bundlers will not
    reliably tree-shake independent runtime _values_ out of a module full of
    interdependent definitions. Concretely:

    -   No eager schema barrel (`_shared/index.ts` re-exporting everything
        re-couples the graph); operations **deep-import** `../_shared/user`.
    -   Recursive/mutual `$ref`s wrap the cyclic nodes in the validator's lazy
        constructor (`z.lazy(() => …)`, `v.lazy(() => …)`), since ES modules
        handle the circular _import_ but the validator needs help with the
        circular _value_.
    -   Generated package is `"sideEffects": false`, ESM.

    For **types** the motive is different and must not be oversold: TS types erase
    at build, so atomic types buy **zero** bundle bytes. They are atomic for
    **deletability and DX** — no central monster `types.ts`, deletable units,
    faster `tsc`/IDE, and layout symmetry with the schemas so reshuffling is
    uniform. A `types/index.ts` barrel is harmless there (types are free), but
    the per-operation co-location of Decision 3 still applies.

6.  **Validator tiers, skewed for the frontend.** The generator emits validator
    **source** for a chosen target:

    -   `types-only` — emit TS types only; `output` is a passthrough/predicate.
        Zero runtime weight; the lightest frontend tier by far.
    -   `valibot` — modular, function-based, built for tree-shaking; you pay
        roughly per-validator-used. The recommended default for the frontend
        story.
    -   `zod` — ergonomic but a chunkier, less-shakeable baseline; fine for a
        backend SDK, heavier for bit-counting frontends.

    **Consistency with [ADR 0011](./0011-no-pattern-primitive-schema-reuse-is-the-validators-job.md):**
    this emits validator **source code at build time**; it does **not** add a
    runtime JSON-Schema→validator capability to core, and core gains no schema
    engine. The JSON-Schema→validator-source mapping is the generator's bounded,
    build-time job — the symmetric inverse of `openapi.ts`'s BYO `toJsonSchema`
    converter — and lives entirely in the CLI. ADR 0011 explicitly blesses this:
    "define once, emit many" as an artifact is fine; a live core primitive is
    not.

7.  **Spec gaps become `// TODO` placeholders, not required configuration.**
    Eject means we emit good-enough code and let the author finish it in place.
    An OpenAPI document does not carry the operational facts a stitch needs, so:

    -   `securityScheme → auth strategy` **shape** is emitted (`bearer` / `apiKey`
        / `basic` / `oauth2` all already exist in
        [`auth.ts`](../../packages/core/src/auth.ts)); the **secret source** is a
        TODO: `auth: bearer(env('FOO_TOKEN')) // TODO: set env var`.
    -   `throttle` / `retry` — never in the spec — are emitted as commented
        defaults to fill in.
    -   `pagination` and `server` choice (when multiple) — TODO.

    No overlay config file is required for v1. (The overlay was the _managed-regen_
    model's tax; eject drops it.)

8.  **Parse + deref without burdening core.** The generator is **CLI-only** —
    reached through [`cli.ts`](../../packages/core/src/cli.ts) like `from-curl`,
    never from `import { stitch }`, so the core bundle and its zero-dep gate are
    untouched. Local `#/components/...` `$ref`s are resolved by a **hand-rolled,
    bounded resolver** in the from-curl tradition (refs within a single document
    are a small, regular problem). YAML input and external/remote `$ref`s are the
    open question (Q1).

### Self-owned orphan detection

Because eject means the author hand-deletes operations, a `_shared/` schema can
lose its last consumer and become dead code with the generator no longer around
to notice. We detect this **ourselves** rather than reaching for `knip`/`ts-prune`
— that is what users expect given the zero-dep nature of the project, and we
already own the graph.

9.  **A generated manifest — exact and nearly free.** Emit `.stitch-gen.json`
    alongside the output recording the ownership graph already computed in
    Decision 4 (each schema → its file → its importers, plus which files are
    stitch entry points). `stitch gen prune` reads it, checks which stitch
    directories still exist on disk, recomputes reachability, and flags any
    `_shared/` file nothing reaches. Exact and instant on the as-generated
    layout, and it doubles as documentation of the ownership graph. It goes stale
    once the tree is heavily reshuffled (recorded paths drift) — that is what
    Decision 10 covers.

10. **A zero-dep import scanner — robust to reshuffling.** This is the part users
    actually expect ("stitch finds the dead schemas itself"), and it is feasible
    without a TypeScript parse because we only need the **ESM import/export-from
    sublanguage**, which is tiny and regular:

        -   mark roots: the package `index.ts` exports + every file containing a
            `stitch(` call;
        -   build edges from each module's import/export specifiers via a small
            purpose-built tokenizer;
        -   mark-and-sweep; any schema/type file unreachable from a root is an orphan.

        The honest cost is in the tokenizer, not the algorithm: it must track
        string/comment state and handle multiline imports, side-effect imports
        (`import './x'` — an **edge**, not an orphan), `export * from` / `export { x }

    from` re-exports, **`import type`/ inline`type {}`as edges** (or every type
file is flagged dead), and dynamic`import('…')`, while ignoring `import`-like
text inside strings and comments. A few hundred lines of bounded, dependency-
free code — the same "hand-roll the bounded sublanguage" move as the curl
parser and the `$ref`resolver.`stitch gen prune --fix` deletes the orphans.

        ```
        stitch gen prune ./src/foo          # list orphans (manifest, then scanner)
        stitch gen prune ./src/foo --fix    # delete them
        ```

### Evolution — `gen` is the seed of a `stitch audit` / lint surface

11. The ownership graph (Decision 4), the manifest (9), and the import scanner
    (10) are general-purpose static analysis over a stitch tree, not single-use
    codegen plumbing. They generalise — and this is a deliberate forward seam,
    flagged now so the `gen` module is structured for it:

    -   **dead-schema detection** — already, via `prune`;
    -   **rule enforcement** (`stitch audit` / a lint mode), e.g. _every operation
        must declare both `input` and `output`_, _no `output: any`_, _write
        methods must set `throttle`_, _no operation without `auth` on a non-public
        path_, _a drift snapshot must accompany a published client_;
    -   **audit reports** over a whole tree — which operations lack validation,
        which schemas are shared, the bundle-closure size per operation.

    These are build-time, zero-dep, and **contract-reading** (they read the
    `__config`-shaped declarations plus the source graph). Ship `gen` first; the
    `audit`/`lint` command family is the natural follow-up in the same module.
    Designing the rule set is explicitly _out of scope_ here — this decision only
    reserves the seam and the command namespace.

## Gates

-   **Browser-first.** Generated clients ride the existing surfaces/adapters; the
    emitted code is browser-safe (secrets via `env()` resolve at call time on the
    consumer; no `fs`). The generator _itself_ is a Node CLI tool, which is
    correct — it is build-time, never shipped to the consumer's bundle.
-   **Bundle-frugal.** Atomic per-operation layout + atomic schemas + no eager
    barrel + `types-only`/`valibot` tiers ⇒ an operation costs its transitive
    `$ref` closure and nothing else. The generator, `prune`, and the future
    `audit` are CLI-only, never reachable from `import { stitch }`.
-   **Contract-not-dependency.** Generated stitch declarations round-trip as JSON
    like any hand-written stitch (`auth` → descriptor, surface → id per
    [ADR 0005](./0005-surfaces-and-the-authoring-model.md)). The generator reads
    a contract (OpenAPI) and emits contracts (stitches) — symmetric to
    `export --openapi`. No live-closure dependency is introduced into the
    declaration.
-   **Zero-deps.** Core untouched. The generator hand-rolls its bounded parsers
    (local `$ref` resolver, import scanner) in the from-curl tradition; any
    heavier parse (YAML, remote deref) is a lazily-loaded **CLI-only** optional,
    never a core runtime/peer dependency.

## Open questions

-   **Q1 — YAML and external/remote `$ref` ingestion.** Hand-roll local
    (`#/components/...`) resolution and require JSON / pre-dereferenced input for
    everything else, or lazily `require` a CLI-only optional (a YAML parser /
    spec dereferencer) when the input needs it? _Leaning:_ local `$ref` + JSON in
    v1; YAML behind a lazy optional; remote/`$dynamicRef` out (see _Out of
    scope_).
-   **Q2 — validator default.** `types-only` (safest zero-runtime default) or
    `valibot` (best frontend runtime story)? _Leaning:_ `types-only` as the
    default, `valibot` as the recommended runtime tier, `zod` opt-in.
-   **Q3 — layout granularity.** Directory-per-operation (Decision 3) vs. flat vs.
    single-file, via `--layout`? _Leaning:_ directory-per-operation as the
    default (most deletable/reshuffleable), `--layout flat|single` as escape
    hatches.
-   **Q4 — naming when `operationId` is absent.** Deterministic fallback
    (`${method}_${pathToIdentifier}`) plus a collision-disambiguation rule.
-   **Q5 — does `prune` graduate?** Ship as `stitch gen prune`, then generalise
    the scanner into `stitch doctor` / `stitch audit` (Decision 11)?

## Out of scope (considered, deferred)

-   **Managed regeneration / overlay-merge engine** — explicitly rejected by
    Decision 1 for the first goal; revisit only if users ask for sync-on-spec-
    change, and then as an opt-in mode, never the default.
-   **Remote / external `$ref` and `$dynamicRef` resolution.**
-   **Mock-server / MSW-handler generation from the spec.**
-   **Pagination auto-detection** — the spec rarely carries it machine-readably;
    emitted as a TODO (Decision 7).
-   **The full `audit`/`lint` rule set** — Decision 11 reserves the seam; the
    rules are their own design.
-   **GraphQL SDL → stitches** — the symmetric idea for a different surface; its
    own spec.

## Alternatives considered

-   **A. Managed regenerator (Orval-style), regenerate on spec change with an
    overlay holding human additions.** Rejected as the _first_ goal: the stated
    need is cherry-pick + free reshuffle, which a regenerator fights because it
    must own the tree to stay in sync. Eject first; managed mode later, opt-in.
-   **B. Group-by-kind layout (`schemas/`, `operations/`).** Rejected: deleting an
    operation leaves orphan types in a central file — the opposite of the
    atomicity goal (Decision 3).
-   **C. A single shared `schemas.ts` barrel.** Rejected: defeats tree-shaking of
    runtime values in practice; an operation drags the whole module's value graph
    (Decision 5).
-   **D. Lean on `knip` / `ts-prune` for orphans.** Rejected: a dev dependency and
    a brand mismatch with the zero-dep ethos; we own the graph, so we detect
    orphans ourselves (Decisions 9–10).
-   **E. Bundle a JSON-Schema→zod compiler into core.** Rejected by
    [ADR 0011](./0011-no-pattern-primitive-schema-reuse-is-the-validators-job.md):
    no core schema engine. The generator emits validator _source_ at build time
    instead (Decision 6).
-   **F. Require a complete overlay config up front.** Rejected: that is the
    managed-regen model's tax; eject uses TODO placeholders so the tool runs with
    zero config (Decision 7).
