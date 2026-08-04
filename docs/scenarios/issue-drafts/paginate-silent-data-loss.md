# Issue draft — `paginate` ends successfully and drops data when a page returns zero items

**Status:** DRAFT — not filed. Raised by the scenario pass on 2026-08-05.
**Scenario:** [`batch-partial-failure`](../batch-partial-failure.md)
**Suggested template:** bug_report.yml · **Suggested labels:** `bug`, `data-loss`, `paginate`

> This is the strongest finding of the scenario pass so far. Unlike the earlier drafts, which
> report footguns, **this one is a plain bug**: a correct-looking `paginate` config loses data
> on an ordinary upstream response and reports success.

Reproduce (all measurements below are from these scripts):

```bash
for f in docs/scenarios/proofs/batch-partial-failure/c[0-9]*.ts; do pnpm exec tsx "$f"; done
```

---

## 1. A zero-item page ends the loop successfully — with the remainder unfetched

**Severity: high — silent data loss.**

`paginated` breaks out of the loop when a page aggregates zero items:

```
engine.ts:984   if (items.length === 0 || page >= max) break
```

The break happens **before `next` is called** (`engine.ts:985-986`), so the loop cannot ask
whether there was more to fetch. The call then resolves through the normal path
(`engine.ts:1005-1010`) with `ok: true` and `error: null`.

That is fine for a cursor API, where an empty page really does mean the end. It is wrong for
any endpoint where an empty page is a **transient** condition. Measured, on a batch-write loop
against a table that is out of write capacity — the single most ordinary response DynamoDB
gives under load — a round landed zero items, the loop stopped, and **4 of 6 rows were never
written. `ok: true`. No error. Nothing in the event stream.**

`items.length === 0` is not the termination contract. `next() === undefined` already is, and
it is the one the docs describe: _"Return `undefined` to stop."_ The zero-item break is a
second, undocumented termination condition that the user cannot override or opt out of.

**Ask:** drop `items.length === 0` as a termination condition and let `next` decide. If it must
stay for compatibility, make it opt-out (`paginate: { stopOnEmpty: false }`).

## 2. "Finished" and "gave up" are the same return value

**Severity: high — an unbounded run looks identical to a complete one.**

Hitting the `pages` cap (default 50) also breaks at `engine.ts:984` and resolves `ok: true`.
So three genuinely different outcomes are indistinguishable to the caller:

- the cursor ran out — complete;
- the page cap was hit — **incomplete**;
- a page landed nothing — **incomplete**.

Measured: cap hit at 3 rounds with a true residue of `def`, and the caller received
`ok: true`, `error: null`, `data: abc`. `.inspect().raw` was `abc`, `.report()` reported no
error and `attempts: 1`, and the event stream's last `paginate` detail was
`page 3 (+1, total 3)` — accurate, and no help. A `trace` sink carried nothing either.

**Ask:** put the stop reason on the result and in `.report()` — `'exhausted' | 'page-cap' |
'empty-page'`. A caller cannot currently write a correct completeness check at all.

## 3. A residue ledger built in `paginate.next` is stale by one round — and names the wrong items

**Severity: medium — it typechecks, reads correctly, and is wrong.**

Because `next` is only invoked when the loop _continues_, it never sees the final page. A user
tracking "what is still outstanding" inside `next` — the obvious place — is always one round
behind.

Measured: with a true residue of `def`, the ledger built in `next` reported **`cdef`**. It
names row `c`, which **had already landed**. Acting on that ledger re-writes `c`.

Only a `hooks.onResponse` closure reported the residue correctly (3 calls, correct answer), or
reconstructing it as a set-difference from the aggregated successes.

**Ask:** call `next` on the terminal round too (with a flag), or add
`onStop(prevBody, reason)`. Either gives the user one correct place to read the tail state.

---

## Why this cluster matters together

Individually each is arguable. Together they mean **a `paginate` user cannot detect an
incomplete run**: the result says success, the error is null, the events look normal, the
report is clean, and the one place they'd naturally track progress lies to them. The Logstash
bug this scenario is drawn from
([`elastic/logstash#1631`](https://github.com/elastic/logstash/issues/1631)) is exactly this
shape, and it took a long time to find precisely because nothing reported it.

The scenario itself came out **achievable** on a different seam (`Surface.interpret` +
`hooks.onRequest`, ~50 lines — see the published page), so this is not a gap in what the
library can do. It is that the primitive that _looks_ like the answer fails quietly.

## Smaller notes from the same verification

- **`verdict: { flag: 'UnprocessedItems' }`** reads as "fail when there are unprocessed items"
  and is **inert** — arrays are truthy whether empty or not. (Related to the `verdict.flag`
  finding in [`body-verdict-footguns`](body-verdict-footguns.md); same root cause, different
  surface.)
- **A backoff sleep in `onRequest` is invisible to the engine** — 2.5 s of real waiting
  produced 0 `throttled` events and no `waited` in the run report. If user-space waiting is
  the sanctioned pattern for a growing backoff, the engine should account for it.
- **`SurfaceOutcome` has no attempt number** (`surface.ts:61-64`), so a surface that needs to
  know it is on its last round must count its own invocations and keep that count in sync with
  `retry.attempts` by hand — an easy thing to get out of step.
- **`cloneReq` shares `body` by reference** (`engine.ts:261-264`). Mutating `ctx.req.body` in
  place instead of assigning rewrites _the caller's own object_ — measured: a caller passed 6
  items and got their array back holding 2. Worth a line in the hooks guide.
