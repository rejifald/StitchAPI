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

## The seven dimensions

Each dimension has a **rule** (what good looks like), a **tell** (the failure
smell — most are greppable), and an **example** drawn from a real page. An audit
scores a page against all seven.

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
   (dim. 5), and back-references (dim. 6) are mechanical — find them first.
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
-   [ ] Product vocabulary matches `AUTHORING.md` rule 4 exactly.
