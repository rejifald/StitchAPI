// #890: a failed tool call reaches the MODEL as text. The AI SDK turns a rejected `execute` into a
// `tool-result` whose output is `{ type: 'error-text', value: getErrorMessage(error) }` and sends it
// on the next step — so whatever `StitchError.message` says, the model reads.
//
// With `apiKey({ in: 'query' })` a transport that quotes the request URL (`Failed to parse URL from
// http://host:99999/v1/metrics?api_key=…`, or a node-fetch DNS failure) used to put the credential in
// the model's context. Core now scrubs URL credentials from the message where the engine turns the
// transport's throw into the error (#890), so this adapter needs no scrub of its own: these specs run
// the REAL AI SDK against a mock model and read back the prompt the model receives on step two.
import { stitchTool } from '../src';
import type { StitchTool } from '../src';

import { generateText, jsonSchema, stepCountIs } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { stitch } from 'stitchapi';
import { apiKey } from 'stitchapi/auth';

const KEY = 'ak_live_qry_8899aabbccddeeff';

const usage = {
    inputTokens: {
        total: 1,
        noCache: 1,
        cacheRead: undefined,
        cacheWrite: undefined,
    },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
};

// Run one agent turn: the model calls `metrics`, the tool fails, and the model's SECOND call is
// handed the failure. Returns the whole prompt of that second call, serialized — everything the
// model is shown.
async function promptAfterFailedTool(
    metrics: StitchTool<never, unknown>,
): Promise<string> {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
        doGenerate: (options) => {
            prompts.push(options.prompt);
            return Promise.resolve(
                prompts.length === 1
                    ? {
                          content: [
                              {
                                  type: 'tool-call' as const,
                                  toolCallId: 'call-1',
                                  toolName: 'metrics',
                                  input: '{}',
                              },
                          ],
                          finishReason: {
                              unified: 'tool-calls' as const,
                              raw: undefined,
                          },
                          usage,
                          warnings: [],
                      }
                    : {
                          content: [
                              { type: 'text' as const, text: 'it failed' },
                          ],
                          finishReason: {
                              unified: 'stop' as const,
                              raw: undefined,
                          },
                          usage,
                          warnings: [],
                      },
            );
        },
    });
    await generateText({
        model,
        prompt: 'Read the metrics.',
        tools: { metrics: metrics as never },
        stopWhen: stepCountIs(2),
    });
    expect(prompts).toHaveLength(2); // the model really was shown the tool's outcome
    return JSON.stringify(prompts[1]);
}

const schema = jsonSchema({ type: 'object', properties: {} });

describe('a tool failure that reaches the model carries no URL credential (#890)', () => {
    // The #866 reproduction on the DEFAULT fetch adapter and zero lines of user code: a port the URL
    // parser rejects makes the transport quote the whole request URL, key included.
    test('apiKey({ in: "query" }) + the default adapter on a URL the parser rejects', async () => {
        const metrics = stitchTool(
            stitch({
                url: 'http://api.vendor.test:99999/v1/metrics',
                auth: apiKey({ in: 'query', secret: KEY }),
            }),
            schema,
        );
        const shown = await promptAfterFailedTool(metrics);
        expect(shown).toContain('error-text'); // it IS the failure path…
        expect(shown).toContain('Failed to parse URL'); // …still a useful message…
        expect(shown).toContain('api_key=REDACTED'); // …that names the parameter, not its value
        expect(shown).not.toContain(KEY);
    });

    // The node-fetch shape: a routine DNS failure on a URL the parser accepts. A vendor-spelled
    // param name is caught because `apiKey` registers its `name` with the scrubber.
    test('a DNS-shaped adapter failure under a vendor-spelled param name', async () => {
        const metrics = stitchTool(
            stitch({
                url: 'https://api.vendor.test/v1/metrics?page=2',
                auth: apiKey({ in: 'query', name: 'vk', secret: KEY }),
                adapter: (request) =>
                    Promise.reject(
                        new Error(
                            `request to ${request.url} failed, reason: getaddrinfo ENOTFOUND api.vendor.test`,
                        ),
                    ),
            }),
            schema,
        );
        const shown = await promptAfterFailedTool(metrics);
        expect(shown).toContain('getaddrinfo ENOTFOUND');
        expect(shown).toContain('vk=REDACTED');
        expect(shown).not.toContain(KEY);
    });

    test('the rejection `execute` raises is scrubbed too, for a caller outside the AI SDK', async () => {
        const { execute } = stitchTool(
            stitch({
                url: 'http://api.vendor.test:99999/v1/metrics',
                auth: apiKey({ in: 'query', secret: KEY }),
            }),
            schema,
        );
        const err = (await execute({}).catch((e: unknown) => e)) as Error;
        expect(err.message).toContain('api_key=REDACTED');
        expect(err.message).not.toContain(KEY);
    });
});
