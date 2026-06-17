/**
 * Task 4 — stream an LLM completion.
 *
 * Exercises the LLM / SSE surface against the EXISTING sandbox-sim handler:
 *   POST {base}/v1/chat/completions
 *     - body.stream === true → an OpenAI-style SSE token stream terminated by
 *       `data: [DONE]`.
 *     - otherwise → a non-streaming JSON ChatCompletion.
 *
 * The sandbox LLM endpoint is deterministic: its assembled text is the fixed
 * token list 'Hello, world! This is a deterministic LLM response.'. The produced
 * client should accumulate the streamed deltas into the final string (or read the
 * non-streaming body's message content).
 */
import type { EvalTask } from './types';
import { isRecord } from './types';

/** The deterministic completion text the sandbox LLM handler always produces. */
export const EXPECTED_LLM_TEXT =
    'Hello, world! This is a deterministic LLM response.';

export const streamLlmCompletion: EvalTask = {
    id: 'stream-llm-completion',
    title: 'Stream an LLM chat completion',
    family: 'streaming',
    prompt: [
        'Write a TypeScript module that calls an OpenAI-compatible chat',
        "completions endpoint and returns the assistant's full reply as a",
        'string. The endpoint is POST {base}/v1/chat/completions with a JSON body',
        'like { model, messages: [{ role, content }], stream: true }.',
        '',
        'When stream is true the response is an SSE token stream: lines of',
        '`data: <json chunk>` where each chunk has',
        'choices[0].delta.content, terminated by a final `data: [DONE]`.',
        'Accumulate the deltas into the complete message text and return it.',
        'Make the base URL injectable so the module can be tested.',
    ].join('\n'),
    endpointHint:
        'POST {base}/v1/chat/completions (stream:true → SSE deltas, [DONE]-terminated)',
    expectedShape(out: unknown): boolean {
        // Either the accumulated string, or a { text|content } wrapper carrying it.
        if (typeof out === 'string') return out.includes('deterministic');
        if (isRecord(out)) {
            const text = out['text'] ?? out['content'];
            return typeof text === 'string' && text.includes('deterministic');
        }
        return false;
    },
};
