# ADR 0018 §4 is false for hard validation, and the disk sink skips its own deep scrubber

**Status:** drafted, **HELD BACK — security-sensitive.** Review before disclosing.
**Scenario:** [pii-in-the-logs](../pii-in-the-logs.md)
**Proofs:** `docs/scenarios/proofs/pii-in-the-logs/` (8 scripts, 206 checks, offline)

> Held per the standing instruction not to file drafts that disclose a data-exposure path. Both
> findings below are sensitive-data-in-logs (CWE-532 shape). The third section is ordinary and
> could be split out and filed on its own.

> **Status note, 2026-08-15 re-measure.** §1's worked repro rested on Zod 3's enum wording, and
> the workspace's Zod 4 bump (#589) retired it: the stock enum message is now
> `Invalid option: expected one of "enterprise"|"free"` — expected options only, never the
> received value — so with stock Zod all four sinks measure clean. The `validationErrors`
> verbatim-copy mechanism (`drift.ts:50-56`) is unchanged, and C7(h) proves a validator whose
> message does echo the input — a custom `refine`/`check` message, or another library's wording —
> still carries the value into the JSONL, `consoleSink` and `loggerSink`. The ask below stands,
> scoped to validators that echo.

## 1. ADR 0018 §4's safety claim does not hold for hard validation

[ADR 0018](../../adr/0018-inspect-raw-redaction.md) line 118 states:

> This is safe because `detailFor` emits **kinds only, never values** (`string -> number`,
> `undeclared field (string)`) — so `findings` never leak a secret even when `redact` is off.

The reasoning is sound for `detailFor`, which handles the three **soft** drift kinds. But
`detailFor` is not the only producer of findings. `validationErrors`
(`packages/core/src/drift.ts:50-56`) handles **hard** validation and copies the validator's own
message verbatim:

```ts
export function validationErrors(issues: Issue[]): DriftFinding[] {
    return issues.map((iss) => ({
        level: 'error',
        path: renderPath(iss.path),
        change: 'invalid',
        detail: iss.message,   // ← the validator's message, unmodified
    }));
```

Several validators quote the offending value in that message. Zod's enum message is
`Invalid enum value. Expected 'enterprise' | 'free', received '<the value>'`. So a field whose
value is sensitive, validated against an enum, puts that value into `detail`.

**Measured:** it reaches the JSONL file sink, `consoleSink` **and** `loggerSink` — the two sinks
that carry zero of seven PII sentinels in every other measurement in this scenario. OTLP alone
stays clean, because it exports level/path/change and drops `detail`.

The ADR's claim is scoped to one of two finding producers, and the scoping is not stated.

**Ask:** either make `validationErrors` emit a kind rather than the raw message (it already has
`path` and `change`), or narrow the ADR's claim and say plainly that a hard validation `detail`
carries whatever the validator chose to put in it.

## 2. The disk sink ships a deep scrubber and does not use it

A credential in a **response body** — `access_token`, `refresh_token`, `session_cookie` — is
written to the JSONL log in full (3 of 3 measured). A `client_secret` in a **request body** is
too.

The cause is that the file sink's redactor is a five-name **header** denylist rather than
`isSecretKey`. The same file already contains the deep secret-key scrubber and applies it to a
request body for the `serve` SSE transport (`redactEventForTransport`, `trace.ts:85`) — the disk
sink simply never calls it.

Worth stating alongside: the credential half is otherwise genuinely good. A **declarative**
strategy never enters the event stream at all, because `auth.apply` runs on a request clone
inside the attempt loop while `start` was built from the pre-auth request — 0 of 3 even for a
naive custom sink. Hand-rolled request credentials are scrubbed everywhere. It is specifically
credentials that ride the _payload_ that get PII treatment, which is to say none.

**Ask:** run the body through `redactSecretsDeep` in the disk sink, as the SSE transport path
already does.

## 3. Ordinary findings, no disclosure — splittable

- **`redactHeaders` reaches body keys at any depth**, and its type and JSDoc both say "header
  names". It is the one config-reachable way to point the JSONL redactor at a body key, and
  nothing says so. A body field named `cookie` becomes `[REDACTED]` while the identical value
  under `ssn` does not.
- **Two redaction sentinels in one library** — `REDACTED` (`util.ts`) and `[REDACTED]`
  (`trace.ts`), both appearing in the _same_ JSONL record (`url` vs `input.query`).
- **Two path grammars disagree on arrays.** A drift finding prints `contacts[].email`; pasting
  that into `.inspect({ redact })` matches nothing — only a bare key or a concrete
  `contacts[1].email` works. The two are natural to copy between.
- **`redact` is the second argument**, so `call.inspect({ redact: true })` is a silent no-op (the
  object lands in the `input` slot). TypeScript rejects it, so it is only reachable from JS or
  through a cast — but the no-op spelling is the shorter and more natural one.
- **ADR 0018 §1's `defaultInspect` was never implemented**, so there is no stitch-level or
  process-level way to make every `.inspect()` call redact.
- **`severity: { undeclared: 'error' }` is a compile error and a working runtime kill-switch.**
  `DriftSeverity` excludes `error` and the JSDoc says soft drift is always non-fatal, but through
  a cast it re-levels the finding and fails the call. There is no runtime guard behind the type.
- **`sensitive: true` survives onto the public `__config`**, so `.report()` prints
  `"sensitive":true` beside a record it did not protect — it gates the cache and nothing else
  (one read, `engine.ts:1022`).
- **`drift.ts`'s key walker is 23 lines and not exported.** Anyone stripping PII at
  `hooks.onResponse` _and_ wanting the drift inventory has to re-implement it, because the
  boundary removes exactly the bytes drift diffs.

---

_Found by an automated scenario pass. Line references verified against `main` at the time of
drafting. Runnable proof scripts live under `docs/scenarios/proofs/pii-in-the-logs/` on the
branch `claude/api-integration-scenarios-436a38`._
