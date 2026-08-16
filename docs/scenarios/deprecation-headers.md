# Scenario: the vendor told you for six months, in a header

**Researched:** 2026-08-05 · **Status:** VERIFIED — achievable with user code · page shipped
**Slug:** `deprecation-headers`

**Verification:** 8 proof scripts (178 checks), run offline, in
[`proofs/deprecation-headers/`](proofs/deprecation-headers/). Published page:
[`scenarios/deprecation-headers.mdx`](../../apps/docs/content/docs/scenarios/deprecation-headers.mdx).
Escalated: [`issue-drafts/hooks-can-rewrite-the-call.md`](issue-drafts/hooks-can-rewrite-the-call.md).

| Claim                            | Verdict                                 | Measured                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 — where are headers reachable | **definitive: exactly 3 places**        | `adapter`, `hooks.onResponse`, `Surface.interpret`. 11 accessors carry none — including the **whole event spine** (4 events, 15 keys, zero headers)                                                |
| C2 — `hooks.onResponse`          | sees them, **and can rewrite the call** | return value ignored, but `ctx.res` is live: mutating `status` turned a 200 into a thrown 503. Fires 3× for 1 retried call                                                                         |
| C3 — a levelled finding          | one narrow door                         | fold into the value → `info \| undeclared`, non-fatal, re-levellable — but carries neither the value nor the endpoint                                                                              |
| C4 — fleet aggregation           | works; the scenario-12 shape transfers  | 500 calls / 5 endpoints → _"3 endpoints deprecated … earliest sunset in 12 days: users"_, unchanged at 200:1 skew. But no event carries a header, so the sink saw `null` until a surface folded it |
| C5 — the tripwire                | PASS, elegant                           | `[sunset−1ms, sunset, +1ms]` → `["ok","FAILED","FAILED"]`; burns **no** retry attempts and does **not** open the breaker                                                                           |
| C6 — both formats                | no help reachable                       | `parseRetryAfter` is _identical_ to the requirement and unexported; `Date.parse("@1735689600")` is **NaN**                                                                                         |
| C7 — noise                       | one line per call                       | 600 calls → **360 lines / 3 facts**; `loggerSink` 2400. `levelOf` reaches 600, cannot reach 3                                                                                                      |
| C8 — assembled                   | PASS                                    | **132 lines vs 81** — the first scenario where the line count goes against the library                                                                                                             |

**A claimed correction that does not survive checking.** The verification reported that
scenarios 6, 7 and 15 "generalised one step too far" about headers. Checked against what
actually shipped, they did not: the multipart page says headers are absent from `.inspect()`
"**so without a surface** the ETag is unrecoverable", the unconfirmed-write page scopes it to
`StitchError`, and the 304 page's own solution _uses_ `Surface.execute`. The issue drafts are
scoped the same way. Nothing was corrected; the accessor table is a **consolidation**, not a
retraction — the first place all eight rows are stated together.

**The genuinely new thing** is the last row: **no event carries a header**, which is why a
`TraceSink` can only aggregate what a `Surface` folded into the value. That explains the shape
of the answer here and is worth stating next to the trace docs.

---

## The use case

A vendor is retiring the endpoint you depend on. They announced it in a blog post, sent one
email, and — if they follow the standards — they have been telling you **on every single
response** for six months, in a `Deprecation` and `Sunset` header.

Then the endpoint goes away and your integration breaks on a Tuesday.

## Why it is not straightforward

**The signal arrives on responses that succeeded.** Not on an error, not on a 4xx — on the
`200`s you have been happily consuming all along. So every mechanism a client has for noticing
trouble is pointed the wrong way: nothing failed, nothing retried, no status changed.

As one write-up puts it: _"The clients that broke never read the blog post — but their code
reads your HTTP responses on every single request."_

Then the specifics:

- **Two headers, two formats.** `Deprecation` (RFC 9745) is a structured-field date —
  `@1735689600`. `Sunset` (RFC 8594) is an HTTP-date — `Wed, 01 Jan 2026 00:00:00 GMT`. A client
  that parses one and not the other gets half the picture.
- **It is a hint, not a guarantee.** RFC 9745 is explicit: the resource _indicates_, without
  guaranteeing, that it will be deprecated. So failing the call is wrong; ignoring it is also
  wrong.
- **The useful unit is the fleet, not the call.** "This endpoint is deprecated" is not
  interesting once — it is interesting as _which of my forty stitches are deprecated, and which
  sunset first_. That needs aggregation across calls, not a per-call log line.
- **The window closes silently.** Between the announcement and the sunset, everything works. The
  only thing that changes is the date getting closer, which no runtime notices.
- **Adoption is circular.** The standards are new and under-used _"partly because the value of
  the headers is not visible until well-instrumented client libraries notice them."_ A client
  that surfaces them is the thing that makes vendors bother to send them.

## Evidence this bites real projects

- **RFC 9745** (`Deprecation`) and **RFC 8594** (`Sunset`) define the mechanism, and RFC 9745
  states plainly that a client not interpreting `Sunset` _"can operate as usual and simply may
  experience the resource becoming unavailable without recognizing any notification."_
- **The adoption problem is documented as circular** — the headers are under-used until clients
  read them ([Zuplo](https://zuplo.com/learning-center/http-deprecation-header),
  [http.dev on Sunset](https://http.dev/sunset)).
- **The failure shape is a genre** — [most deprecation notices die in a changelog nobody
  reads](https://oneuptime.com/blog/post/2026-01-30-api-deprecation-headers/view), and the
  worked example is stark: _"Day 1: remove /v1/users. Day 1: 47 partner integrations break."_
- **Zalando's API guidelines** mandate the headers precisely because announcements alone don't
  land ([restful-api-guidelines, deprecation](https://github.com/zalando/restful-api-guidelines/blob/main/chapters/deprecation.adoc)).

## The common solutions, and what each costs

| Approach                                     | What it is                                      | Where it breaks                                                                                                 |
| -------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Read the changelog**                       | A human subscribes to the vendor's blog.        | The documented failure mode. Nobody reads it, and nobody re-reads it six months later.                          |
| **Log the header**                           | Print a warning when `Deprecation` appears.     | One line per call in a log nobody greps — noise at request volume, and no sense of _which_ endpoints or _when_. |
| **Fail the call after the sunset date**      | Turn the hint into a hard stop.                 | Wrong for a hint, right for a deadline you chose. Useful as a deliberate tripwire, dangerous as a default.      |
| **Aggregate to a dashboard**                 | Count deprecated endpoints and earliest sunset. | The genuinely useful shape, and it needs somewhere to aggregate — a per-call hook has no memory.                |
| **Contract tests against the vendor's spec** | Notice at build time.                           | Catches a _shipped_ change; a sunset announcement is not in the spec, and the change hasn't shipped yet.        |
| **Gateway/proxy inspection**                 | Let infrastructure watch the headers.           | Works, and only if you have one in the path.                                                                    |

**Summary of the state of the art:** parse both headers, don't fail on a hint, aggregate across
calls so the answer is a _list of endpoints with dates_, and consider a deliberate tripwire when
a sunset you know about arrives.

---

## What to verify against StitchAPI

This scenario is deliberately built on a thread three earlier ones brushed. [Scenario
6](conditional-requests-304.md) measured `Inspection` carrying no headers, so an `ETag` was
unrecoverable without a surface. [Scenario 7](multipart-upload.md) hit the same wall for a
part's `ETag`. [Scenario 15](unconfirmed-write.md) measured `StitchError` having no `headers`,
so a vendor's replay marker was unreachable. **This is the same question in its purest form: a
signal that lives only in a response header, on a call that succeeded.**

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- **Nothing ships for this.** No `Deprecation`/`Sunset` handling is likely to exist anywhere.
  That is fine and expected — the question is whether the _seams_ make it a few lines or a
  rewrite.
- **`hooks.onResponse` sees the headers** — scenario 11 measured it seeing every page of a
  paginated run, read-only. If it can observe but not act, it is the right place for a _report_
  and the wrong place for a _guard_.
- **`TraceSink` is the aggregation seam** — [scenario 12](intermittent-drift.md) measured
  `trace` + `ctx.spanId` being the one place cross-call state is the design rather than a leak,
  and used it to turn per-call drift findings into a rate. The fleet-level question here has
  exactly that shape.
- **Drift has levels and a finding vocabulary.** Whether a header-derived warning can join it —
  or whether findings are strictly schema-derived — decides whether this reports through the
  same channel as everything else or needs its own.

**Claims to test with runnable offline code:**

1. **C1** — is a response header reachable on a **successful awaited** call, at all? Enumerate
   every accessor (`await`, `.safe()`, `.inspect()`, `.report()`, the event stream) and say which
   carry headers.
2. **C2** — `hooks.onResponse`: does it see `Deprecation`/`Sunset` on a 200, and can it do
   anything beyond observe?
3. **C3** — can a header-derived warning become a **finding** in the same channel as drift —
   levelled, non-fatal, naming the endpoint? Or does it need a parallel mechanism?
4. **C4** — **DECIDING CLAIM.** Aggregation. Across 40 stitches and many calls, can a
   `TraceSink` produce _"these 3 endpoints are deprecated, earliest sunset in 12 days"_? Measure
   what identifies the endpoint (`ctx.name`? the URL?) and whether the header reaches the sink.
5. **C5** — the deliberate tripwire: can a call be made to **fail** after a sunset date you
   choose, without failing before it? Measure with an injected clock.
6. **C6** — both formats: RFC 9745 structured-field `@1735689600` and RFC 8594 HTTP-date. Is
   there any parsing help, or is it two hand-rolled parsers? (Scenario 14 found `parseRetryAfter`
   exists but is unexported.)
7. **C7** — noise: at request volume, does the naive approach produce one line per call? Can it
   be de-duplicated per endpoint without hand-rolled state?
8. **C8** — assemble the best available answer — parse both, report as findings, aggregate to a
   fleet view, optional tripwire — and report the seam and line count.

C1 and C4 decide this. If response headers are unreachable on the success path and the sink is
the only aggregation point, then this scenario's answer and its ask are the same as three
earlier ones — which would make it worth consolidating rather than filing a fourth time.
