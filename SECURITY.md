# Security Policy

Thanks for helping keep **StitchAPI** and its users safe. This document explains
which releases receive security fixes, how to report a vulnerability privately,
and what to expect once you do.

`stitchapi` is a client-side runtime library: it composes and runs API calls,
handles credentials (bearer / apiKey / basic / oauth2 / cookieSession), redacts
secrets from traces, generates code from OpenAPI specs, and runs untrusted
snippets in the docs playground sandbox. Those are the areas where a bug is most
likely to have security impact — see [Scope](#scope) below.

## Supported versions

Security fixes are issued against the **most recent published release** of
`stitchapi` and the `@stitchapi/*` companion packages that ship in lockstep with
it. Older majors and minors are not backported unless explicitly noted in an
advisory.

| Version                                               | Supported          |
| ----------------------------------------------------- | ------------------ |
| Latest `1.0.x` (and current `1.0.0-rc.x` prereleases) | :white_check_mark: |
| `0.x`                                                 | :x:                |

## Reporting a vulnerability

**Please do not open a public GitHub issue, discussion, or pull request for a
security problem** — that discloses it to everyone before a fix exists.

Report it privately through either channel:

1. **GitHub private vulnerability reporting (preferred).** Open the repository's
   [**Security** tab](https://github.com/rejifald/StitchAPI/security) and choose
   **“Report a vulnerability.”** This opens a private advisory visible only to
   you and the maintainers, with a place to attach details and a proof of
   concept.
2. **Email.** If you cannot use GitHub advisories, email the maintainer at
   **rejifald@gmail.com** with the subject line `StitchAPI security`. Encrypt or
   ask for a secure channel if the report is sensitive.

Please include, as far as you can:

-   the affected package(s) and version(s), or a commit SHA;
-   the impact (what an attacker can do);
-   clear reproduction steps or a minimal proof of concept;
-   any known mitigations or a suggested fix.

## What to expect

-   **Acknowledgement** within **3 business days**.
-   An initial assessment (severity + whether we can reproduce it) within about a
    week.
-   We aim to ship a fix and publish a [GitHub Security Advisory][advisories]
    (with a CVE where warranted) within **90 days** of triage, coordinating the
    release timing with you.
-   We will **credit you** in the advisory and release notes unless you ask to
    remain anonymous.

We ask that you give us reasonable time to release a fix before any public
disclosure. Acting in good faith under this policy — investigating and reporting
without destroying data, degrading service, or accessing more data than needed
to demonstrate the issue — is welcome, and we will not pursue or support legal
action against research conducted that way.

## Scope

In scope — vulnerabilities in the published library, for example:

-   credential or secret **leakage** (e.g. auth headers surviving a cross-origin
    redirect, secrets escaping trace redaction);
-   **injection** in code generation (`stitch gen` / `@stitchapi/openapi`) from an
    untrusted OpenAPI spec;
-   **sandbox escape or egress confinement bypass** in the docs playground
    (`docs/sandbox`, `apps/docs`);
-   SSRF, prototype pollution, ReDoS, or similar reachable through the library's
    public API with realistic inputs.

Out of scope:

-   vulnerabilities in **your own** backend, API, or application code that merely
    uses StitchAPI;
-   issues that require an already-compromised host, a malicious dependency you
    chose to install, or physical/privileged local access;
-   reports generated solely by an automated scanner with no demonstrated,
    practical impact;
-   missing hardening headers or best-practice suggestions on `stitchapi.dev`
    without a concrete exploit.

If you are unsure whether something is in scope, report it anyway — we would
rather hear about it.

[advisories]: https://github.com/rejifald/StitchAPI/security/advisories
