// serveStdio transport framing (src/mcp.ts). mcp.spec.ts proves serveStdio speaks newline-delimited
// JSON-RPC on the happy path; the transport's framing/edge branches go untested:
//   - a malformed line → a -32700 parse-error response (id null);
//   - several messages in one chunk are answered in order;
//   - a message split across chunks is buffered until its newline;
//   - blank / whitespace-only lines are skipped;
//   - close() detaches the listener (no further messages are processed).
import { serveStdio } from '../src/mcp';
import type { JsonRpcMessage } from '../src/mcp';

import { PassThrough } from 'node:stream';

let nextId = 0;
const req = (method: string): JsonRpcMessage => ({
    jsonrpc: '2.0',
    id: ++nextId,
    method,
});

function setup(): {
    input: PassThrough;
    output: PassThrough;
    close: () => void;
} {
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding('utf8');
    const { close } = serveStdio({}, { stdin: input, stdout: output });
    return { input, output, close };
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
            close();
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
            close();
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
            close();
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
            close();
        }
    });

    test('close() detaches the listener — no further messages are processed', async () => {
        const { input, output, close } = setup();
        close();
        let got = false;
        output.on('data', () => {
            got = true;
        });
        input.write(`${JSON.stringify(req('tools/list'))}\n`);
        await new Promise((r) => setTimeout(r, 30));
        expect(got).toBe(false);
    });
});
