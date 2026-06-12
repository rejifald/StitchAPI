// `stitch serve` — a thin local HTTP front door (DESIGN.md §10) for remote and
// other-language callers. Registered stitches are exposed as:
//
//   GET  /                     → list available stitch names
//   POST /stitch/:name         → run the stitch; request body (JSON) is the input
//
// With `Accept: text/event-stream` (or `?stream=1`) the response is the live event
// stream as SSE; otherwise the final validated result is returned as JSON. Reuses the
// engine through `stitch.stream()` — no framework, no new dependencies.
import { type StitchRegistry, selectStitch } from './registry';
import type { StitchEvent, StitchInput } from './types';

import {
    type IncomingMessage,
    type Server,
    type ServerResponse,
    createServer,
} from 'node:http';

export interface ServeOptions {
    port?: number; // default 8787; 0 picks an ephemeral port
    host?: string; // default 127.0.0.1
}

export interface ServeHandle {
    url: string;
    port: number;
    server: Server;
    close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let data = '';
        req.setEncoding('utf8');
        req.on('data', (c: string) => (data += c));
        req.on('end', () => {
            resolve(data);
        });
        req.on('error', reject);
    });
}

function parseInput(raw: string): StitchInput {
    if (!raw.trim()) return {};
    return JSON.parse(raw) as StitchInput; // throws → caller responds 400
}

const wantsSse = (req: IncomingMessage, url: URL): boolean =>
    (req.headers.accept ?? '').includes('text/event-stream') ||
    url.searchParams.get('stream') === '1';

// Stream every event as SSE: `event: <type>` + a JSON `data:` line per event.
async function streamSse(
    res: ServerResponse,
    stream: AsyncIterable<StitchEvent>,
): Promise<void> {
    res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
    });
    try {
        for await (const ev of stream)
            res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    } catch (e) {
        res.write(
            `event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`,
        );
    } finally {
        res.end();
    }
}

// Consume the stream and return the final result as JSON (or a leveled error).
async function runJson(
    res: ServerResponse,
    stream: AsyncIterable<StitchEvent>,
): Promise<void> {
    let value: unknown;
    let failure: { message: string; status?: number } | undefined;
    for await (const ev of stream) {
        if (ev.type === 'result') value = ev.value;
        else if (ev.type === 'error') {
            failure = { message: ev.message };
            if (ev.status !== undefined) failure.status = ev.status;
        }
    }
    if (failure) {
        const status =
            failure.status && failure.status >= 400 ? failure.status : 502;
        sendJson(res, status, {
            error: failure.message,
            status: failure.status,
        });
        return;
    }
    sendJson(res, 200, value ?? null);
}

// A framework-free request handler. Exposed so it can be mounted in an existing
// server or driven directly in tests.
export function createServeHandler(
    registry: StitchRegistry,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
    return async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const path = url.pathname;

        if (
            req.method === 'GET' &&
            (path === '/' || path === '/stitch' || path === '/stitch/')
        ) {
            sendJson(res, 200, { stitches: Object.keys(registry).sort() });
            return;
        }

        const match = /^\/stitch\/([^/]+)\/?$/.exec(path);
        if (!match) {
            sendJson(res, 404, { error: 'not_found' });
            return;
        }
        if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'method_not_allowed' });
            return;
        }

        const name = decodeURIComponent(match[1] ?? '');
        let stitch;
        try {
            stitch = selectStitch(registry, name);
        } catch (e) {
            sendJson(res, 404, { error: (e as Error).message });
            return;
        }

        let input: StitchInput;
        try {
            input = parseInput(await readBody(req));
        } catch {
            sendJson(res, 400, { error: 'invalid JSON body' });
            return;
        }

        const stream = stitch.stream(input) as AsyncIterable<StitchEvent>;
        if (wantsSse(req, url)) await streamSse(res, stream);
        else await runJson(res, stream);
    };
}

// Start a local server exposing the registry. `port: 0` (or the default 8787 taken)
// resolves to whatever port the OS assigned, reported on the handle.
export function serve(
    registry: StitchRegistry,
    opts: ServeOptions = {},
): Promise<ServeHandle> {
    const host = opts.host ?? '127.0.0.1';
    const handle = createServeHandler(registry);
    const server = createServer((req, res) => {
        handle(req, res).catch((e: unknown) => {
            if (!res.headersSent)
                res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: (e as Error).message }));
        });
    });

    return new Promise((resolve) => {
        server.listen(opts.port ?? 8787, host, () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            resolve({
                url: `http://${host}:${port}`,
                port,
                server,
                close: () =>
                    new Promise<void>((r) =>
                        server.close(() => {
                            r();
                        }),
                    ),
            });
        });
    });
}
