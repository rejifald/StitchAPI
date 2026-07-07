/**
 * Shared setup for the two entry points in this example:
 *   - `index.ts`  — a CLI that prints the run to the terminal (`npm run cli`)
 *   - `server.ts` — a tiny web server that renders the run to a page (`npm start`)
 *
 * The wiring is the whole point:
 *   1. `stitch(...)`           one endpoint   → a typed, validated function   (stitchapi)
 *   2. `stitchTool(...)`       that function  → a Vercel AI SDK tool          (@stitchapi/vercel-ai)
 *   3. `new Agent({ tools })`  that tool      → runs in the agent loop        (@openharness/core)
 *
 * It runs offline: the HTTP transport is a mock `Adapter` and the LLM is a
 * `MockLanguageModelV3`, so no network and no API key are needed.
 */
import { Agent } from '@openharness/core';
import { stitchTool } from '@stitchapi/vercel-ai';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { stitch } from 'stitchapi';
import type { Adapter } from 'stitchapi';
import { z } from 'zod';

export const PROMPT = 'Who is user 2, and where do they work?';

// The full payload the "API" returns — seven fields.
export const RAW_USER_RESPONSE = {
    id: 2,
    name: 'Ervin Howell',
    username: 'Antonette',
    email: 'Shanna@melissa.tv',
    phone: '010-692-6593',
    website: 'anastasia.net',
    company: {
        name: 'Deckow-Crist',
        catchPhrase: 'Proactive didactic contingency',
    },
};

// The output contract — four fields. The stitch validates the response against this
// and infers the return type from it, so the agent only ever sees valid, shaped data.
export const User = z.object({
    id: z.number(),
    name: z.string(),
    email: z.string(),
    company: z.object({ name: z.string() }),
});

// A mock adapter keeps the example offline & deterministic. It returns MORE fields
// than the schema declares, to prove the stitch validates and *shapes* the payload
// before the model sees it. Delete `adapter` below to hit the real endpoint.
const mockAdapter: Adapter = async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: RAW_USER_RESPONSE,
});

const getUser = stitch({
    baseUrl: 'https://jsonplaceholder.typicode.com',
    path: '/users/{id}',
    output: User,
    adapter: mockAdapter, // ← delete this line to hit the real API
});

// Wrap the stitch as a plain AI SDK tool (`inputSchema` + `execute`). `toInput`
// maps the model's flat args onto the stitch input `{ params }`.
export const tools = {
    getUser: stitchTool(getUser, {
        description: 'Look up a user by their numeric id.',
        inputSchema: z.object({ id: z.string() }),
        toInput: ({ id }) => ({ params: { id } }),
    }),
};

// The stitch tool sits right beside any native OpenHarness tools (fs, bash, MCP,
// subagents) in the same `tools` map.
export async function createAgent(): Promise<Agent> {
    const model = process.env.OPENAI_API_KEY
        ? await realModel()
        : mockThatCalls('getUser', { id: '2' });
    return new Agent({
        name: 'directory',
        model: model as LanguageModel,
        tools,
        maxSteps: 5,
        instructions: false, // self-contained: don't read AGENTS.md / CLAUDE.md from disk
    });
}

// ---------------------------------------------------------------------------
// A deterministic mock LanguageModel (AI SDK v6 provider spec) so the demo needs
// no API key. Step 1 emits a tool call; once the tool result is in context, step 2
// writes the final answer. This is the ONLY mocked model piece.
// ---------------------------------------------------------------------------
const usage = {
    inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 14, noCache: 14, cacheRead: 0, cacheWrite: 0 },
    totalTokens: 22,
};

function mockThatCalls(toolName: string, args: Record<string, string>) {
    return new MockLanguageModelV3({
        doStream: async ({ prompt }) => {
            const toolResultInContext = prompt.some((m) => m.role === 'tool');

            if (!toolResultInContext) {
                // Step 1 — call the tool.
                return {
                    stream: convertArrayToReadableStream([
                        { type: 'stream-start', warnings: [] },
                        {
                            type: 'tool-call',
                            toolCallId: 'call-1',
                            toolName,
                            input: JSON.stringify(args),
                        },
                        { type: 'finish', finishReason: 'tool-calls', usage },
                    ]),
                };
            }

            // Step 2 — the validated user is now in context; answer from it.
            const answer = 'User 2 is Ervin Howell, who works at Deckow-Crist.';
            return {
                stream: convertArrayToReadableStream([
                    { type: 'stream-start', warnings: [] },
                    { type: 'text-start', id: 't1' },
                    ...[...answer].map((ch) => ({
                        type: 'text-delta' as const,
                        id: 't1',
                        delta: ch,
                    })),
                    { type: 'text-end', id: 't1' },
                    { type: 'finish', finishReason: 'stop', usage },
                ]),
            };
        },
    });
}

async function realModel(): Promise<LanguageModel> {
    // To use a real model: `npm i @ai-sdk/openai`, `export OPENAI_API_KEY=sk-...`,
    // then uncomment the two lines below.
    // const { openai } = await import('@ai-sdk/openai');
    // return openai('gpt-5.4');
    throw new Error(
        'realModel() is stubbed — see the comment in agent.ts to enable a real provider.',
    );
}
