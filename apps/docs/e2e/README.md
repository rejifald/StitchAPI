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

## The rest of the security harness

The remaining browser-tier invariants are proved by driving the **real production
worker bundle** (`/sandbox/sandbox-worker.mjs`) directly via its `{type:'run', js}`
protocol — the same UI-independent style as `sandbox-trace.spec.ts`:

- **`sandbox-nonhttp-egress.spec.ts`** — SEC-04: `WebSocket`/`EventSource` are
  `undefined` in snippet scope, `navigator.sendBeacon` is unavailable, and a remote
  `import('https://…')` is CSP-blocked (`errorText: 'csp'`); the network spy records
  **zero completed** connections to the foreign origin.
- **`sandbox-timeout.spec.ts`** — SEC-20/21/22/24: a `while(true){}` snippet is killed
  by `worker.terminate()` from the host main thread (the runner's kill mechanism); the
  main thread keeps ticking during the loop (eval is off-main-thread), the worker is
  dead afterwards, a fresh worker runs the next snippet, the default cap fires when
  `timeoutMs` is omitted, and the kill is preemptive (a non-cooperative loop is still
  killed). The spec plays the runner's main-thread-killer role because the timeout is
  enforced by the runner, not the worker (a raw busy loop posted to the worker hangs).
- **`sandbox-isolation.spec.ts`** — SEC-36/37: no `globalThis` or `memoryStore`
  singleton bleed across runs, proved through the runner's **fresh-Worker-per-run**
  lifecycle, with a same-worker positive control so the absence is non-vacuous.

The timeout-classification fields of `RunError` (`reason:'timeout'`, etc.) and the
ordered-capture / throw-containment behaviours are already proved mechanically in Node
against a real `worker_threads` worker
([`docs/sandbox/runtime/browser-runner.test.ts`](../../../docs/sandbox/runtime/browser-runner.test.ts));
these specs add the real-browser proofs that the kill, the CSP backstop, and the
fresh-worker isolation hold against the shipped bundle in chromium.

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

Only `sandbox-egress.spec.ts`'s document-CSP `'unsafe-eval'` assertion is
prod-only (dev relaxes `script-src` for Fast Refresh, and the spec annotates +
skips that one assertion on a dev server). The SEC-04 / timeout / isolation specs
depend on the worker bundle + the worker's own `connect-src 'self'` CSP (identical
in dev and prod) + `worker.terminate()`, so they pass against a reused dev server
too — which is the fast path for local iteration.

## Launch-gate coverage (RELEASE.md → Playground browser Phase-2)

The Phase-2 browser invariants now have real-browser proofs: egress confinement
(SEC-10..13), non-HTTP egress (SEC-04), preemptive timeout/kill (SEC-20/21/22/24),
Worker isolation / no state bleed (SEC-36/37), and a real-Worker trace populating
the Mermaid DAG (`sandbox-trace.spec.ts`). The server-tier rows (SEC-23, SEC-38,
SEC-40..45) remain Phase-3 and out of scope for this browser harness.
