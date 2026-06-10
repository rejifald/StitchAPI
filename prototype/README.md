# StitchAPI v1 — synthetic test harness

A **standalone prototype** that proves the v1 design claims end-to-end against synthetic
scenarios, **before** integrating into real apps. It is intentionally
separate from `../src` (which is mid-refactor) and disposable.

## What it proves

| Claim | Where |
|---|---|
| Declarative config + composition (`extends` / `defineStitch` / builder / `.with`) | `src/stitch.ts` |
| Event-stream return type (`start→progress→drift→result→done`) + `await` sugar | `src/engine.ts` |
| Validation flexible across **Zod and Standard Schema** | `src/validator.ts` |
| Leveled drift detection (error / warn / info) vs a committed snapshot | `src/drift.ts` |
| Resilience: retry (backoff+jitter, Retry-After), throttle, timeout | `src/resilience.ts` |
| Auth-as-boundary (cookie login, refresh-on-401) — agent never sees the secret | `src/auth.ts` |
| Zero-infra observability: console + JSONL sink | `src/trace.ts` |

## Run

```bash
npx jest --config prototype/jest.config.cjs
```

Scenarios live in `test/*.spec.ts` and drive a real local HTTP mock server
(`test/support/mock-server.ts`) so every claim is verified through real `fetch`.
