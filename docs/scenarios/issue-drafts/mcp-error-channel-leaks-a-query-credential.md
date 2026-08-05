# MCP: the error channel is an unfiltered pass-through, and two smaller agent-boundary traps

**Status:** drafted, not filed
**Scenario:** [agent-holds-the-tool](../agent-holds-the-tool.md)
**Proofs:** `docs/scenarios/proofs/agent-holds-the-tool/` (8 scripts, 181 checks, offline)

## First, the part that held

Worth stating up front because it is the headline claim and it survived the sharpest test we
could build. Across **34 JSON-RPC exchanges and 30 payload scans (14,529 bytes)** — `initialize`,
`tools/list`, `describe_stitch` on ten stitches, successful calls under `bearer` / `apiKey`
(header, query, cookie) / `cookieSession`, a vendor 401 whose **body held a credential-shaped
string**, a validation failure, an unknown stitch, an unknown tool, a bad JSON-RPC method, and
the same run over stdio — **not one of the five held credentials appeared by value anywhere**.
Controls confirm the wire carried them and the vendor authenticated every call.

`sanitizeAgentInput` (`packages/core/src/mcp.ts:125-130`) is doing real work: six model-supplied
headers including `authorization`, `cookie` and `host` reached the vendor as **zero** headers.
The comment above it is accurate.

The findings below are the edges around that.

## 1. A transport error message reaches the model verbatim

`packages/core/src/mcp.ts:184`:

```ts
} catch (e) {
    return errorResult((e as Error).message);
}
```

StitchAPI's **own** errors are terse and request-free — a vendor 500 whose body held an internal
hostname, a stack frame and a `postgres://vendor:hunter2@…` DSN reached the model as the four
characters `HTTP 500`. That part is good, and deliberate-looking.

But the channel is unfiltered, so anything the **transport** writes passes straight through. On
the **default `fetchAdapter`**, with `apiKey({ in: 'query' })` and a mistyped port, the model
received:

```
Failed to parse URL from http://api.vendor.test:99999/v1/metrics?api_key=ak_live_qry_8899aabbccddeeff
```

With a `node-fetch`-shaped adapter the same thing happens on **any DNS failure** — a routine
production event, not a typo:

```
request to https://api.vendor.test/v1/metrics?api_key=ak_live_… failed, reason: getaddrinfo ENOTFOUND …
```

Zero lines of user code. The control pins the cause: the identical failure under `bearer`
disclosed the URL and no secret.

This is `apiKey({ in: 'query' })` leaking where URLs go, which the auth guide already warns
about. The reason to file it anyway: **the model's context is a uniquely bad destination** — it
flows to the model's output, its logs, and any downstream tool it calls — and it is not a place
a reader thinks of as "where URLs go".

**Ask:** redact the credential from messages crossing the MCP boundary (the auth strategy knows
its own parameter name), or — cheaper — have `describe_stitch`/the MCP docs warn when a
registered stitch uses `apiKey({ in: 'query' })`.

## 2. A renamed stitch is callable but invisible

`selectStitch` falls back from the registry key to each stitch's configured `name`
(`registry.ts:71-74`). So a filtered registry that **renames** a stitch to hide it still answers
to the original name — reachable and absent from `list_stitches` at the same time.

That inverts the one seam the library gives for an allow-list. The registry object handed to
`createMcpServer` is otherwise a genuinely good boundary (we built a working allow-list on it in
47 lines).

Compounding it: the documented starter `stitch mcp --module ./stitches.ts` builds that object
with `collectStitches`, which sweeps up **every exported stitch** — in our fixture a write and a
login stitch alongside the intended read.

**Ask:** resolve MCP tool calls by registry key only, and document that `--module` exposes
everything.

## 3. `cookieSession` joins where `apiKey({ in: 'cookie' })` replaces

Only reachable when the operator declares an `input.headers` schema, so it is the narrowest of
the three — but the outcome is session fixation. Measured:

```
Cookie: tracking=xyz; SESSION=attacker; SESSION=sess_live_cookie_abcdef0123456789
```

The model's pair is sent **first**. A vendor that reads the first occurrence runs the call as the
model's session. `auth.ts:918-921` joins; `auth.ts:228-245` (`apiKey`) replaces.

**Ask:** have `cookieSession.apply` drop a pre-existing pair with the same cookie name, as
`apiKey` does.

## 4. No tool annotations, so a host cannot prompt

All three tool descriptors carry no `annotations`, so `readOnlyHint`/`destructiveHint` — the
fields an MCP host reads to decide whether to ask a human — are absent. And because code-mode
puts every endpoint behind one tool name, reading an order and issuing a 25,000 refund arrive at
the host as the same `run_stitch` call.

`list_stitches` does report `POST /v1/refunds`, but a host would have to call a tool to learn
that, and annotations are fixed at `tools/list` time.

User code can **refuse** — `hooks.onRequest` throwing gave the vendor zero requests, the model a
readable reason, and (nicely) was asked exactly once despite `retry: { attempts: 3 }`, because a
refusal is not a retryable failure. But nothing in the process can **ask**.

**Ask:** emit `annotations` per tool, at minimum `readOnlyHint` on `list_stitches` and
`describe_stitch`.

## Not filed here

`validateInput` discarding its parsed value is the other finding from this scenario and it is
**not MCP-specific** — see the companion issue.

---

_Found by an automated scenario pass. Line references verified against `main` at the time of
filing. Runnable proof scripts live under `docs/scenarios/proofs/agent-holds-the-tool/` on the
branch `claude/api-integration-scenarios-436a38`._
