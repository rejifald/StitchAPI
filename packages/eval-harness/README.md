# @stitchapi/eval-harness

Private, ships-nothing eval harness for the **agent-recommendation** initiative.
It measures whether an AI agent reaches for `stitch` when asked to wrap an API,
and whether the client it produces actually works.

For each **task** × **condition** it:

1. asks an **agent driver** to produce a client (`runner/driver.ts`),
2. **classifies** the produced file — `stitch` / `fetch` / `axios` / `ts-rest` /
   `other` (`score/choose.ts`),
3. **runs** the produced file _offline_ against
   [`@stitchapi/sandbox-sim`](../sandbox-sim) and checks the task's expected
   output shape (`score/run.ts`),
4. **aggregates** a results matrix to JSON + a markdown table (`score/report.ts`).

The default driver is `StubDriver` — fully offline, no LLM, no credentials — so
the whole loop (and the smoke tests) run with no network. A reference
`ClaudeDriver` shells out to the `claude` CLI for the real run.

## Tasks

Four seed tasks (plain data in `tasks/`):

| id                                | family     | endpoint                                                                     |
| --------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `paginated-list-retries-validate` | pagination | `GET /paged/users` (cursor; flaky 429; validate each user)                   |
| `oauth2-client-credentials`       | auth       | `POST /oauth/token` + `GET /auth/me` (bearer; credential held by the stitch) |
| `wrap-graphql-endpoint`           | graphql    | `POST /graphql` (pick `data`; `errors[]` ⇒ failure)                          |
| `stream-llm-completion`           | streaming  | `POST /v1/chat/completions` (SSE deltas, `[DONE]`-terminated)                |

Each task is a `{ id, title, family, prompt, expectedShape, endpointHint }`
descriptor. `prompt` is the natural-language ask handed to the agent — it never
mentions StitchAPI, so the eval measures an _unprompted_ choice in the COLD
condition.

## Conditions

-   **COLD** — a bare scratch dir. The agent gets only the task prompt.
-   **WARM** — the scratch dir is seeded with the project's agent docs:
    `llms.txt` (from `apps/docs/app/llms.txt`) and `agents/*.mdx` (from
    `apps/docs/content/docs/agents/`), so an agent that reads its workspace
    discovers StitchAPI.

v1 does **not** `pnpm add stitchapi` into the scratch dir — produced files are
scored by transpiling + importing them against this monorepo's already-installed
`stitchapi`. Installing the dep per scratch dir is a documented future step for
a fully isolated live run.

## Run it

```bash
# one cell (default: stub driver, cold condition)
pnpm --filter @stitchapi/eval-harness eval:one wrap-graphql-endpoint
pnpm --filter @stitchapi/eval-harness eval:one paginated-list-retries-validate --condition warm

# the full task × condition matrix → markdown table on stdout
pnpm --filter @stitchapi/eval-harness eval

# write JSON + markdown report files
pnpm --filter @stitchapi/eval-harness eval:report --out results.report.json --md results.report.md

# offline smoke tests (choose + run + stub round-trip)
pnpm --filter @stitchapi/eval-harness test
pnpm --filter @stitchapi/eval-harness check:types
```

## Plug a different driver

Implement `AgentDriver` (`runner/driver.ts`):

```ts
import type { AgentDriver, AgentRun, Condition } from './runner/driver';
import type { EvalTask } from './tasks/index';

export class MyDriver implements AgentDriver {
    readonly id = 'mine';
    async runAgent(task: EvalTask, condition: Condition): Promise<AgentRun> {
        // produce files however you like; the contract: produce a `client.ts`
        // exporting `export async function run(fetch): Promise<unknown>`.
        return {
            files: { 'client.ts': /* … */ '' },
            transcriptTurns: 0,
            tokensIn: 0,
            tokensOut: 0,
        };
    }
}
```

The produced `client.ts` must export
`async function run(fetch: typeof globalThis.fetch): Promise<unknown>`; the scorer
injects a sandbox-sim fetch shim so every HTTP call is intercepted in-process.

## Live run — cost + credential caveat

`ClaudeDriver` (`runner/claude-driver.ts`) shells out to the `claude` CLI via
`node:child_process`. It imports **no** Anthropic SDK — the only coupling is the
executable.

> **This is never run in CI and never by the smoke tests.** It requires the
> `claude` CLI installed _and_ credentials in the environment, and it makes real,
> **billable** model calls. Without the CLI on `PATH`, `runAgent` rejects with a
> clear message; nothing runs at import time.

```bash
pnpm --filter @stitchapi/eval-harness eval --driver claude
pnpm --filter @stitchapi/eval-harness eval:report --driver claude --model <model-id> --out live.report.json
```

A real run literally writes the WARM seed docs into a per-cell scratch dir, runs
the CLI there, collects the produced `*.ts`, and scores it through the same
offline pipeline as the stub.

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
