# Scenario: the agent chooses the arguments

**Researched:** 2026-08-05 · **Re-verified:** 2026-08-15, post-#663 (C7 e is now a green
regression pin) · **Status:** ✅ verified (8 claims, 181 checks, offline) · page shipped
**Slug:** `agent-holds-the-tool`

---

## The use case

You already call a vendor API from your code. Now an LLM agent needs to call it too — over MCP,
as a tool. The model picks _which_ call and _what arguments_, from a prompt that may contain
text you did not write.

## Why it is not straightforward

**The model is now part of the request path**, and it is the least trustworthy part. Three
hazards, all documented in the wild:

- **The credential must never reach it.** A survey of over **10,000 real MCP servers** found
  credentials, API keys and PII leaking at rates **exceeding 10%**. The standing advice is
  blunt: _"never pass a client token through to upstream APIs."_ A token in a tool schema, an
  argument, a result, or an error message is a token in the model's context — and therefore in
  its output, its logs, and any downstream tool it calls.
- **The arguments are attacker-influenced.** A scan of popular MCP servers found **43% with
  command-injection flaws, 22% allowing path traversal, and 30% exploitable via SSRF**. The
  input schema stops being ergonomics and becomes the security boundary: if the model can name a
  URL, a path, or a header, so can a prompt injection.
- **The loop is the cost.** _"The most common production incident is not a model giving the
  wrong answer; it is an agent that decides to retry, and retry, and retry."_ One agent scanning
  a network reached a **$6,531** bill in days with no hard limits; and a single runaway agent
  exhausts a shared pool, 429-ing every other agent in the fleet.

And the framing problem underneath: an agent tool is an API you are exposing to an untrusted
caller, but it is usually written as if it were an internal function.

## Evidence this bites real projects

- **Credential leak rate** — [Checkmarx, MCP security risks and real incidents](https://checkmarx.com/learn/mcp-security-risks-real-world-incidents-and-security-controls/):
  over 10,000 servers analysed, >10% leaking credentials/keys/PII.
- **The Equixly scan** — 43% command injection, 22% path traversal, 30% SSRF across popular MCP
  servers.
- **Tool poisoning** — a WhatsApp MCP server whose _tool description_ instructed the model to
  exfiltrate message history through a benign-looking call
  ([Unit 42 on MCP attack vectors](https://unit42.paloaltonetworks.com/model-context-protocol-attack-vectors/)).
- **The control list** is consistent across the guidance: allow-list and validate every tool
  input, never forward a client token upstream, block SSRF egress, and require human
  confirmation for anything irreversible
  ([CSA agentic MCP best practices](https://labs.cloudsecurityalliance.org/agentic/agentic-mcp-security-best-practices-v1/)).
- **Runaway cost** — [OpenLegion on agent rate limiting](https://www.openlegion.ai/en/learn/ai-agent-rate-limiting)
  and [the $6,531 case](https://www.nexgismo.com/blog/ai-agent-budget-guards-stop-runaway-api-costs).

## The common solutions, and what each costs

| Approach                            | What it is                                       | Where it breaks                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One MCP server per integration**  | Hand-write a server wrapping the vendor.         | Full control, and you write and secure the auth, validation and limits yourself — which is what the >10% leak rate is measuring.                    |
| **One tool per endpoint**           | Narrow, typed tools the model picks between.     | The safest shape: the schema _is_ the allow-list. Costs a tool definition per endpoint and a lot of context.                                        |
| **One generic "run the call" tool** | The model names the call and passes arguments.   | Compact and far more dangerous: the argument object becomes the attack surface, and it must be constrained by something other than the tool schema. |
| **Gateway in front**                | Policy, quotas and egress rules outside the app. | The enterprise answer. Another hop, and it cannot see intent.                                                                                       |
| **Human confirmation on writes**    | Ask before anything irreversible.                | The one control that survives prompt injection. Needs a place to hook it.                                                                           |
| **Token/cost budgets**              | Cap spend, not just request count.               | Catches the runaway loop that a request-per-minute cap never will.                                                                                  |

**Summary of the state of the art:** never let the credential into the model's context,
constrain the arguments with something the model cannot widen, bound the loop by cost as well as
count, and gate irreversible actions on a human.

---

## What to verify against StitchAPI

"Agent-native" is a headline claim and the MCP surface is the least-tested thing in this pass.
[Scenario 8](webhook-receipt.md) touched `serve` and found it unauthenticated by design; nothing
has yet tested MCP.

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- **The surface exposes three generic tools**, not one per endpoint: `run_stitch`,
  `list_stitches`, `describe_stitch` (`mcp.ts:46,73,85`). `run_stitch` takes
  `{ name, input }`, where `input` is described as _"The stitch input object"_ — a free-form
  object.
- **That makes `input` the security boundary**, and [scenario 10](provider-failover.md) measured
  something directly relevant: `const headers = { ...(cfg.headers ?? {}), ...(input.headers ??
{}) }` (`engine.ts:232`) — **input headers merge _over_ config headers**. If the model's
  argument object reaches that merge unfiltered, a prompt injection can set headers on a call it
  did not author.
- **The capability boundary is the counter-claim.** The docs are emphatic that the caller — _"an
  agent included"_ — receives data and never the credential. This scenario is the sharpest test
  of that sentence there is.
- Scenario 9 measured breakers and throttles are shared unless keyed by hand, which is the
  runaway-containment question in a different suit.

**Claims to test with runnable offline code:**

1. **C1** — **DECIDING CLAIM.** Does the credential reach the model, anywhere? Check the tool
   schema, `list_stitches`, `describe_stitch`, a successful result, an error, and the trace.
   Include a stitch with `auth: bearer(env(...))` and one with a `Cookie` jar.
2. **C2** — **DECIDING CLAIM.** Can the model's `input` redirect or rewrite the call? Try
   `headers`, `query`, `params`, and anything URL-shaped. If a model-supplied `authorization` or
   host reaches the wire, that is SSRF/header-injection through the tool boundary.
3. **C3** — is there an **allow-list**? Can the model run _any_ registered stitch, or only ones
   opted in? What does `list_stitches` disclose — names only, or config?
4. **C4** — **error rendering**: does a failure leak the internal URL, header names, or the
   response body to the model?
5. **C5** — **runaway containment**: do `throttle`/`circuit` apply on the MCP path, and can a
   budget be expressed in anything other than request count?
6. **C6** — is there a **confirmation seam** for an irreversible call, or is every registered
   stitch equally callable?
7. **C7** — **schema quality**: is `input` typed enough for a model to use correctly, and does a
   declared input schema constrain what the model may send?
8. **C8** — assemble the safest available exposure and report the seam and line count.

C1 and C2 decide this. The capability boundary is the product's central promise, and a generic
`run_stitch` tool is exactly the shape that tests whether the promise holds when the caller is
adversarial.

---

## Verification result

**All 8 claims verified**, 181 checks across 8 runnable scripts under
`proofs/agent-holds-the-tool/`, re-run by me before writing anything up.

| Claim                                     | Verdict                                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 — does the credential reach the model? | **HELD.** 34 exchanges, 30 payload scans, 14,529 bytes, 5 held secrets, **zero hits** — including a vendor 401 with a credential-shaped body, and stdio. Controls confirm the wire carried them. |
| C2 — can `input` rewrite the call?        | **Header hypothesis REFUTED**; 5 other levers real                                                                                                                                               |
| C3 — allow-list?                          | The registry object, and it is usable — but `--module` sweeps everything, and a rename bypasses it                                                                                               |
| C4 — error rendering                      | StitchAPI's own errors are terse; **the channel is unfiltered** — one real leak                                                                                                                  |
| C5 — runaway containment                  | `throttle`/`circuit` apply; 1 tool call ≠ 1 request; no cost budget                                                                                                                              |
| C6 — confirmation seam                    | None, either direction. User code can refuse, never ask                                                                                                                                          |
| C7 — schema quality                       | Validated but did not filter — filed as [#648](https://github.com/rejifald/StitchAPI/issues/648), fixed by #663; **a declared slot now filters, an undeclared slot stays passthrough**           |
| C8 — assembled                            | 47 lines, 3 seams                                                                                                                                                                                |

### Hypotheses that were wrong

**The central one.** I predicted `engine.ts:232`'s input-headers-win merge would let a model
forge `authorization` or `host`. It cannot: `sanitizeAgentInput` (`mcp.ts:125-130`) deletes
`input.headers` before the merge unless the stitch declares an `input.headers` schema. Six
model-supplied headers → zero on the wire. The code has an explicit comment saying this is
deliberate defence-in-depth, and it is correct.

That is the second time this pass that reading the source produced a confident, wrong prediction
that running code corrected — see [unstable-pagination](unstable-pagination.md), where I had
offset-drift causation backwards.

**What I under-weighted.** I framed this as a credential question. The credential boundary was
the strongest thing measured; the _argument_ boundary is where everything real lives, and the
sharpest finding — a query parameter pinned in a configured path being merely a default — was
not on my list of claims at all.

### Outputs

- Page: [agent-holds-the-tool.mdx](../../apps/docs/content/docs/scenarios/agent-holds-the-tool.mdx)
- Drafts: [mcp-error-channel-leaks-a-query-credential](issue-drafts/mcp-error-channel-leaks-a-query-credential.md),
  [input-schemas-check-but-never-filter](issue-drafts/input-schemas-check-but-never-filter.md) —
  the latter was filed as [#648](https://github.com/rejifald/StitchAPI/issues/648) and fixed by
  [#663](https://github.com/rejifald/StitchAPI/pull/663); C7 (e) now pins the fixed behaviour
