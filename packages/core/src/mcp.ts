// `stitch mcp` — expose stitches to agents over MCP (DESIGN.md §10).
//
// Code-mode: a single `run_stitch` tool ({ name, input }) instead of one tool per
// endpoint, so the agent's tool list — and its context — stays tiny no matter how many
// stitches you register. A `list_stitches` discovery tool lets the agent enumerate
// what's available. The JSON-RPC core of MCP is implemented by hand over the stdio
// transport (newline-delimited JSON), with no SDK — consistent with the library's
// zero-dependency stance. `handle()` is transport-agnostic, so the same core can back a
// Streamable HTTP transport too (see the `serve` surface for the HTTP pattern).
import { endpointLabel, pipelineStages } from './config-summary';
import { toMermaid } from './diagram';
import { type StitchRegistry, selectStitch } from './registry';
import type { RedactedStitchConfig, Stitch, StitchInput } from './types';

import type { Readable, Writable } from 'node:stream';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'stitchapi';
// Derived at build time from packages/core/package.json `version` via an esbuild
// `define` (see tsup.config.ts / vitest.config.ts and src/version.d.ts), so the
// version the MCP server reports can never drift from the published release. An
// explicit `info.version` from the caller still wins (see `createMcpServer`).
const SERVER_VERSION = __PKG_VERSION__;

export interface JsonRpcMessage {
    jsonrpc: '2.0';
    id?: string | number | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

interface ToolResult {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

const RUN_STITCH_TOOL = {
    name: 'run_stitch',
    description:
        'Run a named stitch and return its validated result. Code-mode: this one ' +
        'tool covers every registered endpoint — pass { name, input } where input is ' +
        '{ params?, query?, body? } (and headers? only for a stitch that declares a headers ' +
        'schema). Use list_stitches to discover names and describe_stitch to learn a ' +
        "stitch's shape, schema, and diagram before running it.",
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

const DESCRIBE_STITCH_TOOL = {
    name: 'describe_stitch',
    description:
        "Describe a named stitch's shape WITHOUT running it: its endpoint, surface, per-slot " +
        'input presence, output (validated/unwrap), auth scheme (never the credential), the ' +
        'configured policies (retry/throttle/cache/timeout), the request pipeline in engine ' +
        'order, and a Mermaid flowchart. Call this to learn a stitch before run_stitch.',
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'The stitch to describe.' },
        },
        required: ['name'],
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

// The scheme TAG of a stitch's auth — never the credential. `authScheme` is the non-secret
// SecurityScheme redaction projects onto the redacted `__config` (the live `auth` is stripped).
// `http` reports its scheme (bearer/basic), other types report their `type`. No auth → null.
// (`endpointLabel` and `pipelineStages` — the engine-order stage list, terse for this teaching view —
// are shared with `diagram.ts` via ./config-summary.)
function authTagOf(cfg: RedactedStitchConfig): string | null {
    const scheme = cfg.authScheme;
    if (!scheme) return null;
    return scheme.type === 'http' ? scheme.scheme : scheme.type;
}

// Defense in depth: an MCP client is an untrusted agent, so `run_stitch` forwards only the input a
// stitch is built to accept. It NEVER lets an agent inject arbitrary request `headers` (a Cookie /
// Authorization override, a forged content-type, request smuggling) unless the stitch explicitly
// declares an `input.headers` schema — where those headers are validated like any other slot. The
// credential already stays server-side; this closes the one input slot that reaches the transport.
function sanitizeAgentInput(stitch: Stitch, input: unknown): StitchInput {
    if (!input || typeof input !== 'object') return {};
    const obj = { ...(input as StitchInput) };
    if (stitch.__config.input?.headers === undefined) delete obj.headers;
    return obj;
}

function pickProtocol(params: unknown): string {
    const v = (params as { protocolVersion?: unknown } | undefined)
        ?.protocolVersion;
    return typeof v === 'string' ? v : PROTOCOL_VERSION;
}

export interface McpServer {
    handle(message: JsonRpcMessage): Promise<JsonRpcMessage | null>;
}

export interface McpServerOptions {
    name?: string;
    version?: string;
}

// Build an MCP server over a stitch registry. `handle()` maps one JSON-RPC message to
// its response (or null for notifications), independent of any transport.
export function createMcpServer(
    registry: StitchRegistry,
    info: McpServerOptions = {},
): McpServer {
    const serverInfo = {
        name: info.name ?? SERVER_NAME,
        version: info.version ?? SERVER_VERSION,
    };

    async function callRunStitch(args: unknown): Promise<ToolResult> {
        const a = (args ?? {}) as { name?: unknown; input?: unknown };
        if (typeof a.name !== 'string')
            return errorResult(
                'run_stitch requires a string "name". ' +
                    'Call list_stitches to see the available names.',
            );
        let stitch: Stitch;
        try {
            stitch = selectStitch(registry, a.name);
        } catch (e) {
            return errorResult((e as Error).message);
        }
        try {
            const value = await stitch(sanitizeAgentInput(stitch, a.input));
            return textResult(value);
        } catch (e) {
            return errorResult((e as Error).message);
        }
    }

    function callListStitches(): ToolResult {
        const list = Object.keys(registry)
            .sort()
            .map((name) => {
                const cfg = registry[name]?.__config;
                return {
                    name,
                    method: (cfg?.method ?? 'GET').toUpperCase(),
                    path: cfg?.path ?? '',
                };
            });
        return textResult(list);
    }

    // Teach the agent a stitch's SHAPE — endpoint, surface, per-slot input, output, auth scheme,
    // policies, pipeline, diagram — purely from the redacted `__config` (never the live auth/store)
    // plus `toMermaid`. No request is made; the credential stays unreachable.
    function callDescribeStitch(args: unknown): ToolResult {
        const a = (args ?? {}) as { name?: unknown };
        if (typeof a.name !== 'string')
            return errorResult(
                'describe_stitch requires a string "name". ' +
                    'Call list_stitches to see the available names.',
            );
        let stitch: Stitch;
        try {
            stitch = selectStitch(registry, a.name);
        } catch (e) {
            return errorResult((e as Error).message);
        }
        const cfg = stitch.__config;
        const inputSlots = cfg.input ?? {};
        return textResult({
            name: a.name,
            endpoint: endpointLabel(cfg),
            surface: cfg.kind ?? 'http', // __config.kind is the surface id string
            input: {
                params: inputSlots.params !== undefined,
                query: inputSlots.query !== undefined,
                body: inputSlots.body !== undefined,
                headers: inputSlots.headers !== undefined,
            },
            output: {
                validated: cfg.output !== undefined,
                unwrap: cfg.unwrap ?? null,
            },
            auth: authTagOf(cfg),
            policies: {
                retry: cfg.retry !== undefined,
                throttle: cfg.throttle !== undefined,
                cache: cfg.cache !== undefined,
                timeout: cfg.timeout !== undefined,
            },
            pipeline: pipelineStages(cfg),
            diagram: toMermaid(registry, { name: a.name }).diagram,
        });
    }

    async function callTool(params: unknown): Promise<ToolResult> {
        const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
        if (p.name === 'run_stitch') return callRunStitch(p.arguments);
        if (p.name === 'list_stitches') return callListStitches();
        if (p.name === 'describe_stitch')
            return callDescribeStitch(p.arguments);
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
                        tools: [
                            RUN_STITCH_TOOL,
                            LIST_STITCHES_TOOL,
                            DESCRIBE_STITCH_TOOL,
                        ],
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
    info?: McpServerOptions;
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

// CONTRACT.md P3 — deprecated alias, removed at the 1.0 GA cut.
/** @deprecated Renamed to {@link McpServerOptions} (CONTRACT.md P3). Imported name kept until the 1.0 GA cut. */
export type McpServerInfo = McpServerOptions;
