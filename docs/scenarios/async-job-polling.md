# Scenario: submit, poll, download — the async job triangle

**Researched:** 2026-08-05 · **Status:** VERIFIED — achievable with user code · page shipped
**Slug:** `async-job-polling`

**Verification:** 9 proof scripts, run offline on an injected clock, in
[`proofs/async-job-polling/`](proofs/async-job-polling/). Published page:
[`scenarios/async-job-polling.mdx`](../../apps/docs/content/docs/scenarios/async-job-polling.mdx).
Escalated to a draft: [`issue-drafts/clock-and-diagnostic-side-effects.md`](issue-drafts/clock-and-diagnostic-side-effects.md).

| Claim                               | Verdict                       | Measured                                                                                                                                   |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 — `Location` header → next URL   | reachable                     | `interpret`/`onResponse` get the full response; hook rewrite gave `POST /jobs → 3× GET /jobs/job-1`, 1 submit. Nothing built-in follows it |
| C2 — poll loop as a `Surface`       | PASS                          | 5 polls at exactly 30 s virtual spacing; `Failed` stopped on the first terminal body, 17/20 attempts unspent                               |
| C3 — `Retry-After` on the body path | **nothing honors it**         | server asked 30 s, measured gaps **7 ms**; surface-read works; capped expo fallback 1000/2000/4000/5000/5000                               |
| C4 — `paginate`                     | refuted, worse than predicted | it _does_ loop (default `items` wraps a non-array as one item) — but gaps `0,0,0`, and it cannot fail                                      |
| C5 — one deadline over the triangle | PASS, two routes              | one-stitch + `timeout.total` → 253 ms; three stitches + one `AbortSignal` → 6 polls/virtual hour                                           |
| C6 — `linked` trace chain           | PASS                          | 3 starts, **1 traceId**, 3 spans, each parented to the last; without `run`, 3 traceIds and 0 parents                                       |
| C7 — single-use download            | default is safe               | `retry.on` excludes 404 → `200,404` even at `attempts: 5`; per-stitch split gave 20 poll / 1 download                                      |
| C8 — resumability                   | entirely user-side            | engine writes **0** store keys on submit; hand-rolled resume works, 1 submit total                                                         |
| C9 — assembled                      | PASS                          | 1 submit → 5 polls at server pacing → 1 download; **110 lines vs 49** hand-rolled, byte-identical wire behavior                            |

**Wrong hypotheses, fourth time running.** The capture predicted `paginate` would break
immediately at `items.length === 0` because a job-status body has no items array. False — the
default `items` wraps a non-array body as `[value]`, so it loops cleanly. Its real
disqualification is that it cannot **wait**, and that a paginated poll cannot fail (`Failed`
is aggregated as just another value).

**The finding worth carrying forward** is a genuine design tension, not a gap: **you can have
one deadline over the triangle, or per-hop retry policies, but not both.** Collapsing the
triangle into one stitch buys `timeout.total` and loses the per-hop retry split (the poll's
patience becomes the single-use download's — measured: 8 shared attempts burned on a dead
link) plus concurrency safety. Three stitches under `linked` keep both and replace the
config-level deadline with a caller-owned `AbortSignal`. This is the first scenario in the
pass where the honest answer is "pick which guarantee you want".

---

## The use case

You ask an API to do something slow: a Salesforce Bulk API 2.0 export, a Shopify bulk
operation, a report render, a video transcode, a data extract. The API cannot answer in one
request, so it answers **`202 Accepted`** with a job id and a `Location`, and you come back
later.

This is the [asynchronous request–reply pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply),
and it is one of the three or four shapes every integration eventually meets.

## Why it is not straightforward

It is not one call. It is **three different endpoints and a loop between them**:

1. `POST /jobs` → `202` + `Location: /jobs/{id}` + often `Retry-After`
2. `GET /jobs/{id}` → repeatedly, until `state` reaches a terminal value
3. `GET <resultUrl>` → the payload, frequently a pre-signed URL on a different host

Each step contributes its own difficulty:

- **The next URL comes from the previous response's _header_.** `Location` is not in the
  body. A client that only threads body fields through cannot express step 1 → step 2.
- **Terminal state is in-band, and so is failure.** Salesforce transitions `Open →
UploadComplete → InProgress → JobComplete | Failed | Aborted`, all at HTTP 200. `Failed`
  is a successful HTTP response carrying bad news — the same shape that defeats status-code
  logic in every other scenario in this section.
- **The wait is long and the pacing is the server's.** Jobs run for minutes to hours. Each
  Salesforce batch can take up to 10 minutes. Correct clients poll on `Retry-After` when the
  server sends one, and back off exponentially when it doesn't.
- **The total budget spans the whole triangle, not one call.** "Give up after an hour" is a
  deadline over submit + N polls + download. A per-call timeout cannot express it, and a
  per-attempt one certainly cannot.
- **The result URL expires, and sometimes is single-use.** Pre-signed links have a TTL, and
  in some systems [expire on first successful fetch, 404-ing afterwards](https://community.developers.refinitiv.com/discussion/comment/16277).
  A retry of the _download_ can therefore fail permanently in a way that looks transient.
- **Restart loses the job.** If your process dies mid-poll, the job is still running server-side.
  Re-submitting duplicates hours of work; the correct move is to reattach to the stored id.
  Best-practice writeups say to persist the id — almost no client helps you do it.

## Evidence this bites real projects

- **jsforce** — [`#298`](https://github.com/jsforce/jsforce/issues/298): "How to set
  pollTimeout for Bulk job using alternative api method?" The polling timeout for
  `waitForResults=true` is **hardcoded**; the documented workaround is to set
  `waitForResults=false` and write your own polling loop.
- **go-salesforce** — [`#139`](https://github.com/k-capehart/go-salesforce/issues/139):
  "Feature Request: Make bulk job polling timeout configurable" — larger datasets fail with
  `context deadline exceeded`.
- **salesforcer** — [`#13`](https://github.com/StevenMMortimer/salesforcer/issues/13):
  "Error with Bulk Query After Timeout".
- **Salesforce** — [How bulk queries are processed](https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/asynch_api_bulk_query_processing.htm)
  and [troubleshooting query timeouts](https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/bulk_api_2_0_troubleshoot_query_timeouts.htm).
- **Azure Architecture Center** — [Asynchronous Request-Reply](https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply),
  the canonical description of the pattern.

Note what the three library issues have in common: the poll loop exists inside the SDK, its
timeout is not configurable, and the escape hatch is _"turn the helper off and write the loop
yourself."_ That is this scenario's signature — the helper is either too rigid or absent.

## The common solutions, and what each costs

| Approach                                          | What it is                                            | Where it breaks                                                                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SDK's built-in waiter** (`waitForResults=true`) | The vendor polls for you.                             | Hardcoded timeout (jsforce #298, go-salesforce #139). Fine until your job is big, then unfixable without abandoning the helper.                                       |
| **Hand-rolled `while` + `sleep`**                 | Poll, check state, sleep, repeat.                     | Correct and universal. Outside the HTTP client, so timeout, circuit breaking, and tracing see three unrelated calls rather than one operation.                        |
| **Fixed-interval polling**                        | `setInterval` every 5 s.                              | Hammers the API for hour-long jobs and ignores `Retry-After`. The bill and the rate limit both notice.                                                                |
| **Exponential backoff polling**                   | Double the gap up to a cap.                           | The right default when there's no `Retry-After` — but it must still be capped, or an hour-long job's last gap overshoots the finish by minutes.                       |
| **Webhook instead of polling**                    | Ask the API to call you back.                         | Strictly better where offered. Needs a public endpoint, a receiver, and a fallback poll anyway for missed deliveries — so it is _additional_ work, not a replacement. |
| **Queue + separate worker**                       | Submit, persist the id, poll from a scheduled worker. | The production answer for hour-long jobs, and the only one that survives a restart. Costs infrastructure.                                                             |

**Summary of the state of the art:** persist the job id, poll on the server's own pacing with
a capped backoff, treat in-band `Failed` as a failure, bound the whole triangle with one
deadline, and don't retry a single-use download. Every one of those is a line of code; the
difficulty is that no client models the _operation_, only the three calls.

---

## What to verify against StitchAPI

Read of the working tree before verification — **hypotheses, to be confirmed or refuted by
running code**:

- **There is no poll/until primitive.** Nothing in the config vocabulary waits for a state.
- **The likely seam is scenario 2's:** a custom `Surface` whose `interpret` reads `state` and
  returns `{ ok: false, retry: true, after }` while the job is running, with `retry.attempts`
  as the poll bound. If so, polling is "retry, but the failure is 'not done yet'". Whether
  `after` can come from a `Retry-After` **header** (not just a computed number) is open.
- **`paginate` should fail immediately here**, and for a new reason: scenario 3 measured the
  loop breaking at `items.length === 0` (`engine.ts:984`), and a job-status response has no
  items array at all. Worth confirming — it is the second scenario where `paginate` looks
  loop-shaped and isn't.
- **`linked` (`pipe.ts:357`) chains runs into one trace** — "a sequence of awaits draws one
  trace chain", with ancestors as plain typed variables. That covers _tracing_ the triangle.
  It says nothing about a shared deadline, so the "give up after an hour" budget is probably
  unexpressible.
- **`Location` → next request URL** is the untested mechanic. Can a response header become the
  next call's path/baseUrl through any documented seam?

**Claims to test with runnable offline code:**

1. **C1** — can a `Location` header from the `202` become the next call's URL, without the user
   parsing it by hand outside the library?
2. **C2** — can a custom `Surface` express the poll loop (in-band `InProgress` → wait → poll
   again; `JobComplete` → done; `Failed` → a real failure)? Measure poll count and gaps.
3. **C3** — can the poll wait come from the response's **`Retry-After` header**, and fall back
   to a capped exponential when absent? (`retry.respect` honors it for status-driven retries —
   does anything honor it for a body-driven one?)
4. **C4** — confirm `paginate` cannot express this, and say exactly how it fails.
5. **C5** — is there ONE deadline over submit + polls + download? Try `timeout.total`,
   `linked`, a seam. Measure what each actually bounds.
6. **C6** — does `linked` really produce one trace chain across the three endpoints? Measure
   the events, and whether a failure in the middle is attributable to the operation.
7. **C7** — the download step: can a **single-use / expiring** result URL be fetched without
   `retry` turning a permanent 404 into three?
8. **C8** — resumability: can a stitch reattach to a stored job id and resume polling without
   re-submitting? Or is that entirely user-side?
9. **C9** — assemble the best answer available, run it, report the seam and line count, and
   compare honestly against the hand-rolled `while` loop.

C5 and C8 are the ones most likely to come out negative. A poll loop that cannot express
"give up after an hour" is not a solution to an hour-long job.
