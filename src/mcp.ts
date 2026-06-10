// `stitch mcp` — expose stitches to agents over MCP (DESIGN.md §10).
//
// Code-mode: a single `run_stitch` tool ({ name, input }) instead of one tool per
// endpoint, so the agent's tool list — and its context — stays tiny no matter how many
// stitches you register. A `list_stitches` discovery tool lets the agent enumerate
// what's available. The JSON-RPC core of MCP is implemented by hand over the stdio
// transport (newline-delimited JSON), with no SDK — consistent with the library's
// zero-dependency stance. `handle()` is transport-agnostic, so the same core can back a
// Streamable HTTP transport too (see the `serve` surface for the HTTP pattern).
import { type StitchRegistry, selectStitch } from './registry';
import type { Stitch, StitchInput } from './types';

import type { Readable, Writable } from 'node:stream';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'stitchapi';
const SERVER_VERSION = '0.7.0';

export interface JsonRpcMessage {
    jsonrpc: '2.0';
    id?: string | number | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

interface ToolResult {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}

const RUN_STITCH_TOOL = {
    name: 'run_stitch',
    description:
        'Run a named stitch and return its validated result. Code-mode: this one ' +
        'tool covers every registered endpoint — pass { name, input } where input is ' +
        '{ params?, query?, body?, headers? }. Use list_stitches to discover names.',
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'The stitch to run.' },
            input: {
                type: 'object',
                description: 'The stitch input object.',
                properties: {
                    params: { type: 'object' },
                    query: { type: 'object' },
                    body: {},
                    headers: { type: 'object' },
                },
            },
        },
        required: ['name'],
    },
} as const;

const LIST_STITCHES_TOOL = {
    name: 'list_stitches',
    description:
        'List the stitches this server exposes (name, method, path) so you know what ' +
        'to pass to run_stitch.',
    inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
    },
} as const;

function textResult(value: unknown): ToolResult {
    const text =
        typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return { content: [{ type: 'text', text }] };
}
function errorResult(message: string): ToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

function pickProtocol(params: unknown): string {
    const v = (params as { protocolVersion?: unknown } | undefined)
        ?.protocolVersion;
    return typeof v === 'string' ? v : PROTOCOL_VERSION;
}

export interface McpServer {
    handle(message: JsonRpcMessage): Promise<JsonRpcMessage | null>;
}

export interface McpServerInfo {
    name?: string;
    version?: string;
}

// Build an MCP server over a stitch registry. `handle()` maps one JSON-RPC message to
// its response (or null for notifications), independent of any transport.
export function createMcpServer(
    registry: StitchRegistry,
    info: McpServerInfo = {},
): McpServer {
    const serverInfo = {
        name: info.name ?? SERVER_NAME,
        version: info.version ?? SERVER_VERSION,
    };

    async function callRunStitch(args: unknown): Promise<ToolResult> {
        const a = (args ?? {}) as { name?: unknown; input?: unknown };
        if (typeof a.name !== 'string')
            return errorResult('run_stitch requires a string "name"');
        let stitch: Stitch;
        try {
            stitch = selectStitch(registry, a.name);
        } catch (e) {
            return errorResult((e as Error).message);
        }
        try {
            const value = await stitch((a.input ?? {}) as StitchInput);
            return textResult(value);
        } catch (e) {
            return errorResult((e as Error).message);
        }
    }

    function callListStitches(): ToolResult {
        const list = Object.keys(registry)
            .sort()
            .map((name) => {
                const cfg = registry[name].__config;
                return {
                    name,
                    method: (cfg.method ?? 'GET').toUpperCase(),
                    path: cfg.path ?? '',
                };
            });
        return textResult(list);
    }

    async function callTool(params: unknown): Promise<ToolResult> {
        const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
        if (p.name === 'run_stitch') return callRunStitch(p.arguments);
        if (p.name === 'list_stitches') return callListStitches();
        return errorResult(`unknown tool: ${String(p.name)}`);
    }

    return {
        async handle(message) {
            const { id, method, params } = message;
            const reply = (result: unknown): JsonRpcMessage => ({
                jsonrpc: '2.0',
                id: id ?? null,
                result,
            });
            const fail = (code: number, msg: string): JsonRpcMessage => ({
                jsonrpc: '2.0',
                id: id ?? null,
                error: { code, message: msg },
            });

            switch (method) {
                case 'initialize':
                    return reply({
                        protocolVersion: pickProtocol(params),
                        capabilities: { tools: { listChanged: false } },
                        serverInfo,
                    });
                case 'ping':
                    return reply({});
                case 'tools/list':
                    return reply({
                        tools: [RUN_STITCH_TOOL, LIST_STITCHES_TOOL],
                    });
                case 'tools/call':
                    return reply(await callTool(params));
                default:
                    // notifications (notifications/*) carry no id and expect no response
                    if (id === undefined || id === null) return null;
                    return fail(-32601, `method not found: ${method}`);
            }
        },
    };
}

export interface StdioOptions {
    input?: Readable;
    output?: Writable;
    info?: McpServerInfo;
}

// Wire an McpServer to the stdio transport: read newline-delimited JSON-RPC from
// `input`, write newline-delimited responses to `output`. Messages are processed in
// order. Returns a handle that detaches the listener.
export function serveStdio(
    registry: StitchRegistry,
    opts: StdioOptions = {},
): { server: McpServer; close: () => void } {
    const server = createMcpServer(registry, opts.info);
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
