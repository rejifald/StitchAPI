# @stitchapi/vercel-ai

[![npm](https://img.shields.io/npm/v/@stitchapi/vercel-ai?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/vercel-ai)

[Vercel AI SDK](https://sdk.vercel.ai) adapter for [StitchAPI](https://stitchapi.dev). Expose a stitch as a `tool()` the model can call inside `generateText` / `streamText`: the stitch runs as the tool's `execute`, so the model gets **typed, validated** data back — and the credential stays behind the boundary (a capability, not the credential).

StitchAPI is agent-native through the [MCP surface](https://stitchapi.dev/docs/surfaces/mcp) — the canonical way to hand a stitch to any agent. This is the framework-specific convenience for apps already on the AI SDK.

**Structural, version-bridged.** It imports nothing from `ai`; the returned tool carries both `parameters` (AI SDK v4) and `inputSchema` (v5), so it drops into either. `ai` is an optional peer.

## Install

```sh
pnpm add @stitchapi/vercel-ai@rc stitchapi@rc
```

`stitchapi` is the only required peer; bring the `ai` SDK you already run.

## `stitchTool`

```ts
import { getUser } from './api';

import { stitchTool } from '@stitchapi/vercel-ai';
import { generateText } from 'ai';
import { z } from 'zod';

const { text } = await generateText({
    model,
    prompt: 'Who is user 7?',
    tools: {
        getUser: stitchTool(getUser, {
            description: 'Fetch a user by id',
            inputSchema: z.object({ id: z.string() }),
            toInput: ({ id }) => ({ params: { id } }),
        }),
    },
});
```

-   `inputSchema` — the schema the model fills (a Zod schema, or any AI SDK `Schema`).
-   `toInput` — maps the model's args onto the stitch's `{ params, query, body }`. Omit it when the args _are_ the stitch input.

`inputSchema` is the one required field, so it also goes positionally: when the model's args _are_ the stitch input and no description is needed, pass the schema directly —

```ts
stitchTool(getUser, z.object({ params: z.object({ id: z.string() }) }));
// ≡ stitchTool(getUser, { inputSchema: z.object({ … }) })
```

The two forms are told apart by the `inputSchema` key: an object carrying one is the options envelope, anything else is the schema itself.

The tool's result is the stitch's validated output, so the model reasons over real data, not a guess. A failure rejects, so the AI SDK's tool-error handling reports it.

## `stitchExecute`

Just the `execute` function, if you compose the tool yourself (e.g. with `ai`'s `tool()` for tighter typing):

```ts
import { stitchExecute } from '@stitchapi/vercel-ai';
import { tool } from 'ai';
import { z } from 'zod';

const getUserTool = tool({
    description: 'Fetch a user by id',
    inputSchema: z.object({ id: z.string() }),
    execute: stitchExecute(getUser, ({ id }) => ({ params: { id } })),
});
```

## License

Apache-2.0

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
