# Playground sandbox — browser e2e harness

Minimal [Playwright](https://playwright.dev) harness that proves the
**load-bearing** playground security invariant in a real browser:
the CSP confines sandboxed-code egress to same-origin
(RELEASE.md → _Go/no-go gate_ #2; checklist SEC-10..13).

## What `sandbox-egress.spec.ts` asserts

1. **Document CSP confines egress** — the served policy includes
   `connect-src 'self'` and `worker-src 'self' blob:`, and does **not** grant
   `'unsafe-eval'` to the page.
2. **eval is confined to the Worker** — `/sandbox/sandbox-worker.mjs` carries its
   own policy that allows `'unsafe-eval'` (it runs user code via `new Function`)
   but still pins `connect-src 'self'`.
3. **A Worker cannot reach a foreign origin** — a blob Worker that tries to
   `fetch('https://example.org/')` is blocked, and no such request leaves the
   browser.
4. **The app still renders** under the strict CSP (`/playground` 200s, body is
   non-empty).

The specs are intentionally UI-independent (they don't drive CodeMirror or the
Run button), so they test the security model rather than the playground chrome.

## Run

```bash
# from apps/docs
pnpm run test:e2e:install   # one-time: download the chromium binary
pnpm run test:e2e           # builds + starts the app, then runs the specs
```

A running `pnpm dev` server is reused if present. Dev relaxes `connect-src` for
HMR, but the cross-origin egress block still holds, so the egress spec passes
against either a dev or a production server. The CSP itself lives in
[`../lib/security-headers.mjs`](../lib/security-headers.mjs) and is wired in
[`../next.config.mjs`](../next.config.mjs).

## Still outstanding (RELEASE.md → Playground browser Phase-2)

This harness covers egress confinement only. Before launch it should grow to
cover the rest of the deferred invariants: Worker isolation / no state bleed
(SEC-36/37), non-HTTP egress (WebSocket/EventSource/`sendBeacon`, SEC-04),
preemptive timeout/kill (SEC-20..22), and a real-Worker trace populating the
Mermaid DAG.
