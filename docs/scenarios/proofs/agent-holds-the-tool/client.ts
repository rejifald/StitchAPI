// An MCP client, driving the server the way a real one does — over JSON-RPC.
//
// Every script here talks to the server through `initialize` / `tools/list` / `tools/call`
// messages and reads the RESPONSE PAYLOAD BACK AS A STRING, because that string is what a real
// client puts in the model's context. Calling `callRunStitch` directly would test a function; this
// tests the surface, and it is the serialised payload that C1 scans for credential values.
//
// Two transports, same interface:
//   - `inProcess`  — `createMcpServer(registry).handle(msg)`, serialised with `JSON.stringify`
//                    exactly as `serveStdio` does before writing it (mcp.ts:337).
//   - `overStdio`  — a real `serveStdio` wired to a pair of `PassThrough` streams, so the bytes
//                    are read off a stream after a newline-delimited round trip. Slower, and the
//                    point is that it is the shipped transport rather than a re-implementation.
//
// THE BOOT SHIM. `src/mcp.ts` reads `__PKG_VERSION__`, an esbuild `define` supplied by tsup and by
// vitest (src/version.d.ts) — under a bare `tsx` run there is no define, and the module would throw
// `ReferenceError` at import time. `loadMcp` sets the global first and then imports DYNAMICALLY, so
// the assignment is guaranteed to run before the module body regardless of how the import sorter
// orders anything. This is the only reason these scripts do not `import { createMcpServer } from
// '../../../../packages/core/src/mcp'` at the top like every other import in this directory.
// `import type` is erased outright (`verbatimModuleSyntax` + `isolatedModules`), so naming these
// types costs no runtime import of `src/mcp.ts` and the shim above stays the only loader.
import type { JsonRpcMessage } from '../../../../packages/core/src/mcp';
import type { StitchRegistry } from '../../../../packages/core/src/registry';

import { PassThrough } from 'node:stream';

type McpModule = typeof import('../../../../packages/core/src/mcp');

/** Load `src/mcp.ts` with the build-time version define stood in for. See the note above. */
export async function loadMcp(): Promise<McpModule> {
    (globalThis as unknown as Record<string, unknown>)['__PKG_VERSION__'] ??=
        '0.0.0-proof';
    return import('../../../../packages/core/src/mcp');
}

/** One request/response round trip, kept whole so a script can assert on any layer of it. */
export interface Exchange {
    /** The JSON-RPC method that was sent (plus the tool name, for `tools/call`). */
    label: string;
    /** The EXACT bytes a client would read off the transport. This is what C1 scans. */
    raw: string;
    /** The parsed response. */
    message: JsonRpcMessage;
    /** A tool result's concatenated `content[].text`, or `''` for a non-tool response. */
    text: string;
    /** A tool result's `isError` flag. */
    isError: boolean;
}

export interface McpClient {
    /** Send a raw JSON-RPC request and return the round trip. */
    send(method: string, params?: unknown): Promise<Exchange>;
    /** `tools/call` shorthand. */
    callTool(name: string, args?: unknown): Promise<Exchange>;
    /** Every exchange so far, in order — the transcript C1 scans in bulk. */
    readonly transcript: Exchange[];
    close(): void;
}

interface ToolResultShape {
    content?: { type?: string; text?: string }[];
    isError?: boolean;
}

/** Pull the model-visible text and error flag out of whatever the server returned. */
function readToolResult(message: JsonRpcMessage): {
    text: string;
    isError: boolean;
} {
    const result = message.result as ToolResultShape | undefined;
    const content = result?.content;
    if (!Array.isArray(content)) return { text: '', isError: false };
    return {
        text: content.map((c) => c.text ?? '').join('\n'),
        isError: result?.isError === true,
    };
}

function exchangeOf(label: string, raw: string): Exchange {
    const message = JSON.parse(raw) as JsonRpcMessage;
    return { label, raw, message, ...readToolResult(message) };
}

/**
 * Drive `createMcpServer` in-process. The response is serialised with the same `JSON.stringify`
 * call `serveStdio` makes before writing it to the socket, so `raw` is byte-identical to what the
 * stdio transport emits (asserted in `c1-credential-reach.ts`).
 */
export async function inProcess(
    registry: StitchRegistry,
    server?: string,
): Promise<McpClient> {
    const { createMcpServer } = await loadMcp();
    const mcp = createMcpServer(registry, server);
    const transcript: Exchange[] = [];
    let id = 0;

    const send = async (
        method: string,
        params?: unknown,
    ): Promise<Exchange> => {
        const request = {
            jsonrpc: '2.0' as const,
            id: ++id,
            method,
            ...(params === undefined ? {} : { params }),
        };
        const response = await mcp.handle(request);
        const label =
            method === 'tools/call'
                ? `tools/call ${String((params as { name?: unknown } | undefined)?.name)}`
                : method;
        const ex = exchangeOf(label, JSON.stringify(response));
        transcript.push(ex);
        return ex;
    };

    return {
        send,
        callTool: (name, args) =>
            send('tools/call', { name, arguments: args ?? {} }),
        transcript,
        close: () => undefined,
    };
}

/**
 * Drive the SHIPPED stdio transport: a real `serveStdio` reading newline-delimited JSON-RPC off a
 * stream and writing responses to another. Used to confirm the in-process transcript is the same
 * bytes the transport writes — the C1 scan is only worth anything if it scans what ships.
 */
export async function overStdio(
    registry: StitchRegistry,
    server?: string,
): Promise<McpClient> {
    const { serveStdio } = await loadMcp();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.setEncoding('utf8');
    const handle = serveStdio(
        registry,
        server === undefined ? { stdin, stdout } : { stdin, stdout, server },
    );

    // One reader for the whole session: buffer whatever arrives and hand out complete lines in
    // order, so a caller awaiting response N cannot be handed response N+1.
    let buffer = '';
    const waiting: ((line: string) => void)[] = [];
    stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            const next = waiting.shift();
            if (next) next(line);
        }
    });
    const nextLine = (): Promise<string> =>
        new Promise<string>((resolve) => waiting.push(resolve));

    const transcript: Exchange[] = [];
    let id = 0;
    const send = async (
        method: string,
        params?: unknown,
    ): Promise<Exchange> => {
        const request = {
            jsonrpc: '2.0' as const,
            id: ++id,
            method,
            ...(params === undefined ? {} : { params }),
        };
        const line = nextLine();
        stdin.write(`${JSON.stringify(request)}\n`);
        const label =
            method === 'tools/call'
                ? `tools/call ${String((params as { name?: unknown } | undefined)?.name)}`
                : method;
        const ex = exchangeOf(label, await line);
        transcript.push(ex);
        return ex;
    };

    return {
        send,
        callTool: (name, args) =>
            send('tools/call', { name, arguments: args ?? {} }),
        transcript,
        close: () => {
            handle.close();
            stdin.end();
        },
    };
}
