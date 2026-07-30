# StitchAPI — Messaging

> **Seeds, not shipped copy.** This doc holds the raw value props and buying lines we
> draw _from_ when writing anything user-facing — the landing page, the README, a docs
> intro, a tweet. **Nothing here renders verbatim.** Each entry is a seed: reword it in
> context, in the brand [Voice](brand/README.md#5-voice), before it reaches a user.
>
> Companion to [`OVERVIEW.md`](OVERVIEW.md) §5 — that doc holds the strategic _why_
> behind each line; this one holds the line. Working draft · 2026-06.

---

## ⚠️ How to use this doc

- **Not UI-facing.** No string here is meant to ship as-is — it's source material, not a
  headline. Treat each line like a prompt for the real copy, then throw the seed away.
- **Honest by construction.** Every buying line is paired with the capability that already
  ships (the "Backed by" line). If a line loses its backing, **cut the line** — don't
  soften it into a promise we don't keep.
- **Neutral archetypes only.** No third-party vendor names in any line that could reach a
  public artifact — use archetypes (an auth-gated SaaS, a multi-provider aggregator). See
  OVERVIEW §8.

---

## One-liner (seed)

**API stitching:** turn any API into a typed, resilient function — declare an endpoint once,
call it like a local function, and adopt it one endpoint at a time. Keep the `fetch`/axios you
already have; a stitch sits _above_ it (a pluggable adapter), it does not replace it.

---

## Buying lines

Each line names the objection it answers and the shipped fact that keeps it honest.

### No commitment

> Try it on one endpoint. No new infrastructure, no migration, no rewrite — a stitch is a
> per-call primitive you drop in next to the `fetch` you already have.

- **Kills:** _"I can't adopt a framework or rebuild my whole API layer just to try this."_
- **Backed by:** atomic stitches, no global config (OVERVIEW §8); spec-less — "one endpoint
  or one example," not a whole OpenAPI doc (OVERVIEW §1, §5.1).

### Works with what you already have

> Keep your HTTP client, keep your validator. Stitch plugs into fetch or axios through
> adapters, validates with Zod, Valibot, or ArkType out of the box — and wraps any other
> validator (Yup, a custom check) in a one-line predicate.

- **Kills:** _"I already have a stack; I don't want to swap my client or my schema library."_
- **Backed by:** pluggable HTTP adapters — `fetchAdapter` (default) + `axiosAdapter` ship today
  (**don't hardcode the set in copy** — pull the current list from the exports:
  [`packages/core/src/index.ts`](../packages/core/src/index.ts)); Standard-Schema validation
  (Zod / Valibot / ArkType), plus a predicate escape hatch for everything else
  (OVERVIEW §5.6; `validator.ts`).

### Fits your style

> Declare a stitch the way you already write code — a fluent builder, a config object, or
> extend-and-override. Callbacks or pure functions, your call.

- **Kills:** _"This will force one rigid authoring pattern on my codebase."_
- **Backed by:** two interchangeable facades — `extends` / fluent builder — over one
  engine, plus `seam` for shared surfaces (OVERVIEW §6).

---

## Objection → answer (seeds)

| They say                              | Seed answer                                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "An LLM can just write `fetch`."      | The value is the runtime _under_ the call — retries, auth-as-boundary, pagination, drift — not the call itself.                                                      |
| "Is this another typed client?"       | Those need a spec and stop at types. Stitch is spec-less and agent-native: resilience + validation + observability folded into the call.                             |
| "Isn't this just tRPC?"               | tRPC needs you to own _both_ ends and share types across them. Stitch is for the APIs you _don't_ own — no shared server, no codegen; you bring the validator.       |
| "Do I still need React Query / SWR?"  | Yes — and they compose. A stitch is the dependable callable (the `queryFn`); your query layer owns view state. Stitch owns the call, not your cache-in-UI.           |
| "Is this a fetch replacement?"        | No. Not an HTTP client and not a fetch competitor — `fetch`/axios are the substrate underneath (BYO adapter). A stitch turns an endpoint into a function _above_ it. |
| "Is this an iPaaS / workflow engine?" | No. It's a library and a per-call primitive; composition is code, never a visual builder.                                                                            |

---

## Words we avoid

- **"Replaces `fetch`," "a better `fetch`," "HTTP client / HTTP library."** StitchAPI is
  _not_ an HTTP library and not a `fetch` competitor — `fetch`/axios are the substrate it sits
  above (BYO adapter). Position it as **API stitching**: turning an endpoint into a function.
  Say "keep your `fetch`," never "replace it." (This is the 2026-06 positioning pivot — the
  old "a typed stitch replaces `fetch`" line is retired.)
- **Vendor names** in public lines — neutral archetypes only (OVERVIEW §8).
- **"Platform," "framework," "orchestrator"** — we're a _library_ and a _primitive_; the
  scope-creep-into-iPaaS risk is real (OVERVIEW §11). Hold the line.
- **Maturity overreach** — features in progress stay labelled in progress; the "under heavy
  development" candor is a feature, not a bug (brand Voice).
