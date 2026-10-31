// Set the trace file before importing ../src so the JSONL sink is captured/quiet.
import { stitch } from '../src';
import { apiKey, bearer } from '../src/auth';
import { createMcpServer, serveStdio } from '../src/mcp';
import type { JsonRpcMessage } from '../src/mcp';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';
import { asValidator } from './support/schema';

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { z } from 'zod';

// The canonical version, read straight from package.json on disk (NOT the build-time
// `__PKG_VERSION__` define) so this asserts the reported version actually tracks the
// published release rather than testing the define against itself. vitest runs with
// packages/core as the cwd.
const PKG_VERSION = (
    JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
        version: string;
    }
).version;

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-mcp-${process.pid}.jsonl`,
);

// Minimal shapes for reading into the JSON-RPC results in assertions.
interface ToolListResult {
    tools: {
        name: string;
        description: string;
        inputSchema: unknown;
        annotations?: Record<string, boolean>;
    }[];
}
interface ToolCallResult {
    content: { type: string; text: string }[];
    isError?: boolean;
}

let api: MockServer;
let server: ReturnType<typeof createMcpServer>;

beforeAll(async () => {
    api = await startMockServer();
});
afterAll(async () => {
    await api.close();
});
beforeEach(() => {
    api.reset();
    const getWidget = stitch({
        baseUrl: api.url,
        path: '/widgets/{id}',
        pick: 'data',
        auth: bearer('s3cr3t-token'),
        retry: { attempts: 3 },
        timeout: { each: 1000 },
        input: { params: asValidator(z.object({ id: z.number() })) },
        output: asValidator(z.object({ id: z.number() })),
    });
    const ping = stitch({ baseUrl: api.url, path: '/ping' });
    server = createMcpServer({ getWidget, ping });
});

const req = (
    method: string,
    params?: unknown,
    id: number | string = 1,
): JsonRpcMessage => ({ jsonrpc: '2.0', id, method, params });

// ---- the JSON-RPC core ----------------------------------------------------

test('initialize advertises tools capability and server info', async () => {
    const res = await server.handle(
        req('initialize', { protocolVersion: 'x' }),
    );
    const result = res?.result as {
        protocolVersion: string;
        capabilities: { tools?: unknown };
        serverInfo: { name: string; version: string };
    };
    expect(result.protocolVersion).toBe('x'); // echoes the client's version
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe('stitchapi');
    // The reported version is derived from package.json at build time, so it can
    // never drift from the published release (the bug this guards against).
    expect(result.serverInfo.version).toBe(PKG_VERSION);
});

test('an explicit server.version overrides the derived package version', async () => {
    const custom = createMcpServer({}, { version: '9.9.9-custom' });
    const res = await custom.handle(
        req('initialize', { protocolVersion: 'x' }),
    );
    const result = res?.result as { serverInfo: { version: string } };
    expect(result.serverInfo.version).toBe('9.9.9-custom');
    expect(result.serverInfo.version).not.toBe(PKG_VERSION);
});

test('a bare string is shorthand for the server name (P14)', async () => {
    const named = createMcpServer({}, 'orders-api');
    const res = await named.handle(req('initialize', { protocolVersion: 'x' }));
    const result = res?.result as {
        serverInfo: { name: string; version: string };
    };
    expect(result.serverInfo.name).toBe('orders-api');
    // The shorthand names ONLY the dominant field — version stays the derived default.
    expect(result.serverInfo.version).toBe(PKG_VERSION);
});

test('tools/list returns the single code-mode tool (+ discovery + describe)', async () => {
    const res = await server.handle(req('tools/list'));
    const result = res?.result as ToolListResult;
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('run_stitch');
    expect(names).toContain('list_stitches');
    expect(names).toContain('describe_stitch');
    // run_stitch is { name, input } — not one tool per endpoint
    const runStitch = result.tools.find((t) => t.name === 'run_stitch')!;
    expect(runStitch.inputSchema).toMatchObject({
        type: 'object',
        required: ['name'],
    });
});

test('tools/call run_stitch maps input and returns the validated result', async () => {
    api.route('GET', '/widgets/7', { body: { data: { id: 7 } } });
    const res = await server.handle(
        req('tools/call', {
            name: 'run_stitch',
            arguments: { name: 'getWidget', input: { params: { id: 7 } } },
        }),
    );
    const result = res?.result as ToolCallResult;
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ id: 7 });
    expect(api.callCount('/widgets/7')).toBe(1);
});

test('run_stitch drops an agent-injected header when the stitch declares no input.headers schema', async () => {
    let seen: Record<string, string> = {};
    const op = stitch({
        url: 'https://x.test/op',
        adapter: (request) => {
            seen = request.headers;
            return Promise.resolve({
                status: 200,
                headers: {},
                body: { ok: true },
            });
        },
    });
    const mcp = createMcpServer({ op });
    const res = await mcp.handle(
        req('tools/call', {
            name: 'run_stitch',
            arguments: {
                name: 'op',
                input: { headers: { authorization: 'Bearer INJECTED' } },
            },
        }),
    );
    expect((res?.result as ToolCallResult).isError).toBeFalsy();
    // Header injection is blocked: the agent-supplied `authorization` never reached the transport,
    // because the stitch declares no `input.headers` schema, so that slot is not forwarded.
    expect(seen['authorization']).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain('INJECTED');
});

// Issue #648 on the surface where it bit hardest: `run_stitch` forwards a MODEL's argument object,
// so the keys a stitch never declared are keys nobody wrote. Nothing here is MCP-specific — the
// filtering happens in the engine, for every caller — but this is the call site that made a
// validating-but-not-filtering `input` schema a security property rather than a surprise.
test('run_stitch cannot smuggle an undeclared query key past a declared input.query schema', async () => {
    let url = '';
    const search = stitch({
        // `?tenant=acme` is pinned in the endpoint, and a predefined query pair is a DEFAULT that
        // caller input overrides — so before the fix a model could name another tenant.
        url: 'https://x.test/search?tenant=acme',
        input: { query: asValidator(z.object({ q: z.string() })) },
        adapter: (request) => {
            url = request.url;
            return Promise.resolve({
                status: 200,
                headers: {},
                body: { ok: true },
            });
        },
    });
    const mcp = createMcpServer({ search });
    const res = await mcp.handle(
        req('tools/call', {
            name: 'run_stitch',
            arguments: {
                name: 'search',
                input: { query: { q: 'widgets', tenant: 'globex' } },
            },
        }),
    );
    expect((res?.result as ToolCallResult).isError).toBeFalsy();
    expect(url).toContain('tenant=acme');
    expect(url).not.toContain('globex');
});

test('tools/call run_stitch on an unknown stitch is a tool error, not a crash', async () => {
    const res = await server.handle(
        req('tools/call', { name: 'run_stitch', arguments: { name: 'nope' } }),
    );
    const result = res?.result as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unknown stitch "nope"');
});

test('tools/call list_stitches enumerates name/method/path', async () => {
    const res = await server.handle(
        req('tools/call', { name: 'list_stitches' }),
    );
    const result = res?.result as ToolCallResult;
    const list = JSON.parse(result.content[0]!.text) as {
        name: string;
        method: string;
        path: string;
    }[];
    expect(list.map((s) => s.name)).toEqual(['getWidget', 'ping']);
    expect(list[0]).toMatchObject({ method: 'GET', path: '/widgets/{id}' });
});

// A literal query in `path` is the operator's pinned default and can be a credential
// (`/v1/{id}?sig=tok`); `describe_stitch` scrubs the same text, so the discovery tool must not
// hand it over. The cut is brace-aware: a `{?limit}` operator is template, not a query.
test('list_stitches returns the path template without a literal query', async () => {
    const mcp = createMcpServer({
        pinned: stitch({
            baseUrl: 'https://api.vendor.test',
            path: '/v1/{id}?sig=tok_live_123&page=2',
        }),
        templated: stitch({
            baseUrl: 'https://api.vendor.test',
            path: '/v1/items{?limit,offset}',
        }),
        plain: stitch({ baseUrl: 'https://api.vendor.test', path: '/v1/x' }),
    });
    const res = await mcp.handle(req('tools/call', { name: 'list_stitches' }));
    const text = (res?.result as ToolCallResult).content[0]!.text;
    expect(text).not.toContain('tok_live_123');
    expect(text).not.toContain('page=2');
    const list = JSON.parse(text) as { name: string; path: string }[];
    expect(Object.fromEntries(list.map((s) => [s.name, s.path]))).toEqual({
        pinned: '/v1/{id}',
        templated: '/v1/items{?limit,offset}',
        plain: '/v1/x',
    });
});

test('tools/call describe_stitch teaches a stitch shape without running it', async () => {
    const res = await server.handle(
        req('tools/call', {
            name: 'describe_stitch',
            arguments: { name: 'getWidget' },
        }),
    );
    const result = res?.result as ToolCallResult;
    expect(result.isError).toBeFalsy();
    const shape = JSON.parse(result.content[0]!.text) as {
        name: string;
        endpoint: string;
        surface: string;
        input: { params: boolean; query: boolean; body: boolean };
        output: { validated: boolean; pick: string | null };
        auth: string | null;
        policies: Record<string, boolean>;
        pipeline: string[];
        diagram: string;
    };
    // endpoint + per-slot input presence (params declared, the rest not)
    expect(shape.endpoint).toContain('GET ');
    expect(shape.endpoint).toContain('/widgets/{id}');
    expect(shape.surface).toBe('http');
    expect(shape.input).toMatchObject({
        params: true,
        query: false,
        body: false,
    });
    expect(shape.output).toMatchObject({ validated: true, pick: 'data' });
    // the pipeline lists stages in engine order: the engine picks THEN validates, so the
    // 'pick' stage must precede 'validate' (not the reverse).
    expect(shape.pipeline.indexOf('pick: data')).toBeGreaterThanOrEqual(0);
    expect(shape.pipeline.indexOf('pick: data')).toBeLessThan(
        shape.pipeline.indexOf('validate'),
    );
    // a Mermaid flowchart string is included for the diagram view
    expect(shape.diagram).toContain('flowchart');
    // policies reflect the configured retry/timeout (no throttle/cache)
    expect(shape.policies).toMatchObject({
        retry: true,
        timeout: true,
        throttle: false,
        cache: false,
    });
    // the NON-secret auth scheme tag is reported, never the credential
    expect(shape.auth).toBe('bearer');
    expect(result.content[0]!.text).not.toContain('s3cr3t-token');
    expect(result.content[0]!.text).not.toContain('Bearer');
});

test('tools/call describe_stitch on an unknown stitch is a tool error, not a crash', async () => {
    const res = await server.handle(
        req('tools/call', {
            name: 'describe_stitch',
            arguments: { name: 'nope' },
        }),
    );
    const result = res?.result as ToolCallResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unknown stitch "nope"');
});

test('an unknown tool is a tool error', async () => {
    const res = await server.handle(
        req('tools/call', { name: 'destroy_everything' }),
    );
    expect((res?.result as ToolCallResult).isError).toBe(true);
});

test('a notification (no id) gets no response', async () => {
    const res = await server.handle({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
    });
    expect(res).toBeNull();
});

test('an unknown method (with id) is JSON-RPC error -32601', async () => {
    const res = await server.handle(req('does/not/exist'));
    expect(res?.error?.code).toBe(-32601);
});

// ---- tool annotations (#866) ----------------------------------------------

test('tools/list annotates each tool so a host can decide whether to ask a human', async () => {
    const res = await server.handle(req('tools/list'));
    const tools = (res?.result as ToolListResult).tools;
    const annotations = Object.fromEntries(
        tools.map((t) => [t.name, t.annotations]),
    );
    // The two discovery tools read the in-process registry and make no request.
    expect(annotations['list_stitches']).toEqual({
        readOnlyHint: true,
        openWorldHint: false,
    });
    expect(annotations['describe_stitch']).toEqual({
        readOnlyHint: true,
        openWorldHint: false,
    });
    // run_stitch fronts every registered stitch — a write included — so it promises nothing it
    // cannot promise for all of them, and says so explicitly rather than leaning on spec defaults.
    expect(annotations['run_stitch']).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
    });
});

// ---- error text crossing the boundary (#866) -------------------------------

describe('error text that crosses the MCP boundary is URL-scrubbed (#866)', () => {
    const KEY = 'ak_live_qry_8899aabbccddeeff';

    const runText = async (
        registry: Parameters<typeof createMcpServer>[0],
        name: string,
    ): Promise<string> => {
        const res = await createMcpServer(registry).handle(
            req('tools/call', { name: 'run_stitch', arguments: { name } }),
        );
        const result = res?.result as ToolCallResult;
        expect(result.isError).toBe(true);
        return result.content[0]!.text;
    };

    // The audit's reproduction, on the DEFAULT fetch adapter and zero lines of user code: a port the
    // URL parser rejects makes the transport quote the whole request URL — key included.
    test('apiKey({ in: "query" }) + a transport failure never puts the key in the tool result', async () => {
        const metrics = stitch({
            url: 'http://api.vendor.test:99999/v1/metrics',
            auth: apiKey({ in: 'query', secret: KEY }),
        });
        const text = await runText({ metrics }, 'metrics');
        expect(text).toContain('Failed to parse URL'); // still a useful message…
        expect(text).toContain('api.vendor.test:99999/v1/metrics');
        expect(text).toContain('api_key=REDACTED'); // …that names the parameter, not its value
        expect(text).not.toContain(KEY);
    });

    // The node-fetch shape: a routine DNS failure, on a URL the parser accepts. A vendor-spelled
    // param name is caught because `apiKey` registers its `name` with the scrubber.
    test('a parseable URL in an adapter error is scrubbed too, under a custom param name', async () => {
        const metrics = stitch({
            url: 'https://api.vendor.test/v1/metrics?page=2',
            auth: apiKey({ in: 'query', name: 'vk', secret: KEY }),
            adapter: (request) =>
                Promise.reject(
                    new Error(
                        `request to ${request.url} failed, reason: getaddrinfo ENOTFOUND api.vendor.test`,
                    ),
                ),
        });
        const text = await runText({ metrics }, 'metrics');
        expect(text).toContain('getaddrinfo ENOTFOUND');
        expect(text).toContain('page=2'); // a benign param survives for diagnosis
        expect(text).toContain('vk=REDACTED');
        expect(text).not.toContain(KEY);
    });

    test('URL userinfo is stripped, and a non-Error throw still reaches the model as text', async () => {
        const leaky = stitch({
            url: 'https://x.test/a',
            adapter: () =>
                Promise.reject(
                    new Error(
                        'upstream https://svc:hunter2@db.internal.test/q?access_token=tkn failed',
                    ),
                ),
        });
        const thrower = stitch({
            url: 'https://x.test/b',
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
            adapter: () => Promise.reject('plain string thrown'),
        });
        const text = await runText({ leaky }, 'leaky');
        expect(text).toContain('db.internal.test');
        expect(text).not.toContain('hunter2');
        expect(text).not.toContain('tkn');
        expect(await runText({ thrower }, 'thrower')).toContain(
            'plain string thrown',
        );
    });
});

// ---- name resolution (#866, part of #863) -----------------------------------

describe('a stitch is callable only under a key the listing shows (#866)', () => {
    const callTool = async (
        mcp: ReturnType<typeof createMcpServer>,
        tool: 'run_stitch' | 'describe_stitch',
        name: string,
    ): Promise<ToolCallResult> => {
        const res = await mcp.handle(
            req('tools/call', { name: tool, arguments: { name } }),
        );
        return res?.result as ToolCallResult;
    };

    test.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
        'the inherited key %s is an unknown stitch on both tools',
        async (name) => {
            for (const tool of ['run_stitch', 'describe_stitch'] as const) {
                const result = await callTool(server, tool, name);
                expect(result.isError).toBe(true);
                expect(result.content[0]!.text).toContain(
                    `unknown stitch "${name}". Available: getWidget, ping`,
                );
            }
        },
    );

    test('a stitch renamed in the registry no longer answers to its configured name', async () => {
        let calls = 0;
        const refund = stitch({
            name: 'issueRefund',
            url: 'https://x.test/v1/refunds',
            method: 'POST',
            adapter: () => {
                calls++;
                return Promise.resolve({ status: 200, headers: {}, body: {} });
            },
        });
        // The operator exposes it under another key — the listing shows only that key…
        const mcp = createMcpServer({ approvedRefund: refund });
        const listing = (
            await mcp.handle(req('tools/call', { name: 'list_stitches' }))
        )?.result as ToolCallResult;
        const listed = JSON.parse(listing.content[0]!.text) as {
            name: string;
        }[];
        expect(listed.map((s) => s.name)).toEqual(['approvedRefund']);
        // …and the configured name is not a second, unlisted address.
        for (const tool of ['run_stitch', 'describe_stitch'] as const) {
            const result = await callTool(mcp, tool, 'issueRefund');
            expect(result.isError).toBe(true);
            expect(result.content[0]!.text).toContain(
                'unknown stitch "issueRefund". Available: approvedRefund',
            );
        }
        expect(calls).toBe(0);
        // The listed key works.
        expect(
            (await callTool(mcp, 'run_stitch', 'approvedRefund')).isError,
        ).toBeFalsy();
        expect(calls).toBe(1);
    });

    test("describe_stitch's diagram draws only the stitch it resolved", async () => {
        const hidden = stitch({ name: 'shown', url: 'https://x.test/hidden' });
        const shown = stitch({ url: 'https://x.test/shown' });
        const result = await callTool(
            createMcpServer({ hidden, shown }),
            'describe_stitch',
            'shown',
        );
        const { diagram } = JSON.parse(result.content[0]!.text) as {
            diagram: string;
        };
        expect(diagram).toContain('/shown');
        expect(diagram).not.toContain('/hidden');
    });
});

// ---- the stdio transport --------------------------------------------------

function nextMessage(output: Readable): Promise<JsonRpcMessage> {
    return new Promise((resolve) => {
        let buf = '';
        const on = (c: string) => {
            buf += c;
            const nl = buf.indexOf('\n');
            if (nl >= 0) {
                output.off('data', on);
                resolve(JSON.parse(buf.slice(0, nl)) as JsonRpcMessage);
            }
        };
        output.on('data', on);
    });
}

test('serveStdio speaks newline-delimited JSON-RPC (tools/list)', async () => {
    const ping = stitch({ baseUrl: api.url, path: '/ping' });
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding('utf8');
    const { close } = serveStdio({ ping }, { stdin: input, stdout: output });
    try {
        const pending = nextMessage(output);
        input.write(`${JSON.stringify(req('tools/list'))}\n`);
        const res = await pending;
        expect(
            (res.result as ToolListResult).tools.map((t) => t.name),
        ).toContain('run_stitch');
    } finally {
        await close();
    }
});

test('a run_stitch call over stdio returns the result', async () => {
    api.route('GET', '/ping', { body: { ok: true } });
    const ping = stitch({ baseUrl: api.url, path: '/ping' });
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding('utf8');
    const { close } = serveStdio({ ping }, { stdin: input, stdout: output });
    try {
        const pending = nextMessage(output);
        input.write(
            `${JSON.stringify(
                req('tools/call', {
                    name: 'run_stitch',
                    arguments: { name: 'ping' },
                }),
            )}\n`,
        );
        const res = await pending;
        const result = res.result as ToolCallResult;
        expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: true });
    } finally {
        await close();
    }
});
