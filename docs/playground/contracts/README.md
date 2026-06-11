# Playground sandbox — frozen contracts

These types and signatures are the **frozen** shared contracts for the sandbox
build. They are authored once by **C1 (Wave 0, T3/Opus)** and every downstream
task (S1–S5, R1–R2, D1, U1, T-α, SR1) imports from here.

> **Design of record:** [`../SANDBOX.md`](../SANDBOX.md) ·
> **Sequencing:** [`../SANDBOX-IMPLEMENTATION-PLAN.md`](../SANDBOX-IMPLEMENTATION-PLAN.md) §3

## The rule (IMPLEMENTATION-PLAN §3)

> A T1/T2 task that finds a contract insufficient **stops and reports**; it does
> **not** widen the contract. Contract changes are re-ratified by **C1 (T3)**.

If your task can't be done against the shape here, that is a signal to escalate to
C1, not to edit these files. Widening a contract silently breaks the guarantee
that lower-tier tasks can be dispatched safely in isolation.

## What's here

| File          | Frozen surface                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner.ts`   | Re-export of the existing `CodeRunner` contract — `CodeRunner`, `RunRequest`, `RunResult`, `RunError`, `StitchTraceEntry`, `LogEntry`, `LogLevel`. Canonical source stays in [`../component/runner.ts`](../component/runner.ts) (moving it would break `StitchPlayground.tsx`). |
| `sim.ts`      | Fake-API simulator handler contract — `SimRequest`, `SimResponse`, `SimHandler`, `SimKnobs`.                                                                                                                                                                                    |
| `dispatch.ts` | Dispatch contract — `Tier`, `SurfaceScan`, `DispatchOpts`, the `NODE_ONLY_SURFACES` constant, and the `scanSurface` / `dispatchRunner` **signatures** (behaviour implemented in D1).                                                                                            |
| `index.ts`    | Barrel — the single import surface (`from '../contracts'`).                                                                                                                                                                                                                     |

`scanSurface` and `dispatchRunner` ship as throwing stubs marked
`// implemented in D1`; only their signatures are frozen now.

## Type-check

```sh
npx -y -p typescript@5 tsc --noEmit -p docs/playground/contracts/tsconfig.json
```

Pure TypeScript, framework-agnostic, no runtime deps — mirrors `runner.ts`.
