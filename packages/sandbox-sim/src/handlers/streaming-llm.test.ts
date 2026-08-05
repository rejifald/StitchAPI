/**
 * S3 smoke test — streaming-llm handlers.
 *
 * Uses node:assert + an async main(); no test framework required.
 * Run with: npx -y tsx packages/sandbox-sim/src/handlers/streaming-llm.test.ts
 *
 * Asserts:
 *   1. GET /stream yields deterministic chunked bytes (decoded contains expected content).
 *   2. POST /v1/chat/completions (streaming=true) yields SSE frames ending with [DONE].
 *   3. POST /v1/chat/completions (streaming=true, tools=[...]) yields tool_calls SSE + [DONE].
 *   4. POST /v1/chat/completions (non-streaming) returns a JSON body with content.
 *   5. POST /v1/chat/completions (non-streaming, tools=[...]) returns tool_calls JSON.
 *   6. Two runs of the same handler produce byte-identical output (determinism).
 */
import type { SimRequest } from '../../../../docs/sandbox/contracts/sim.js';
import { streamingLlmHandlers } from './streaming-llm.js';

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Typed assertion — asserts `c` is truthy, narrowing away undefined/null. */
function assertDefined<T>(
    c: T | undefined | null,
    msg?: string,
): asserts c is T {
    if (c == null)
        throw new Error(msg ?? 'Expected defined value, got ' + String(c));
}

const dec = new TextDecoder();

function makeReq(method: string, pathname: string, body?: unknown): SimRequest {
    return {
        method,
        url: new URL(`http://sandbox.local${pathname}`),
        headers: new Headers({ 'content-type': 'application/json' }),
        body,
    };
}

function findHandler(req: SimRequest) {
    const h = streamingLlmHandlers.find((h) => h.match(req));
    if (!h)
        throw new Error(`No handler matched ${req.method} ${req.url.pathname}`);
    return h;
}

async function collectStream(
    stream: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    // Concatenate all chunks into one Uint8Array
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }
    return result;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
    // -----------------------------------------------------------------------
    // 1. GET /stream — chunked raw bytes
    // -----------------------------------------------------------------------
    {
        const req = makeReq('GET', '/stream');
        const h = findHandler(req);
        const res = await h.handle(req, {});
        assert.equal(res.status, 200, 'GET /stream status');
        assertDefined(res.stream, 'GET /stream must have a stream');

        const bytes = await collectStream(res.stream);
        const text = dec.decode(bytes);
        assert(text.includes('chunk-alpha'), 'stream contains chunk-alpha');
        assert(text.includes('chunk-delta'), 'stream contains chunk-delta');

        // Determinism: run the handler again, compare bytes
        const res2 = await h.handle(req, {});
        assertDefined(res2.stream, 'GET /stream second run must have a stream');
        const bytes2 = await collectStream(res2.stream);
        assert(
            bytesEqual(bytes, bytes2),
            'GET /stream: two runs must be byte-identical',
        );
    }

    // -----------------------------------------------------------------------
    // 2. POST /v1/chat/completions — SSE streaming (no tools)
    // -----------------------------------------------------------------------
    {
        const req = makeReq('POST', '/v1/chat/completions', {
            stream: true,
            messages: [],
        });
        const h = findHandler(req);
        const res = await h.handle(req, {});
        assert.equal(res.status, 200, 'chat/completions SSE status');
        assertDefined(res.stream, 'chat/completions SSE must have a stream');

        const bytes = await collectStream(res.stream);
        const text = dec.decode(bytes);

        assert(text.includes('[DONE]'), 'SSE stream must end with [DONE]');
        assert(text.includes('Hello'), 'SSE stream must contain token "Hello"');
        assert(
            text.includes('deterministic'),
            'SSE stream must contain token "deterministic"',
        );
        assert(
            text.includes('"finish_reason":"stop"'),
            'SSE stream must have stop finish_reason',
        );

        // Determinism
        const res2 = await h.handle(req, {});
        assertDefined(res2.stream, 'second run must have stream');
        const bytes2 = await collectStream(res2.stream);
        assert(
            bytesEqual(bytes, bytes2),
            'chat/completions SSE: two runs must be byte-identical',
        );
    }

    // -----------------------------------------------------------------------
    // 3. POST /v1/chat/completions — SSE streaming (tool-call variant)
    // -----------------------------------------------------------------------
    {
        const req = makeReq('POST', '/v1/chat/completions', {
            stream: true,
            messages: [],
            tools: [{ type: 'function', function: { name: 'get_weather' } }],
        });
        const h = findHandler(req);
        const res = await h.handle(req, {});
        assert.equal(res.status, 200, 'chat/completions tool SSE status');
        assertDefined(
            res.stream,
            'chat/completions tool SSE must have a stream',
        );

        const bytes = await collectStream(res.stream);
        const text = dec.decode(bytes);

        assert(text.includes('[DONE]'), 'tool SSE stream must end with [DONE]');
        assert(
            text.includes('tool_calls'),
            'tool SSE stream must contain tool_calls',
        );
        assert(
            text.includes('get_weather'),
            'tool SSE stream must contain tool name',
        );
        assert(
            text.includes('"finish_reason":"tool_calls"'),
            'tool SSE must have tool_calls finish_reason',
        );

        // Determinism
        const res2 = await h.handle(req, {});
        assertDefined(res2.stream, 'second run must have stream');
        const bytes2 = await collectStream(res2.stream);
        assert(
            bytesEqual(bytes, bytes2),
            'chat/completions tool SSE: two runs must be byte-identical',
        );
    }

    // -----------------------------------------------------------------------
    // 4. POST /v1/chat/completions — non-streaming JSON
    // -----------------------------------------------------------------------
    {
        const req = makeReq('POST', '/v1/chat/completions', {
            stream: false,
            messages: [],
        });
        const h = findHandler(req);
        const res = await h.handle(req, {});
        assert.equal(res.status, 200, 'chat/completions JSON status');
        assert(
            res.body !== undefined,
            'chat/completions JSON must have a body',
        );
        assert(!res.stream, 'chat/completions JSON must not have a stream');

        const body = res.body as Record<string, unknown>;
        assert.equal(body['object'], 'chat.completion', 'body.object');
        const choices = body['choices'] as {
            message: { content: string };
        }[];
        assert(
            choices[0].message.content.includes('Hello'),
            'body content includes Hello',
        );

        // Determinism (body should be identical object structure)
        const res2 = await h.handle(req, {});
        assert.deepEqual(
            res.body,
            res2.body,
            'non-streaming JSON: two runs must be identical',
        );
    }

    // -----------------------------------------------------------------------
    // 5. POST /v1/chat/completions — non-streaming JSON tool-call variant
    // -----------------------------------------------------------------------
    {
        const req = makeReq('POST', '/v1/chat/completions', {
            stream: false,
            messages: [],
            tools: [{ type: 'function', function: { name: 'get_weather' } }],
        });
        const h = findHandler(req);
        const res = await h.handle(req, {});
        assert.equal(res.status, 200, 'chat/completions tool JSON status');

        const body = res.body as Record<string, unknown>;
        const choices = body['choices'] as {
            message: { tool_calls?: unknown[]; content: unknown };
        }[];
        assert(
            Array.isArray(choices[0].message.tool_calls),
            'tool-call response must have tool_calls array',
        );
        const tc = choices[0].message.tool_calls[0] as {
            function: { name: string; arguments: string };
        };
        assert.equal(
            tc.function.name,
            'get_weather',
            'tool_call function name',
        );
        assert.equal(
            choices[0].message.content,
            null,
            'tool-call response content must be null',
        );

        // Determinism
        const res2 = await h.handle(req, {});
        assert.deepEqual(
            res.body,
            res2.body,
            'tool-call JSON: two runs must be identical',
        );
    }

    // -----------------------------------------------------------------------
    // 6. streamingLlmHandlers is exported and typed as SimHandler[]
    // -----------------------------------------------------------------------
    assert(
        Array.isArray(streamingLlmHandlers),
        'streamingLlmHandlers must be an array',
    );
    assert(streamingLlmHandlers.length >= 2, 'must have at least 2 handlers');
    for (const h of streamingLlmHandlers) {
        assert(typeof h.match === 'function', 'each handler must have match()');
        assert(
            typeof h.handle === 'function',
            'each handler must have handle()',
        );
    }

    console.log('S3 OK');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
