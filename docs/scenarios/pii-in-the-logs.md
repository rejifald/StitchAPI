# Scenario: the customer data you didn't mean to log

**Researched:** 2026-08-05 · **Status:** ✅ verified (8 claims, 196 checks, offline) · page shipped
**Slug:** `pii-in-the-logs`

---

## The use case

You integrate a vendor API that returns customer records — names, emails, addresses, partial card
numbers, health or legal detail. You add tracing, because you are responsible about observability.

Six months later someone greps your log aggregator and finds all of it, in plain text, replicated
across three regions and a backup retention policy you do not control.

## Why it is not straightforward

The generic advice is easy to state and hard to execute: _"never store raw PII in logs; use
hashed or tokenized values."_ The difficulty is that the leak is **structural**, not a mistake
anyone made:

- **Nobody logs PII on purpose. Middleware does.** The two named causes in the field are a debug
  endpoint returning full user objects and _"a logging middleware that captures raw request
  bodies."_ The second is exactly what a well-instrumented client library is.
- **You cannot enumerate what is sensitive in advance.** A denylist of field names
  (`email`, `ssn`) misses `contact`, `primaryEmail`, `user.profile.mail`, and anything nested
  inside a free-text field. An allowlist inverts the problem correctly — and requires knowing
  the whole response shape, which is the thing that changes.
- **The vendor adds a field and it starts flowing.** This is the property that makes it a
  _drift_ problem, not a configuration problem. A response gains `taxId` in a minor release and
  a denylist that was complete yesterday is silently incomplete today.
- **Every hop wants a copy.** The observability chain — traces, spans, error trackers, retry
  logs, cache entries — _"none of these hops include a PII filter by default."_
- **The regulation is about defaults.** GDPR Article 25 mandates data protection **by design and
  by default**, so "we can turn redaction on" is not the same as compliant.

## Evidence this bites real projects

- **The named mechanism** — [Why PII leakage happens in APIs](https://hoop.dev/blog/why-pii-leakage-happens-in-apis/):
  logging middleware capturing raw request bodies is one of the two most common causes.
- **Every hop, no filter** — [Is your AI agent leaking PII through LLM APIs?](https://airblackbox.ai/blog/ai-agent-pii-leaking):
  LLM providers, vector DBs, logging systems, audit trails and dashboards, none filtering by
  default.
- **Traces specifically** — [PII protection at the gateway](https://zuplo.com/learning-center/pii-protection-ai-apis-gateway):
  debug logs and traces capture secrets unless scrubbed, and are an overlooked but rich target.
- **Log the detection, not the data** — the same source: record what was detected, when, on which
  route, for which consumer, **without** putting the PII in the log that records it.

## The common solutions, and what each costs

| Approach                        | What it is                        | Where it breaks                                                                               |
| ------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| **Denylist of field names**     | Scrub `email`, `ssn`, `card`.     | Misses renamed, nested and free-text fields. Silently incomplete the day the vendor adds one. |
| **Allowlist of safe fields**    | Log only what you named.          | Correct by construction, and needs the whole response shape — the thing that drifts.          |
| **Don't log bodies at all**     | Metadata only.                    | Safe and often unusable: the body is what you need when debugging an integration.             |
| **Scrub at the log aggregator** | Filter on ingest.                 | The data already left your process and crossed a network. Too late for a cross-border flow.   |
| **Gateway/sidecar redaction**   | Strip in a proxy.                 | Another hop, and it cannot see which field is sensitive in _your_ domain.                     |
| **Tokenize before storing**     | Replace with a reversible handle. | The right answer for data you keep. Heavy for a log line.                                     |

**Summary of the state of the art:** redact at the boundary, before the value is copied anywhere,
and prefer an allowlist — because the failure mode you cannot test for is the field that did not
exist when you wrote the list.

---

## What to verify against StitchAPI

The library has real redaction machinery, and read of the working tree suggests it points at
**config**, not at **response data**:

- `redactConfig` and a per-slot drop-list (`config-anatomy.ts:50-62`) keep live handles and
  secrets off `__config`.
- **Auth secrets are explicitly protected in traces** — `auth.ts:265` notes an OAuth key is
  redacted from a sink's `url.full` and structured `input.query` "like `api_key`/… are".
- **ADR 0018 adds `redact` to `.inspect()` — and it is opt-in.** The ADR's own title is
  _"an **opt-in** `redact` option for `raw`"_.

So the hypothesis to test is a clean split: **credentials are protected by default; customer PII
is not.** If that holds, the library is safe against the leak it was designed for and open to the
one the regulation is about.

**And there is a pre-registered suspicion.** [Scenario 18](agent-holds-the-tool.md) measured that
`sensitive: true` is a **cache** opt-out (`types.ts:1652-1658`) — a stitch carrying it was still
listed and still ran over MCP. It is also, by a distance, the nearest-looking key in the whole
config to "do not log this". Whether anything in the logging path reads it is worth settling
deliberately rather than assuming.

**Claims to test with runnable offline code:**

1. **C1** — **DECIDING CLAIM.** Where does a response body actually go by default? Enumerate
   every destination: the event spine, a `TraceSink`, `.inspect().raw`, `.report()`,
   `StitchError.body`, error messages, and a `cache` entry. For each: full body, redacted, or
   absent? Use a payload with a name, an email, an SSN and a nested `profile.contact.mail`.
2. **C2** — **DECIDING CLAIM.** Does `sensitive: true` affect logging **at all**? Test it against
   every destination from C1. If it only gates the cache, measure that and say so plainly.
3. **C3** — what does `.inspect({ redact })` actually redact (ADR 0018)? Nested fields? Renamed
   ones? Array elements? Is it a denylist, an allowlist, or a shape?
4. **C4** — is the credential half genuinely safe? Put a bearer token, an `apiKey` in a query
   string and a cookie through every C1 destination and scan for the literal values.
5. **C5** — can PII be stripped **at the boundary**, before anything copies it? Which seam runs
   earliest — `Surface.interpret`, `transform`, `hooks.onResponse`? Does a value stripped there
   stay out of the trace sink and the cache?
6. **C6** — is an **allowlist** expressible? Does an `output` schema that strips unknown keys
   keep them out of the log? (Note scenario 20 measured `output` DOES use its parsed value,
   unlike `input` — so this may work where the input side does not.)
7. **C7** — the drift angle: when a vendor **adds** a PII field, does anything notice? `drift()`
   reports `undeclared` keys — is that a usable "new field appeared, check it" signal?
8. **C8** — assemble the best available "no customer data reaches a log" setup; report seams and
   line count, and state what it costs.

C1 and C2 decide this. C1 establishes the exposure; C2 settles whether the most plausibly-named
key does anything about it.

---

## Verification result

**All 8 claims verified**, 196 checks across 8 scripts, re-run by me before writing up.

| Claim                             | Verdict                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| C1 — where does the body go?      | **CONFIRMED, and binary** — 13 destinations carry all 7 sentinels, 11 carry 0, nothing between       |
| C2 — does `sensitive: true` help? | **CONFIRMED** — 1 of 11 destinations (the cache); exactly **one** read in all of `packages/core/src` |
| C3 — `.inspect({ redact })`       | Opt-in, name-based denylist over `raw` only; `redact: true` removes **0 of 7**                       |
| C4 — credentials safe?            | **PARTIALLY REFUTED** — see below                                                                    |
| C5 — boundary                     | `hooks.onResponse` is the earliest seam, and the **only** one covering the failure path              |
| C6 — allowlist                    | **CONFIRMED** — `output` filters 7 → 0 without naming a single PII field                             |
| C7 — drift as a signal            | **CONFIRMED**, and it **refutes ADR 0018 §4**                                                        |
| C8 — assembled                    | 42 lines, 2 seams, 0 of 9 on both paths                                                              |

### Hypotheses that were wrong

**My clean split was too clean.** I predicted "credentials are protected by default; customer PII
is not." The real line is **credentials the library _places_ vs credentials that ride the
payload**. A declarative `bearer`/`apiKey` never enters the event stream at all — 0 of 3 even for
a naive custom sink — but an `access_token` in a **response body** goes 3 of 3 into the JSONL,
because that sink's redactor is a header denylist rather than the deep scrubber sitting in the
same file.

**And the measurements refuted a shipped ADR.** ADR 0018 §4 says findings never leak a secret,
justified by `detailFor` emitting kinds only. That is true of the three soft drift kinds and
false of hard validation: `validationErrors` (`drift.ts:50-56`) copies the validator's message
verbatim, and Zod's enum message quotes the received value. It reaches the two sinks that are
otherwise 0 of 7.

### What I got right, for once

The pre-registered suspicion carried from [scenario 18](agent-holds-the-tool.md) held exactly:
`sensitive: true` is a cache opt-out and nothing else, and the source agrees — one read, at
`engine.ts:1022`.

### Outputs

- Page: [pii-in-the-logs.mdx](../../apps/docs/content/docs/scenarios/pii-in-the-logs.mdx)
- Draft (**held back, security-sensitive**):
  [adr-0018-findings-can-leak-a-value](issue-drafts/adr-0018-findings-can-leak-a-value.md)
