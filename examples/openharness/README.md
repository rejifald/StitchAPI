# A stitch as an OpenHarness agent tool

A stitch — StitchAPI's typed, validated `input → output` unit — dropped into an
[OpenHarness](https://github.com/MaxGfeller/open-harness) agent as a tool, via the
[`@stitchapi/vercel-ai`](https://stitchapi.dev/docs/integrations/vercel-ai) adapter.

```
stitch(...)            one endpoint   → a typed, validated function   (stitchapi)
stitchTool(...)        that function  → a Vercel AI SDK tool          (@stitchapi/vercel-ai)
new Agent({ tools })   that tool      → runs in the agent loop        (@openharness/core)
```

Because OpenHarness is built on the Vercel AI SDK, a stitch tool drops into the
**same `tools` map** as OpenHarness's native fs / bash / MCP tools — no glue.

Unlike the other files in [`../`](../), this example depends on two external
packages (`@openharness/core`, `ai`), so it lives in its own directory with its own
`package.json` rather than as a loose file in the monorepo.

## Run it

```sh
npm install
npm start        # serves a page that runs the agent on load — open the URL
```

`npm start` runs a tiny `node:http` server (`server.ts`) that executes the agent on
each request and renders the result to a page — so in CodeSandbox / StackBlitz you
see the run, not a blank preview. For the same run printed to the terminal instead:

```sh
npm run cli
```

Terminal output:

```
▶  prompt: "Who is user 2, and where do they work?"

   ├─ tool call    getUser({"id":"2"})
   ├─ tool result  {"id":2,"name":"Ervin Howell","email":"Shanna@melissa.tv","company":{"name":"Deckow-Crist"}}
   │               ↑ validated & shaped by the stitch's Zod output schema
User 2 is Ervin Howell, who works at Deckow-Crist.

✓  done — the agent answered from the schema-validated tool result.

examples/openharness OK
```

Both entry points share `agent.ts` and run **offline** and deterministically — the
HTTP transport is a mock `Adapter` and the LLM is a `MockLanguageModelV3`, so no
network and no API key are needed.

## What it shows

-   **A stitch is agent-native.** The model calls a capability and gets back
    schema-validated data. Notice the tool result carries only the four fields in the
    `output` schema — the adapter returned seven. That stripping _is_ the stitch
    validating the response. If `getUser` carried an API key (`bearer(...)`,
    `oauth2(...)`, `apiKey(...)`), it would stay behind the tool boundary and never
    reach the model — a [capability, not the credential](https://stitchapi.dev/docs/concepts/capability-not-credential).
-   **Resilience is declarative, at the tool.** Retry, caching, request coalescing,
    timeouts, and auth are stitch config — not hand-rolled `fetch` inside a tool's
    `execute`. See the [resilience guides](https://stitchapi.dev/docs/guides/resilience/retry).

## Make it live

-   **Real HTTP:** delete the `adapter:` line on the stitch in `agent.ts`; the same
    stitch then calls the real endpoint over `fetch`.
-   **Real model:** `npm i @ai-sdk/openai`, `export OPENAI_API_KEY=sk-...`, then
    uncomment the two lines in `realModel()`. A real `gpt-5.4` will choose the tool on
    its own; without a key, the mock drives the same loop deterministically.

## Versions

Verified together: `@openharness/core@0.7.0` (Vercel AI SDK **v6**),
`@stitchapi/vercel-ai@1.0.0-rc.2`, `stitchapi@1.0.0-rc.4`, `ai@6`, `zod@4`.
