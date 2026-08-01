/**
 * Sandbox MCP server — exposes the StitchAPI sandbox to agents over MCP (stdio).
 *
 * Wraps core's transport-agnostic `createMcpServer` (which provides `run_stitch`
 * + `list_stitches`) and adds a `run_in_sandbox` tool that runs an arbitrary
 * snippet in the Node sandbox. The host process must override `globalThis.fetch`
 * with the sim shim BEFORE handling calls (see `bin.ts`) so `run_stitch` is
 * sim-backed too — no real network, no credentials.
 */
import {
    type JsonRpcMessage,
    type McpServer,
    type McpServerInfo,
    createMcpServer,
} from '../../../packages/core/src/mcp';
import type { StitchRegistry } from '../../../packages/core/src/registry';
import { buildRunView } from '../component/output-format';
import type { RunResult } from '../component/runner';
import { runInSandbox } from '../runtime/node-runner';

import type { Readable, Writable } from 'node:stream';

/** MCP `tools/call` result shape (mirrors core's private `ToolResult`). */
interface ToolResult {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

const RUN_IN_SANDBOX_TOOL = {
    name: 'run_in_sandbox',
    description:
        'Execute an arbitrary TypeScript/JavaScript snippet in an isolated sandbox ' +
        'against a fake-API simulator (no real network, no credentials). The ' +
        'StitchAPI surface — `stitch`, auth helpers, etc. — is in scope, and the ' +
        "snippet's only `fetch` is the simulator; reach demo routes on " +
        'api.example.com (e.g. /users, /users/2, /status/500). Top-level await ' +
        'is allowed. Returns captured console logs, the resolved value, any error, ' +
        'and notices.',
    inputSchema: {
        type: 'object',
        properties: {
            code: {
                type: 'string',
                description: 'The TS/JS snippet to run.',
            },
            timeoutMs: {
                type: 'number',
                description:
                    'Optional hard time limit (ms); the run is killed past it.',
            },
        },
        required: ['code'],
    },
} as const;

function textResult(text: string, isError = false): ToolResult {
    return {
        content: [{ type: 'text', text }],
        ...(isError ? { isError: true } : {}),
    };
}

/** Render a `RunResult` as the JSON an agent reads (formatted logs + value/error/notices). */
function formatRunResult(r: RunResult): string {
    const view = buildRunView(r);
    return JSON.stringify(
        {
            ok: !r.error,
            durationMs: r.durationMs,
            logs: view.logs,
            value: r.value ?? null,
            error: r.error
                ? {
                      name: r.error.name,
                      message: r.error.message,
                      phase: r.error.phase,
                      reason: r.error.reason ?? null,
                  }
                : null,
            notices: view.notices,
        },
        null,
        2,
    );
}

/**
 * Build the sandbox MCP server: core's server (run_stitch + list_stitches +
 * initialize/ping) with `run_in_sandbox` layered on top. Zero core changes.
 */
export function createSandboxMcp(
    registry: StitchRegistry,
    info: McpServerInfo = {},
): McpServer {
    const inner = createMcpServer(registry, {
        name: info.name ?? 'stitchapi-sandbox',
        ...(info.version !== undefined ? { version: info.version } : {}),
    });

    async function callRunInSandbox(args: unknown): Promise<ToolResult> {
        const a = (args ?? {}) as { code?: unknown; timeoutMs?: unknown };
        if (typeof a.code !== 'string')
            return textResult('run_in_sandbox requires a string "code"', true);
        const result = await runInSandbox(
            a.code,
            typeof a.timeoutMs === 'number' ? { timeoutMs: a.timeoutMs } : {},
        );
        return textResult(formatRunResult(result), Boolean(result.error));
    }

    return {
        async handle(message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
            const id = message.id ?? null;

            // Advertise run_in_sandbox alongside core's tools.
            if (message.method === 'tools/list') {
                const innerResp = await inner.handle(message);
                const tools =
                    ((innerResp?.result as { tools?: unknown[] } | undefined)
                        ?.tools as unknown[]) ?? [];
                return {
                    jsonrpc: '2.0',
                    id,
                    result: { tools: [...tools, RUN_IN_SANDBOX_TOOL] },
                };
            }

            // Route our tool; delegate everything else to core's server.
            if (message.method === 'tools/call') {
                const p = (message.params ?? {}) as {
                    name?: unknown;
                    arguments?: unknown;
                };
                if (p.name === 'run_in_sandbox') {
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: await callRunInSandbox(p.arguments),
                    };
                }
            }

            return inner.handle(message);
        },
    };
}

export interface SandboxStdioOptions {
    input?: Readable;
    output?: Writable;
    info?: McpServerInfo;
}

/**
 * Wire a sandbox MCP server to the stdio transport: newline-delimited JSON-RPC in,
 * newline-delimited responses out, processed in order. Mirrors core's `serveStdio`
 * (which builds its own server, so it can't take our wrapped one).
 */
export function runSandboxStdio(
    registry: StitchRegistry,
    opts: SandboxStdioOptions = {},
): { server: McpServer; close: () => void } {
    const server = createSandboxMcp(registry, opts.info ?? {});
    const input = opts.input ?? process.stdin;
    const output = opts.output ?? process.stdout;
    input.setEncoding('utf8');

    let buffer = '';
    let chain: Promise<void> = Promise.resolve();

    const dispatch = async (line: string): Promise<void> => {
        let message: JsonRpcMessage;
        try {
            message = JSON.parse(line) as JsonRpcMessage;
        } catch {
            output.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`,
            );
            return;
        }
        const response = await server.handle(message);
        if (response) output.write(`${JSON.stringify(response)}\n`);
    };

    const onData = (chunk: string): void => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) chain = chain.then(() => dispatch(line));
        }
    };

    input.on('data', onData);
    return { server, close: () => input.off('data', onData) };
}
