// Set the trace file before importing ../src so the JSONL sink is captured/quiet.
import { bearer, stitch } from '../src';
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
    tools: { name: string; description: string; inputSchema: unknown }[];
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
        timeout: { perAttempt: 1000 },
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

test('an explicit info.version overrides the derived package version', async () => {
    const custom = createMcpServer({}, { version: '9.9.9-custom' });
    const res = await custom.handle(
        req('initialize', { protocolVersion: 'x' }),
    );
    const result = res?.result as { serverInfo: { version: string } };
    expect(result.serverInfo.version).toBe('9.9.9-custom');
    expect(result.serverInfo.version).not.toBe(PKG_VERSION);
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
    const { close } = serveStdio({ ping }, { input, output });
    try {
        const pending = nextMessage(output);
        input.write(`${JSON.stringify(req('tools/list'))}\n`);
        const res = await pending;
        expect(
            (res.result as ToolListResult).tools.map((t) => t.name),
        ).toContain('run_stitch');
    } finally {
        close();
    }
});

test('a run_stitch call over stdio returns the result', async () => {
    api.route('GET', '/ping', { body: { ok: true } });
    const ping = stitch({ baseUrl: api.url, path: '/ping' });
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding('utf8');
    const { close } = serveStdio({ ping }, { input, output });
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
        close();
    }
});
