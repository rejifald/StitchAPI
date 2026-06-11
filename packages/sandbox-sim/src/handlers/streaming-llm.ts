/**
 * S3 — Streaming / SSE + LLM endpoint handlers.
 *
 * Exports `streamingLlmHandlers: SimHandler[]` with two entries:
 *   GET  /stream               — chunked raw bytes (deterministic fixed chunks)
 *   POST /v1/chat/completions  — OpenAI-style SSE token streaming or JSON completion;
 *                                supports a tool-call-shaped variant when body.tools is set.
 *
 * All output is DETERMINISTIC (fixed token list, no Math.random, no Date.now in payloads).
 * Timing/pacing is not covered by determinism (§4.3).
 */

import type { SimHandler, SimRequest, SimResponse, SimKnobs } from '../../../../docs/playground/contracts/sim';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

/**
 * Fixed token sequence used by the LLM endpoint.
 * Deterministic — no randomness, no wall-clock.
 */
const TOKENS: readonly string[] = [
    'Hello',
    ',',
    ' world',
    '!',
    ' This',
    ' is',
    ' a',
    ' deterministic',
    ' LLM',
    ' response',
    '.',
];

/** Fixed tool-call sequence for the tool-call variant. */
const TOOL_CALL_ID = 'call_sandbox_0001';
const TOOL_CALL_NAME = 'get_weather';
const TOOL_CALL_ARGS = '{"location":"San Francisco, CA"}';

// ---------------------------------------------------------------------------
// Helper: build an SSE data frame
// ---------------------------------------------------------------------------

function sseFrame(payload: unknown): Uint8Array {
    return enc.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseDone(): Uint8Array {
    return enc.encode('data: [DONE]\n\n');
}

// ---------------------------------------------------------------------------
// Helper: OpenAI-style chunk shapes
// ---------------------------------------------------------------------------

interface Delta {
    role?: string;
    content?: string | null;
    tool_calls?: ToolCallChunk[];
}

interface ToolCallChunk {
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
}

interface ChatChunk {
    id: string;
    object: 'chat.completion.chunk';
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: Delta;
        finish_reason: string | null;
    }>;
}

interface ChatCompletion {
    id: string;
    object: 'chat.completion';
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: { role: string; content: string | null; tool_calls?: ToolCall[] };
        finish_reason: string;
    }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

// Stable synthetic timestamps: pinned to 2025-01-01T00:00:00Z to keep payloads
// deterministic (no Date.now() in output paths — §4.3).
const CREATED_AT = 1735689600; // 2025-01-01T00:00:00Z

const MODEL_ID = 'sandbox-gpt-sim-1';
const COMPLETION_ID = 'chatcmpl-sandbox0001';

// ---------------------------------------------------------------------------
// 1. GET /stream — chunked raw bytes
// ---------------------------------------------------------------------------

const STREAM_CHUNKS: readonly string[] = [
    'chunk-alpha\n',
    'chunk-beta\n',
    'chunk-gamma\n',
    'chunk-delta\n',
];

async function* makeChunkedStream(): AsyncIterable<Uint8Array> {
    for (const chunk of STREAM_CHUNKS) {
        yield enc.encode(chunk);
    }
}

const getStreamHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return req.method === 'GET' && req.url.pathname === '/stream';
    },

    handle(_req: SimRequest, _knobs: SimKnobs): SimResponse {
        // stream.chunks count satisfies StitchTraceEntry.stream hint (§8):
        // the iterable yields exactly STREAM_CHUNKS.length frames.
        return {
            status: 200,
            headers: {
                'content-type': 'application/octet-stream',
                // Hint for the trace layer: how many chunks to expect.
                'x-sandbox-stream-chunks': String(STREAM_CHUNKS.length),
            },
            stream: makeChunkedStream(),
        };
    },
};

// ---------------------------------------------------------------------------
// 2. POST /v1/chat/completions — LLM SSE + non-streaming + tool-call variant
// ---------------------------------------------------------------------------

function isToolCallRequest(body: unknown): boolean {
    if (body == null || typeof body !== 'object') return false;
    const b = body as Record<string, unknown>;
    return Array.isArray(b['tools']) && (b['tools'] as unknown[]).length > 0;
}

function isStreamingRequest(body: unknown): boolean {
    if (body == null || typeof body !== 'object') return false;
    return (body as Record<string, unknown>)['stream'] === true;
}

// --- SSE streaming: normal token delta ---

async function* makeLlmSseStream(): AsyncIterable<Uint8Array> {
    // Role frame
    const roleChunk: ChatChunk = {
        id: COMPLETION_ID,
        object: 'chat.completion.chunk',
        created: CREATED_AT,
        model: MODEL_ID,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    };
    yield sseFrame(roleChunk);

    // Token delta frames
    for (const token of TOKENS) {
        const chunk: ChatChunk = {
            id: COMPLETION_ID,
            object: 'chat.completion.chunk',
            created: CREATED_AT,
            model: MODEL_ID,
            choices: [{ index: 0, delta: { content: token }, finish_reason: null }],
        };
        yield sseFrame(chunk);
    }

    // Stop frame
    const stopChunk: ChatChunk = {
        id: COMPLETION_ID,
        object: 'chat.completion.chunk',
        created: CREATED_AT,
        model: MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    yield sseFrame(stopChunk);

    yield sseDone();
}

// --- SSE streaming: tool-call delta ---

async function* makeLlmToolSseStream(): AsyncIterable<Uint8Array> {
    // Role frame
    const roleChunk: ChatChunk = {
        id: COMPLETION_ID,
        object: 'chat.completion.chunk',
        created: CREATED_AT,
        model: MODEL_ID,
        choices: [
            {
                index: 0,
                delta: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [{ index: 0, id: TOOL_CALL_ID, type: 'function', function: { name: TOOL_CALL_NAME, arguments: '' } }],
                },
                finish_reason: null,
            },
        ],
    };
    yield sseFrame(roleChunk);

    // Stream the arguments as incremental chunks
    const argChunks = [TOOL_CALL_ARGS.slice(0, 15), TOOL_CALL_ARGS.slice(15)];
    for (const argPart of argChunks) {
        const chunk: ChatChunk = {
            id: COMPLETION_ID,
            object: 'chat.completion.chunk',
            created: CREATED_AT,
            model: MODEL_ID,
            choices: [
                {
                    index: 0,
                    delta: { tool_calls: [{ index: 0, function: { arguments: argPart } }] },
                    finish_reason: null,
                },
            ],
        };
        yield sseFrame(chunk);
    }

    // tool_calls finish frame
    const stopChunk: ChatChunk = {
        id: COMPLETION_ID,
        object: 'chat.completion.chunk',
        created: CREATED_AT,
        model: MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    };
    yield sseFrame(stopChunk);

    yield sseDone();
}

// --- Non-streaming: JSON completion ---

function makeLlmJsonBody(toolCall: boolean): ChatCompletion {
    if (toolCall) {
        return {
            id: COMPLETION_ID,
            object: 'chat.completion',
            created: CREATED_AT,
            model: MODEL_ID,
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [
                            {
                                id: TOOL_CALL_ID,
                                type: 'function',
                                function: { name: TOOL_CALL_NAME, arguments: TOOL_CALL_ARGS },
                            },
                        ],
                    },
                    finish_reason: 'tool_calls',
                },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        };
    }
    return {
        id: COMPLETION_ID,
        object: 'chat.completion',
        created: CREATED_AT,
        model: MODEL_ID,
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content: TOKENS.join('') },
                finish_reason: 'stop',
            },
        ],
        usage: { prompt_tokens: 10, completion_tokens: TOKENS.length, total_tokens: 10 + TOKENS.length },
    };
}

const chatCompletionsHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return req.method === 'POST' && req.url.pathname === '/v1/chat/completions';
    },

    handle(req: SimRequest, _knobs: SimKnobs): SimResponse {
        const body = req.body;
        const streaming = isStreamingRequest(body);
        const toolCall = isToolCallRequest(body);

        if (streaming) {
            return {
                status: 200,
                headers: {
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-cache',
                    'x-sandbox-stream-chunks': String(
                        toolCall
                            ? /* role + 2 arg parts + stop + done */ 5
                            : /* role + tokens + stop + done */ TOKENS.length + 3,
                    ),
                },
                stream: toolCall ? makeLlmToolSseStream() : makeLlmSseStream(),
            };
        }

        // Non-streaming — return body
        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: makeLlmJsonBody(toolCall),
        };
    },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const streamingLlmHandlers: SimHandler[] = [
    getStreamHandler,
    chatCompletionsHandler,
];
