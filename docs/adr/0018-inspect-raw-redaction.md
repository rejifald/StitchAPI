# ADR 0018 — `.inspect()`: an opt-in `redact` option for `raw`

-   **Status:** Accepted (designed 2026-06-28; implemented in this PR; refines [ADR 0016](./0016-inspect-raw-and-findings.md), merged in [#334](https://github.com/rejifald/StitchAPI/pull/334)). One of the four items ADR 0016 deferred.
-   **Date:** 2026-06-28
-   **Tags:** inspect, security, redaction, privacy, opt-in

> [!NOTE]
>
> Numbering continues past 0016 (PR #334) and 0013/0014 (#328), both in flight.
> Renumber at PR time if a lower number lands first — as 0015/0016 did.

> [!IMPORTANT]
>
> **Depends on [ADR 0016](./0016-inspect-raw-and-findings.md)** (`.inspect()` and
> the `Inspection<T>.raw` field), which must land first (PR #334). 0016 ships
> `raw` **unredacted-but-non-enumerable** and flags the redaction option as future
> work: "revisit with a `redact` option if an incident or demand justifies it."
> This is that option.

## Context

0016 §5 makes `raw` the **unredacted** pre-validation body on a **non-enumerable**
field. Non-enumerability closes _accidental_ leakage (`JSON.stringify`, spread,
trace-walkers all skip it); the unredactedness is deliberate, because `raw` is
**the one tool meant to catch a stray token or PII in an _undeclared_ field** —
redact it and you blind exactly the thing it exists to surface.

The demand is the deliberate-sharing case: a consumer who _wants_ to pipe
`wrapper.raw` into a log line, a bug report, or a support ticket and needs the
known-secret fields scrubbed first. The tension is real and names the whole
design constraint: **redaction must serve safe sharing without ever becoming a
false safety net that re-blinds the catch-a-stray-token tool.**

## Decision

Add an **opt-in, per-call** `redact` option to `.inspect()`. Default **off**.

```ts
interface InspectOptions {
    cache?: boolean; // (ADR 0016)
    redact?: boolean | string[]; // NEW — default false
}
```

### 1. Where the config lives — per-call, on `InspectOptions`

`.inspect()` is _already_ a deliberate, per-call probe ("reach for `wrapper.raw`
deliberately"). Redaction is a property of **this inspection's output handling**
— the consumer who forwards `raw` to a log is at the call site — not of the
stitch's identity. So `redact` rides `InspectOptions`, beside `cache`.

A stitch-level default is permitted as a secondary convenience (`drift`-config or
a `defaultInspect` block), but the per-call option always overrides, and the
default **everywhere** is off. We deliberately do **not** offer a process-wide
"redact all `.inspect()`" toggle: that is precisely the silent-blinding footgun
(someone flips it "for safety" and every probe in the codebase goes blind to the
stray-token case). Per-call keeps any blinding **local and visible**.

### 2. What the policy reuses — the existing secret-key denylist

Redaction reuses the curated trace-redaction denylist already in
[`util.ts`](../../packages/core/src/util.ts) — the `SECRET_QUERY_KEYS` /
`SECRET_QUERY_STEMS` predicate (`isSecretQueryKey`) plus any caller
`registerSecretQueryKey` registrations — rather than inventing a parallel list
that would drift out of sync. A credential param name registered for URL
scrubbing is then also caught when it echoes in a response body.

The denylist is **query-key-named** today; the body case needs the same matcher
under a body-neutral name:

-   Promote the predicate to **`isSecretKey(name)`** in `util.ts`, keeping
    `isSecretQueryKey` as an alias (the URL scrubbers keep their name).
-   Add **`redactSecretsDeep(value, extra?)`** in `util.ts`: walk a plain value,
    replace any object key matching `isSecretKey` (or the caller's `extra`
    name/path patterns via the existing `matchPath`) with the existing
    `URL_REDACTED = 'REDACTED'` sentinel. Returns a **deep clone** — never mutate
    the engine's retained body.

`redact: true` uses the shared denylist; `redact: string[]` adds extra key
names / paths (reusing `matchPath`'s prefix/`*` grammar) on top of it.

### 3. Name-based only — a sharing convenience, _not_ a leak guarantee

Redaction here is **name-based**: it scrubs fields whose _key_ is known-secret. It
deliberately does **not** attempt value-shape (regex JWT/bearer/PII) redaction.
This is the crux:

-   A name-based redactor **cannot** catch a token sitting in an innocently-named,
    undeclared field — and that is **exactly the case `.inspect()` exists to let a
    human find.** So redaction is scoped honestly as "scrub the fields I already
    know are secret-named, so I can share the rest," **not** as a guarantee that
    `raw` is now leak-free.
-   That scoping _is the argument for opt-in._ An opt-in convenience cannot lull
    you. An on-by-default "safety" net would: you'd believe `raw` is safe to log
    while the dangerous case (token in a field not named like a secret) slips
    through unredacted. **The default protection is non-enumerability** (accidental
    leakage); `redact` is the deliberate-sharing escape hatch layered on top.

### 4. Findings are computed before redaction

The soft/hard diff runs on the **unredacted** body (findings need real values to
classify), then `raw` is redacted for the result object. This is safe because
`detailFor` emits **kinds only, never values** (`string -> number`,
`undeclared field (string)`) — so `findings` never leak a secret even when
`redact` is off. When `redact` is set, `.inspect()` places the **redacted clone**
on `wrapper.raw` and drops the unredacted body (otherwise redaction is pointless);
`source`/`status`/`findings` are unaffected.

## Alternatives considered

-   **Redact by default (opt-out).** Rejected: inverts the tool's purpose, creates
    false confidence, and a name-based redactor can't catch the stray-token case
    anyway — so a default-on net protects least where it matters most.
-   **A new, body-specific secret denylist.** Rejected: duplicates the curated
    `isSecretKey` list, would drift, and caller `registerSecretQueryKey`
    registrations wouldn't carry over.
-   **Value-shape (regex) redaction.** Rejected for v1: heuristic, false-positive
    prone, and still cannot guarantee catching the field manual inspection exists
    for. Could be a future additive `redact` mode if demand appears.
-   **Process-wide / global redaction default.** Rejected as a mechanism: the
    silent-blinding footgun. Allowed only as an explicit stitch-level default that
    the per-call option overrides.
-   **Redact in place on the retained body.** Rejected: corrupts the engine's
    pristine `RAW_BODY`; redaction returns a clone.

## Consequences

-   `.inspect()` gains one optional `redact`; the default path is byte-identical
    to 0016 (unredacted, non-enumerable).
-   **No engine change.** Redaction lives entirely at the `.inspect()` assembly
    site in `stitch.ts`; the engine keeps retaining the pristine body on
    `RAW_BODY` (contrast 0016, which _did_ need the `RAW_BODY`/`ERROR_SOURCE`
    engine plumbing).
-   `util.ts` gains a reusable `redactSecretsDeep` + the `isSecretKey` rename;
    the URL scrubbers are unchanged behind the alias.

## Engine / type touch-points

-   [`types.ts`](../../packages/core/src/types.ts) — `InspectOptions`: add
    `redact?: boolean | string[]`. Update the `Inspection.raw` JSDoc to mention
    the escape hatch.
-   [`util.ts`](../../packages/core/src/util.ts) — rename the predicate to
    `isSecretKey` (alias `isSecretQueryKey`); add `redactSecretsDeep(value, extra?)`
    reusing it + `URL_REDACTED`.
-   [`stitch.ts`](../../packages/core/src/stitch.ts) — the `.inspect()` consumer:
    after recovering `raw` (`RAW_BODY`) and computing `findings`, if `redact` is
    set, place `redactSecretsDeep(...)` on `wrapper.raw` instead of the raw body.
-   `engine.ts` — **no change.**

## Relationship to the other 0016 deferrals

Stands **alone**. It is a focused security toggle on an _existing_ 0016 field,
distinct from ADR 0019's _new_ result surface. Note the interaction: ADR 0019's
`RunReport<T> extends Inspection<T>` inherits `raw`, so `redact` (and
non-enumerability) cover the report's `raw` too; ADR 0019's _config echo_ uses a
**separate** redaction path (the already-redacted `__config`, never
`__rawConfig`) — these are two different mechanisms for two different surfaces.
