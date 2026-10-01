// serveStdio transport framing (src/mcp.ts). mcp.spec.ts proves serveStdio speaks newline-delimited
// JSON-RPC on the happy path; the transport's framing/edge branches go untested:
//   - a malformed line → a -32700 parse-error response (id null);
//   - several messages in one chunk are answered in order;
//   - a message split across chunks is buffered until its newline;
//   - blank / whitespace-only lines are skipped;
//   - close() detaches the listener (no further messages are processed), and is `async` — it
//     returns a promise, like every other `close()` on the surface (CONTRACT.md P11);
//   - one bad message never stalls the rest (#866): a throw inside a tool call, or a line that is
//     valid JSON but not a request, is answered, and the `ping` after it still is.
import { serveStdio } from '../src/mcp';
import type { JsonRpcMessage, StdioHandle } from '../src/mcp';
import type { StitchRegistry } from '../src/registry';

import { PassThrough } from 'node:stream';

let nextId = 0;
const req = (method: string): JsonRpcMessage => ({
    jsonrpc: '2.0',
    id: ++nextId,
    method,
});

function setup(
    registry: StitchRegistry = {},
): StdioHandle & { input: PassThrough; output: PassThrough } {
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding('utf8');
    const handle = serveStdio(registry, { stdin: input, stdout: output });
    return { ...handle, input, output };
}

// Resolve once `n` newline-delimited JSON messages have been written to `output`.
function collectLines(
    output: PassThrough,
    n: number,
): Promise<JsonRpcMessage[]> {
    return new Promise((resolve) => {
        const out: JsonRpcMessage[] = [];
        let buf = '';
        const onData = (chunk: string): void => {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
                out.push(JSON.parse(buf.slice(0, nl)) as JsonRpcMessage);
                buf = buf.slice(nl + 1);
                if (out.length === n) {
                    output.off('data', onData);
                    resolve(out);
                    return;
                }
            }
        };
        output.on('data', onData);
    });
}

const nextLine = async (output: PassThrough): Promise<JsonRpcMessage> =>
    (await collectLines(output, 1))[0]!;

describe('serveStdio transport framing', () => {
    test('a malformed line yields a -32700 parse error', async () => {
        const { input, output, close } = setup();
        try {
            const p = nextLine(output);
            input.write('not json\n');
            const res = await p;
            expect(res.id).toBeNull();
            expect(res.error?.code).toBe(-32700);
        } finally {
            await close();
        }
    });

    test('several messages in one chunk are answered in order', async () => {
        const { input, output, close } = setup();
        try {
            const r1 = req('tools/list');
            const r2 = req('tools/list');
            const p = collectLines(output, 2);
            input.write(`${JSON.stringify(r1)}\n${JSON.stringify(r2)}\n`);
            const [a, b] = await p;
            expect(a?.id).toBe(r1.id);
            expect(b?.id).toBe(r2.id);
        } finally {
            await close();
        }
    });

    test('a message split across chunks is buffered until its newline', async () => {
        const { input, output, close } = setup();
        try {
            const r = req('tools/list');
            const line = `${JSON.stringify(r)}\n`;
            const half = Math.floor(line.length / 2);
            const p = nextLine(output);
            input.write(line.slice(0, half));
            input.write(line.slice(half));
            const res = await p;
            expect(res.id).toBe(r.id);
            expect(res.result).toBeDefined();
        } finally {
            await close();
        }
    });

    test('blank / whitespace-only lines are skipped', async () => {
        const { input, output, close } = setup();
        try {
            const r = req('tools/list');
            const p = nextLine(output);
            input.write('\n   \n'); // ignored
            input.write(`${JSON.stringify(r)}\n`);
            const res = await p; // the first (and only) response is the real request's
            expect(res.id).toBe(r.id);
        } finally {
            await close();
        }
    });

    // P11 (async/sync signature parity): `close()` is `() => Promise<void>` everywhere on the
    // surface — `ServeHandle.close`, `StitchStore.close`, `Seam.close`, `PostMessageChannel.close`.
    // This one was the lone sync spelling, so a host awaiting a set of handles hit one that was not
    // a promise. The `StdioHandle` return type is exported for the same reason `ServeHandle` is.
    test('close() returns a promise, like every other close() on the surface (P11)', async () => {
        const { close } = setup();
        const closing: Promise<void> = close();
        expect(closing).toBeInstanceOf(Promise);
        await expect(closing).resolves.toBeUndefined();
    });

    test('the handle is the exported StdioHandle interface', () => {
        const handle: StdioHandle = setup();
        expect(typeof handle.server.handle).toBe('function');
        return handle.close();
    });

    test('close() detaches the listener — no further messages are processed', async () => {
        const { input, output, close } = setup();
        await close();
        let got = false;
        output.on('data', () => {
            got = true;
        });
        input.write(`${JSON.stringify(req('tools/list'))}\n`);
        await new Promise((r) => setTimeout(r, 30));
        expect(got).toBe(false);
    });
});

// #866 — every stdio message runs on ONE promise chain. A rejection out of `handle()` used to
// poison it: every later message (a `ping` included) went unanswered, and the unobserved rejection
// could take the process down under Node's default `--unhandled-rejections=throw`.
describe('one bad message never stalls the rest (#866)', () => {
    // A registry entry whose `__config` cannot be read. `describe_stitch` reads it outside any
    // other guard, so before the fix this throw escaped `callTool` and rejected `handle()`.
    const unreadable = (): StitchRegistry => {
        const fn = (): Promise<unknown> => Promise.resolve(null);
        Object.defineProperty(fn, '__config', {
            get(): never {
                throw new Error(
                    'config unreadable at https://ops:hunter2@internal.test/x?token=t0k3n',
                );
            },
        });
        return { broken: fn as unknown as StitchRegistry[string] };
    };

    test('a throw inside a tool call is a tool error, and the next ping still answers', async () => {
        const { input, output, close } = setup(unreadable());
        try {
            const call: JsonRpcMessage = {
                jsonrpc: '2.0',
                id: ++nextId,
                method: 'tools/call',
                params: {
                    name: 'describe_stitch',
                    arguments: { name: 'broken' },
                },
            };
            const ping = req('ping');
            const p = collectLines(output, 2);
            input.write(`${JSON.stringify(call)}\n${JSON.stringify(ping)}\n`);
            const [failed, pong] = await p;
            expect(failed?.id).toBe(call.id);
            const result = failed?.result as {
                content: { text: string }[];
                isError?: boolean;
            };
            expect(result.isError).toBe(true);
            // The error text crossed the boundary scrubbed, like every other one.
            expect(result.content[0]!.text).toContain('config unreadable');
            expect(result.content[0]!.text).not.toContain('hunter2');
            expect(result.content[0]!.text).not.toContain('t0k3n');
            expect(pong?.id).toBe(ping.id);
            expect(pong?.result).toEqual({});
        } finally {
            await close();
        }
    });

    test('valid JSON that is not a request is -32600, and the next ping still answers', async () => {
        const { input, output, close } = setup();
        try {
            const ping = req('ping');
            const p = collectLines(output, 4);
            // `null` used to throw on destructuring inside `handle()`.
            input.write(`null\n42\n[]\n${JSON.stringify(ping)}\n`);
            const [a, b, c, pong] = await p;
            for (const bad of [a, b, c]) {
                expect(bad?.id).toBeNull();
                expect(bad?.error?.code).toBe(-32600);
            }
            expect(pong?.id).toBe(ping.id);
            expect(pong?.result).toEqual({});
        } finally {
            await close();
        }
    });

    test('handle() resolves to a JSON-RPC error when even reading the message throws', async () => {
        const { server, close } = setup();
        try {
            const hostile = new Proxy(
                {},
                {
                    get() {
                        throw new Error('no reads');
                    },
                },
            ) as JsonRpcMessage;
            await expect(server.handle(hostile)).resolves.toMatchObject({
                id: null,
                error: { code: -32603, message: 'internal error' },
            });
        } finally {
            await close();
        }
    });
});
