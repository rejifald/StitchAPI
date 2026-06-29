# The editorial standard for StitchAPI prose

This is the contract for how a docs page _reads_. [`AUTHORING.md`](./AUTHORING.md)
governs the **structure** of a page — which template, which sections, twoslash,
tabs, the manifest. This governs the **prose** that fills it.

The two are orthogonal and both mandatory: a page can pass every structural rule
in `AUTHORING.md` — correct template, green twoslash, valid `See also` — and still
be a bad article, because the sentences hedge, the lede warms up, or a claim is
asserted instead of shown. This file is what catches that.

It is not an aspiration. The voice below is **reverse-engineered from the pages
that already read well** — [`concepts/the-stitch`](./content/docs/concepts/the-stitch.mdx),
[`guides/resilience/retry`](./content/docs/guides/resilience/retry.mdx),
[`integrations/react`](./content/docs/integrations/react.mdx). The job of this
standard is to make that voice repeatable and its absence auditable, so every new
page matches the best existing one instead of regressing to a generic style.

Audience, like `AUTHORING.md`: human writers **and** agents. Each rule is chosen so
a page reads well both rendered in a browser and pulled out of context as
`llms.mdx`.

---

## The eight dimensions

Each dimension has a **rule** (what good looks like), a **tell** (the failure
smell — most are greppable), and an **example** drawn from a real page. An audit
scores a page against all eight.

### 1. The lede earns its place in one sentence

The first sentence states **what this is and when you reach for it** — nothing
before it. It is also the agent's relevance signal in `llms.mdx`, so it cannot
spend a clause warming up.

-   ✅ _"Add `retry` when an API returns transient failures — rate limits and gateway
    hiccups — and you want the stitch to wait and try again instead of surfacing the
    first error."_ (`retry.mdx`)
-   🚩 **Tell:** opens with "In this guide…", "This page covers…", "StitchAPI
    provides…", or a bare definition with no _when_. Grep: `^In this`, `^This (page|guide|section)`, `provides a way to`.

### 2. Economy — every sentence is load-bearing

Long sentences are allowed when each clause adds information; the page above runs
forty-word sentences that all carry weight. What is not allowed is filler — words
that survive their own deletion.

-   🚩 **Tell — delete-on-sight words:** _simply, just (as a softener), basically,
    in order to (→ "to"), it's worth noting, of course, note that, actually, very,
    really, powerful, robust, seamless, easily, leverage, utilize (→ "use")._
-   🚩 **Tell:** a sentence whose removal changes nothing. If you can cut it and the
    reader loses no fact, cut it.

### 3. Show the mechanism, not the adjective

A claim is demonstrated by naming the behavior, never asserted with a praise word.
"Resilient" is earned by writing _retry, timeout, circuit breaker_ next to it — or
it is not earned at all.

-   ✅ _"`fetch` hands back opaque bytes."_ — the weakness is the mechanism, not an
    adjective.
-   🚩 **Tell:** _powerful / elegant / intuitive / blazing-fast / first-class /
    best-in-class_ with no `code` or concrete behavior in the same sentence.

### 4. Define by contrast — "X, not Y"

The strongest explanations on the site fix a concept by saying what it is _instead
of_. Use a bold parallel lead-in for a run of such claims.

-   ✅ _"**Declarative, not an imperative wrapper.** … **Atomic, not spec-first.** …
    **One primitive, two facades.**"_ (`the-stitch.mdx`)
-   🚩 **Tell:** a feature list with no foil — the reader is told what it does but
    never what it replaces or refuses to be.

### 5. Concrete subject, active verb

A named actor does the thing. "The engine decides how to carry it out," not "it is
decided how the call should be carried out." Prefer verbs over nominalizations.

-   🚩 **Tell:** agentless passive — _is provided, is handled, can be configured, is
    performed_ — with no actor. Nominalizations: _the configuration of, the
    validation of, the resolution of_ (→ "configuring", "validating", "resolving").

### 6. Cohesion without back-reference

Each paragraph follows from the last _within the page_, but the page never leans on
its own position in the sidebar. No "as we saw above" — restate the one-line premise
in a clause and link. This is the prose face of `AUTHORING.md` rule 5
(self-contained pages): the page must read standalone as `llms.mdx`.

-   🚩 **Tell:** _as we saw, as mentioned, recall that, continuing from, in the
    previous section, above/below_ (as a content reference). Grep: `as (we saw|mentioned)`, `previous (section|page)`, `recall that`.

### 7. Second person, purposeful

"You" addresses the reader's task. Avoid "we" for the authors and avoid the
product speaking in the first person; say what _you_ (the reader) get or do, and
use the imperative for steps.

-   ✅ _"you narrow or widen it per stitch."_ (`retry.mdx`)
-   🚩 **Tell:** _we recommend, we built, we think, our library, let's_ — replace
    with the reader's action or the plain fact.

### 8. Don't show the reader the door — frame the on-ramp, not the upsell

A how-to page that ends by listing when _not_ to reach for a stitch sends the
reader away at the moment they were ready to try it. The stitch is the on-ramp: it
scales **down** to the same one line the bare primitive needs and **up** without a
rewrite. Make the contrast directional — the bare tool bounds the call you have; the
stitch bounds it just as simply and is ready for the call it becomes.

-   ✅ _"A stitch scales down to the same one line — `timeout: '3s'`. The inline
    `AbortSignal` answers one question and stops there; the stitch is that same call
    today and one edit from retry, auth, or a validator tomorrow."_ (`fetch-timeout-typescript`)
-   🚩 **Tell:** a closing section titled "When the plain X is enough" / "When the
    hand-rolled … is enough", or a sentence that waves the reader off — _stop here,
    you don't need a stitch, more setup, the inline … is leaner, the loop is the leaner
    choice, overkill, dead weight, keep them._ Grep: `## When .* is enough`, `stop here`, `\bleaner\b`, `more setup`, `overkill`, `you don'?t need`, `needs none of that`.

**Honesty guardrail — this never licenses a false claim (see `blocker`).** Where the
bare tool is genuinely the better fit _today_, say so — but as a **trigger**, not a
dismissal. Convert "you don't need a stitch" into "here's the moment you reach for
one" by naming the condition that flips the decision: a second call site, a retry, an
auth boundary, a schema you'll reuse. Never claim the stitch is lighter when it is
not — a stitch with no `output` validator really is "a fetch wrapper with extra
steps," and the page must keep saying so. The move from bare tool to stitch is a
field on a declaration, not a rewrite; say that instead of conceding the case.

**Comparison ("X vs Y") posts are the exception.** A piece whose job is to weigh the
stitch against codegen, axios, or a workflow platform earns its authority by naming,
plainly, the lane where the _other_ tool wins — that is dimension 4 doing its job, and
deleting it turns an honest comparison into an advertisement nobody trusts. Keep the
concession; reframe only the dead-end phrasing (_"stitching isn't worth it"_ →
_"when you'd graduate to a stitch"_).

---

## A note on terminology (shared with `AUTHORING.md`)

`AUTHORING.md` rule 4 already fixes the product vocabulary — "stitch" lowercase,
"capability, not credential", "the event stream", never "SDK"/"client"/"endpoint
wrapper". That rule is **load-bearing for prose too**: an audit treats a vocabulary
slip (calling a stitch a "client") as a dimension-3 failure, because the wrong noun
asserts the wrong mental model. Don't re-litigate the vocabulary here — enforce it.

For **Ukrainian and other localized prose**, terminology is a different and larger
problem (transliterate vs. translate vs. keep-in-English), governed by its own
standard. This file is English-prose only.

---

## How to audit a page

1. **Read it once as a reader**, top to bottom, as if it were the only page you
   found. Does the lede tell you what and when (dim. 1)? Did anything make you
   re-read (dim. 6)?
2. **Grep the tells.** The delete-on-sight list (dim. 2), agentless passive
   (dim. 5), back-references (dim. 6), and door-closing closers (dim. 8 —
   `## When .* is enough`, `stop here`, `leaner`, `overkill`) are mechanical —
   find them first.
3. **Score each dimension** and record findings as
   `file:line · dimension · severity · the rewrite`. A finding is not a flag; it
   is the replacement sentence.

### Severity

-   **`blocker`** — the prose states something false or contradicts the code/example
    on the page. Fix before anything else; this is also a correctness bug.
-   **`major`** — violates dimensions 1–4. The reader is slowed or misled: a lede
    that buries the _when_, a claim asserted not shown, filler thick enough to
    obscure the point.
-   **`minor`** — violates dimensions 5–7. Polish: a passive that wants an actor, a
    stray "we", an avoidable back-reference.

A page is **done** when it has no `blocker` or `major` findings and reads, start to
finish, like the exemplar pages this standard was drawn from.

---

## Definition of done (per page, prose)

-   [ ] Lede states what + when in the first sentence; no warm-up (dim. 1).
-   [ ] No delete-on-sight filler; every sentence is load-bearing (dim. 2).
-   [ ] Every quality claim is shown by a named mechanism, not an adjective (dim. 3).
-   [ ] Key concepts are framed "X, not Y" where a foil exists (dim. 4).
-   [ ] No agentless passive or nominalization where an actor + verb fits (dim. 5).
-   [ ] No back-reference to other pages' position; reads standalone (dim. 6).
-   [ ] Second person for the reader; no authorial "we" (dim. 7).
-   [ ] No door-closing closer; the bare tool is framed as the on-ramp's first
        step, concessions read as graduation triggers, not dismissals (dim. 8).
-   [ ] Product vocabulary matches `AUTHORING.md` rule 4 exactly.
