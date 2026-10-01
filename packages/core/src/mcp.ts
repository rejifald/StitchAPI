// `stitch mcp` — expose stitches to agents over MCP (DESIGN.md §10).
//
// Code-mode: a single `run_stitch` tool ({ name, input }) instead of one tool per
// endpoint, so the agent's tool list — and its context — stays tiny no matter how many
// stitches you register. A `list_stitches` discovery tool lets the agent enumerate
// what's available. The JSON-RPC core of MCP is implemented by hand over the stdio
// transport (newline-delimited JSON), with no SDK — consistent with the library's
// zero-dependency stance. `handle()` is transport-agnostic, so the same core can back a
// Streamable HTTP transport too (see the `serve` surface for the HTTP pattern).
import { endpointLabel, pipelineStages, policySummary } from './config-summary';
import { toMermaid } from './diagram';
import { type StitchRegistry, selectStitch } from './registry';
import type {
    AtLeastOne,
    RedactedStitchConfig,
    Stitch,
    StitchInput,
} from './types';
import { envelope, scrubUrls, topLevelQueryIndex } from './util';

import type { Readable, Writable } from 'node:stream';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'stitchapi';
// Derived at build time from packages/core/package.json `version` via an esbuild
// `define` (see tsup.config.ts / vitest.config.ts and src/version.d.ts), so the
// version the MCP server reports can never drift from the published release. An
// explicit `server.version` from the caller still wins (see `createMcpServer`).
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
    // MCP tool annotations (spec 2025-06-18), the fields a host reads to decide whether to ask a
    // human before a call. Code-mode puts EVERY registered stitch behind this one name — a read and
    // a refund arrive as the same call — so it claims nothing it cannot promise for all of them:
    // not read-only, and `destructiveHint` stays at the spec's own default (`true`), set explicitly
    // so a host never has to know the default to land on the safe side. `openWorldHint: true`
    // because a stitch reaches an external system (a vendor API, a shell, an LLM).
    // `idempotentHint` is left to its default (`false`) for the same reason as `destructiveHint`.
    annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
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
    // Reads the in-process registry and makes no request: read-only, and a closed world.
    // (`destructiveHint`/`idempotentHint` only mean something when `readOnlyHint` is false.)
    annotations: { readOnlyHint: true, openWorldHint: false },
} as const;

const DESCRIBE_STITCH_TOOL = {
    name: 'describe_stitch',
    description:
        "Describe a named stitch's shape WITHOUT running it: its endpoint, surface, per-slot " +
        'input presence, output (validated/pick), auth scheme (never the credential), the ' +
        'configured policies (retry/throttle/cache/timeout), the request pipeline in engine ' +
        'order, and a Mermaid flowchart. Call this to learn a stitch before run_stitch.',
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'The stitch to describe.' },
        },
        required: ['name'],
    },
    // Built from the redacted `__config` alone, with no request made: read-only, closed world.
    annotations: { readOnlyHint: true, openWorldHint: false },
} as const;

function textResult(value: unknown): ToolResult {
    const text =
        typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return { content: [{ type: 'text', text }] };
}
// EVERY error text that crosses the MCP boundary goes through here, and is URL-scrubbed on the way:
// a message the transport wrote quotes the request URL verbatim (`Failed to parse URL from
// https://…?api_key=…`, `request to https://… failed, reason: getaddrinfo ENOTFOUND`), and with
// `apiKey({ in: 'query' })` that URL carries the credential. The model's context is the worst place
// for it — it flows into the model's output, its logs and every downstream tool. StitchAPI's own
// messages are request-free already; this closes the channel for the ones it did not write.
function errorResult(message: string): ToolResult {
    return {
        content: [{ type: 'text', text: scrubUrls(message) }],
        isError: true,
    };
}
// A caught value as a tool error. `throw 'x'` and `throw undefined` are legal JavaScript, so the
// message is read defensively rather than assumed to be an `Error`.
function failure(e: unknown): ToolResult {
    return errorResult(e instanceof Error ? e.message : String(e));
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

/**
 * Identity a server reports in its `initialize` result, mapped straight onto MCP's `serverInfo`
 * object (CONTRACT.md P22 — the field names are the standard's). `name` defaults to `stitchapi`
 * and `version` to the build-time package version, so naming the server is the only field a host
 * normally sets — hence the `server: 'orders-api'` shorthand at every slot that takes this.
 */
export interface McpServerOptions {
    name?: string;
    version?: string;
}

// Build an MCP server over a stitch registry. `handle()` maps one JSON-RPC message to
// its response (or null for notifications), independent of any transport. A bare string is
// shorthand for the dominant `name` field — `'orders-api'` ≡ `{ name: 'orders-api' }`
// (CONTRACT.md P14); the opaque `{}` is rejected (P20).
export function createMcpServer(
    registry: StitchRegistry,
    server?: string | AtLeastOne<McpServerOptions>,
): McpServer {
    const opts = envelope(server, 'name');
    const serverInfo = {
        name: opts?.name ?? SERVER_NAME,
        version: opts?.version ?? SERVER_VERSION,
    };

    async function callRunStitch(args: unknown): Promise<ToolResult> {
        const a = (args ?? {}) as { name?: unknown; input?: unknown };
        if (typeof a.name !== 'string')
            return errorResult(
                'run_stitch requires a string "name". ' +
                    'Call list_stitches to see the available names.',
            );
        try {
            const stitch = selectStitch(registry, a.name);
            const value = await stitch(sanitizeAgentInput(stitch, a.input));
            return textResult(value);
        } catch (e) {
            return failure(e);
        }
    }

    // `path` is the route TEMPLATE. A literal query written into it (`/v1/{id}?sig=tok`) is the
    // operator's pinned default, which can be a credential — `describe_stitch` scrubs the same text —
    // and the agent has no use for it to pick a stitch, so it is cut. The cut is brace-aware, as the
    // engine's is: a `{?limit}` operator is part of the template, not a query.
    function callListStitches(): ToolResult {
        const list = Object.keys(registry)
            .sort()
            .map((name) => {
                const cfg = registry[name]?.__config;
                const path = cfg?.path ?? '';
                const q = topLevelQueryIndex(path);
                return {
                    name,
                    method: (cfg?.method ?? 'GET').toUpperCase(),
                    path: q < 0 ? path : path.slice(0, q),
                };
            });
        return textResult(list);
    }

    // Teach the agent a stitch's SHAPE — endpoint, surface, per-slot input, output, auth scheme,
    // policies, pipeline, diagram — purely from the redacted `__config` (never the live auth/store)
    // plus `toMermaid`. No request is made; the credential stays unreachable. The three fields that
    // quote the endpoint are URL-scrubbed like an error text: a `baseUrl` with userinfo or a secret
    // query pair written into the configured URL is not the auth strategy's, so redaction keeps it.
    function callDescribeStitch(args: unknown): ToolResult {
        const a = (args ?? {}) as { name?: unknown };
        if (typeof a.name !== 'string')
            return errorResult(
                'describe_stitch requires a string "name". ' +
                    'Call list_stitches to see the available names.',
            );
        const stitch = selectStitch(registry, a.name);
        const cfg = stitch.__config;
        const inputSlots = cfg.input ?? {};
        return textResult({
            name: a.name,
            endpoint: scrubUrls(endpointLabel(cfg)),
            surface: cfg.kind ?? 'http', // __config.kind is the surface id string
            input: {
                params: inputSlots.params !== undefined,
                query: inputSlots.query !== undefined,
                body: inputSlots.body !== undefined,
                headers: inputSlots.headers !== undefined,
            },
            output: {
                validated: cfg.output !== undefined,
                pick: cfg.pick ?? null,
            },
            auth: authTagOf(cfg),
            policies: policySummary(cfg),
            pipeline: pipelineStages(cfg).map(scrubUrls),
            // A one-entry registry under the resolved key: `toMermaid`'s name filter must not
            // draw a different stitch that merely shares the name.
            diagram: scrubUrls(toMermaid({ [a.name]: stitch }).diagram),
        });
    }

    // A throw from any tool — an unknown stitch, a `__config` a describe cannot read, a result
    // `JSON.stringify` rejects — is a tool ERROR RESULT, never a rejection out of `handle()`.
    async function callTool(params: unknown): Promise<ToolResult> {
        try {
            const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
            if (p.name === 'run_stitch')
                return await callRunStitch(p.arguments);
            if (p.name === 'list_stitches') return callListStitches();
            if (p.name === 'describe_stitch')
                return callDescribeStitch(p.arguments);
            return errorResult(`unknown tool: ${String(p.name)}`);
        } catch (e) {
            return failure(e);
        }
    }

    // `handle()` never rejects. Over stdio the messages are processed on one promise chain, so a
    // rejection here would stall every later message (a `ping` included) and, unobserved, crash
    // the process under Node's default `--unhandled-rejections=throw`.
    async function respond(message: unknown): Promise<JsonRpcMessage | null> {
        // Typed `unknown`, not `JsonRpcMessage`: over stdio it is whatever `JSON.parse` returned,
        // and anything but an object — a line holding `null`, `42`, `[]` — is not a request.
        if (!message || typeof message !== 'object' || Array.isArray(message))
            return {
                jsonrpc: '2.0',
                id: null,
                error: { code: -32600, message: 'invalid request' },
            };
        const { id, method, params } = message as JsonRpcMessage;
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
    }

    return {
        async handle(message) {
            try {
                return await respond(message);
            } catch {
                // Defense in depth for a caller handing `handle()` an object whose reads throw
                // (a JSON-parsed stdio line cannot). The id is unreadable by then, so it is null,
                // and no detail crosses: an internal error's text is not the agent's business.
                return {
                    jsonrpc: '2.0',
                    id: null,
                    error: { code: -32603, message: 'internal error' },
                };
            }
        },
    };
}

export interface StdioOptions {
    /** The stream JSON-RPC messages are read from. Default `process.stdin`.
     *
     *  Spelled `stdin`, not `input`: `input` is the request **schema** slot everywhere else on the
     *  surface (`StitchConfig.input`, `InputSchemas`, postmessage's `RequestOptions`), and one word
     *  may not mean two things (CONTRACT.md P2). `stdin` is also what Node and the MCP SDK's
     *  `StdioServerTransport` call it, so P18 points the same way. */
    stdin?: Readable;
    /** The stream JSON-RPC responses are written to. Default `process.stdout`. See {@link
     *  StdioOptions.stdin} for why it is not `output`. */
    stdout?: Writable;
    /**
     * Identity this server reports (see {@link McpServerOptions}). A bare string is shorthand for
     * the name — `server: 'orders-api'` ≡ `server: { name: 'orders-api' }` (CONTRACT.md P14); the
     * opaque `server: {}` is rejected (P20).
     */
    server?: string | AtLeastOne<McpServerOptions>;
}

/**
 * What {@link serveStdio} returns. Exported — and a named interface rather than the anonymous
 * shape it used to be — for the same reason `ServeHandle` (`stitchapi/serve`) is: a host that
 * stores the handle on a field, or passes it on, needs to be able to name its type.
 */
export interface StdioHandle {
    /** The MCP server driving the transport — handy for dispatching a message directly in tests. */
    server: McpServer;
    /**
     * Detach the stdin listener. `() => Promise<void>`, like every other `close()` on the surface
     * (`ServeHandle.close`, `StitchStore.close`, `Seam.close`, `PostMessageChannel.close`) —
     * CONTRACT.md P11: one verb, one sync/async shape everywhere. This was the lone sync `close`
     * on the published API, so a host writing `await handle.close()` over a set of handles hit one
     * that was not a promise. Detaching is itself synchronous, so the returned promise is already
     * settled: awaiting it is the uniform spelling, never a wait.
     */
    close: () => Promise<void>;
}

// Wire an McpServer to the stdio transport: read newline-delimited JSON-RPC from
// `stdin`, write newline-delimited responses to `stdout`. Messages are processed in
// order. Returns a handle that detaches the listener.
export function serveStdio(
    registry: StitchRegistry,
    opts: StdioOptions = {},
): StdioHandle {
    const server = createMcpServer(registry, opts.server);
    const stdin = opts.stdin ?? process.stdin;
    const stdout = opts.stdout ?? process.stdout;
    stdin.setEncoding('utf8');

    let buffer = '';
    let chain: Promise<void> = Promise.resolve();

    const dispatch = async (line: string): Promise<void> => {
        let message: JsonRpcMessage;
        try {
            message = JSON.parse(line) as JsonRpcMessage;
        } catch {
            stdout.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`,
            );
            return;
        }
        const response = await server.handle(message);
        if (response) stdout.write(`${JSON.stringify(response)}\n`);
    };

    const onData = (chunk: string): void => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            // `handle()` never rejects, but a write to a closed `stdout` can throw: catch at the
            // link so one failed message never stalls the rest, or surfaces as an unhandled rejection.
            if (line)
                chain = chain.then(() => dispatch(line)).catch(() => undefined);
        }
    };

    stdin.on('data', onData);
    return {
        server,
        close: () => {
            stdin.off('data', onData);
            return Promise.resolve();
        },
    };
}
