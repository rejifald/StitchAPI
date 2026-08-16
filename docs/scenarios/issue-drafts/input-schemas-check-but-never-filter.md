# `input` schemas check but never filter — the parsed value is discarded

**Status:** ✅ **FILED** as [#648](https://github.com/rejifald/StitchAPI/issues/648)
**Scenario:** [agent-holds-the-tool](../agent-holds-the-tool.md)
**Proofs:** `docs/scenarios/proofs/agent-holds-the-tool/c7-schema.ts`

## What happens

`validateInput` (`packages/core/src/engine.ts:384-409`) awaits the validator, checks `r.ok`,
throws on failure — and **drops `r.value` on the floor**. The original, unparsed input goes to
the transport.

`validateOutput` (`engine.ts:437`) does the opposite, and its comment says so explicitly:
_"On success returns the PARSED value"_. So the two halves of the same feature behave in
opposite ways, and only one of them is documented as doing so.

This matters because **stripping unknown keys is the default behaviour of Zod, Valibot and
ArkType alike**. A reader who declares an input schema reasonably believes the request is now
shaped by it. It is not — the schema is a gate, not a filter.

Measured: a `query` validator that returned `{ limit: 10 }` still put
`?tenant=globex&limit=10` on the wire, overwriting a `tenant=acme` pinned in the configured
path.

## Minimal reproduction

```ts
const getOrder = stitch({
    url: 'https://api.vendor.test/v1/orders?tenant=acme',
    input: { query: z.object({ limit: z.number() }) }, // strips by default
});

await getOrder({
    query: { limit: 10, tenant: 'globex', include: 'internal_notes' },
});
// wire: /v1/orders?tenant=globex&limit=10&include=internal_notes
// the validator returned { limit: 10 }; nothing used it
```

## Why it is worth more than a doc note

Two properties compound:

1. **A schema constrains one slot.** Declaring `params` does nothing about `query`, so an
   undeclared slot is a full passthrough. That is defensible on its own.
2. **A pinned query parameter is a default, not a pin.** `{ ...predefined, ...input.query }`
   means `?tenant=acme` written into the configured path is overwritable by caller input — and
   in our fixture the vendor duly returned the other tenant's data.

Together, the one mechanism a reader would use to close (2) does not close it, because of (1)
and the discarded parsed value. The natural fix — "declare a strict schema" — silently does
nothing.

This shows up hardest on the MCP surface, where the caller is a model and `run_stitch` forwards
its argument object, but nothing about it is MCP-specific: it is true of every call.

## The ask

Use the parsed value, as `validateOutput` already does:

```ts
(input as Record<string, unknown>)[part] = r.value;
```

If that is too breaking, then either:

- an opt-in (`input: { strict: true }`), or
- a documented statement, at the `input` reference and in the MCP surface page, that **an input
  schema validates and does not filter**, and that untrusted callers need the input rebuilt
  before the call.

The workaround today is a `Proxy` apply-trap that rebuilds the input from an explicit key list
before the engine sees it. That works and is about 15 lines, but every user exposing a stitch to
an untrusted caller has to invent it.

## Related, same area

`describe_stitch` reports a declared contract as `"params": true` — a stitch whose `params`
schema is `{ id: <digits> }` tells a model only that the slot exists. A model learns the shape by
failing. Worth surfacing the actual schema if it is JSON-Schema-representable.

---

_Found by an automated scenario pass. Line references verified against `main` at the time of
filing. Runnable proof scripts live under `docs/scenarios/proofs/agent-holds-the-tool/` on the
branch `claude/api-integration-scenarios-436a38`._
