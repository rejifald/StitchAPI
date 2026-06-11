// Set the trace file before importing ../src so the JSONL sink is captured/quiet.
import { stitch } from '../src';
import { createMcpServer, serveStdio } from '../src/mcp';
import type { JsonRpcMessage } from '../src/mcp';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';
import { asValidator } from './support/schema';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { z } from 'zod';

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
        unwrap: 'data',
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
        serverInfo: { name: string };
    };
    expect(result.protocolVersion).toBe('x'); // echoes the client's version
    expect(result.capabilities.tools).toBeDefined();
    expect(result.serverInfo.name).toBe('stitchapi');
});

test('tools/list returns the single code-mode tool (+ discovery)', async () => {
    const res = await server.handle(req('tools/list'));
    const result = res?.result as ToolListResult;
    const names = result.tools.map((t) => t.name);
    expect(names).toContain('run_stitch');
    expect(names).toContain('list_stitches');
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
