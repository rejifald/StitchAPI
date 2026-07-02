// `stitch serve` — a thin local HTTP front door (DESIGN.md §10) for remote and
// other-language callers. Registered stitches are exposed as:
//
//   GET  /                     → list available stitch names
//   POST /stitch/:name         → run the stitch; request body (JSON) is the input
//
// With `Accept: text/event-stream` (or `?stream=1`) the response is the live event
// stream as SSE; otherwise the final validated result is returned as JSON. Reuses the
// engine through `stitch.stream()` — no framework, no new dependencies.
import { compact } from './compact';
import { type StitchRegistry, selectStitch } from './registry';
import { redactEventForTransport } from './trace';
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
    /**
     * Reject a request body larger than this many bytes with 413 (see
     * {@link MAX_REQUEST_BODY_BYTES}). `serve` is unauthenticated (loopback by default, but
     * `--host` lets an operator bind a wider interface), so this bounds the memory a single
     * request can buffer. Default {@link MAX_REQUEST_BODY_BYTES}.
     */
    maxBodyBytes?: number;
}

export interface ServeHandle {
    url: string;
    port: number;
    server: Server;
    close(): Promise<void>;
}

// Default request-body cap. `serve` is unauthenticated (loopback by default; DESIGN.md §10), but
// `cli.ts --host` lets an operator bind a wider interface, so an unbounded body would let a single
// large/slow POST buffer the whole payload into memory → OOM. A few MB comfortably fits any real
// stitch input (JSON params/query/headers/variables) while capping that exposure; the same 2 MB
// order of magnitude as trace's body-truncation scale (`DEFAULT_MAX_BODY_BYTES`). Override per
// server via {@link ServeOptions.maxBodyBytes}.
export const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

// Thrown by `readBody` when the body exceeds the cap; the handler maps it to 413.
class PayloadTooLargeError extends Error {
    constructor(readonly limit: number) {
        super(`request body exceeds ${limit} bytes`);
        this.name = 'PayloadTooLargeError';
    }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

// Read the request body, enforcing a byte cap. Rejects with a `PayloadTooLargeError` — before
// reading anything when `Content-Length` already declares an over-cap body, and mid-stream the
// moment the accumulated bytes cross the cap. We count bytes on the raw `Buffer` chunks (not
// decoded string length) so the cap is exact for multi-byte UTF-8, then decode once at the end.
//
// The up-front `Content-Length` rejection does NOT destroy the socket, so the handler's 413 still
// flushes to the client (destroying immediately would race the response away). The mid-stream
// rejection DOES `req.destroy()` — a chunked/`Content-Length`-lying sender must be cut off so it
// can't keep pushing bytes we'd otherwise buffer.
function readBody(
    req: IncomingMessage,
    limit: number = MAX_REQUEST_BODY_BYTES,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > limit) {
            reject(new PayloadTooLargeError(limit));
            return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer | string) => {
            // A live HTTP socket emits `Buffer` chunks; some mock streams emit strings. Normalize to
            // a `Buffer` so the byte count is exact (a decoded string's `.length` counts code units,
            // not bytes) and `Buffer.concat` always gets buffers.
            const buf = typeof c === 'string' ? Buffer.from(c, 'utf8') : c;
            size += buf.length;
            if (size > limit) {
                req.destroy();
                reject(new PayloadTooLargeError(limit));
                return;
            }
            chunks.push(buf);
        });
        req.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8'));
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
//
// Tears down on client disconnect. `res.write` on a dead socket returns `false` but never throws,
// so a `for await` loop alone would spin forever on an infinite stream after the client leaves,
// keeping the upstream open and accumulating chunks. Two things break that: the handler aborts the
// run's signal on `req`/`res` 'close' (so the engine cancels the in-flight call and the generator
// completes), and we iterate manually here — checking `writableEnded`/`destroyed` before each write
// and calling `iterator.return()` in `finally` to run the generator's cleanup, releasing the
// upstream. This mirrors the elysia/hono/fastify SSE bridges' `iterator.return()`-on-abort teardown.
async function streamSse(
    res: ServerResponse,
    stream: AsyncIterable<StitchEvent>,
): Promise<void> {
    res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
    });
    const iterator = stream[Symbol.asyncIterator]();
    try {
        while (!res.writableEnded && !res.destroyed) {
            const { value: ev, done } = await iterator.next();
            if (done) break;
            // `serve` is unauthenticated (loopback by default; DESIGN.md §10) and the SSE consumer
            // is remote, so scrub credential-bearing metadata a `start` frame would otherwise echo
            // — URL credentials and `authorization`/`cookie` headers — before it leaves the
            // process. The streamed `delta`/`result` payload is preserved (it is what the caller
            // asked for).
            res.write(
                `event: ${ev.type}\ndata: ${JSON.stringify(redactEventForTransport(ev))}\n\n`,
            );
        }
    } catch (e) {
        if (!res.writableEnded && !res.destroyed)
            res.write(
                `event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`,
            );
    } finally {
        // Release the upstream: runs the generator's `finally` (which aborts the in-flight call and
        // stops it reconnecting). Safe to call whether we finished, threw, or the client left.
        await iterator.return?.(undefined);
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
        if (ev.type === 'result') value = ev.data;
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
// server or driven directly in tests. `maxBodyBytes` caps the request body (413 past it);
// defaults to {@link MAX_REQUEST_BODY_BYTES}.
export function createServeHandler(
    registry: StitchRegistry,
    { maxBodyBytes = MAX_REQUEST_BODY_BYTES }: { maxBodyBytes?: number } = {},
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
            input = parseInput(await readBody(req, maxBodyBytes));
        } catch (e) {
            if (e instanceof PayloadTooLargeError) {
                sendJson(res, 413, { error: e.message });
                return;
            }
            sendJson(res, 400, { error: 'invalid JSON body' });
            return;
        }

        // Thread cancellation: if the client goes away (`req`/`res` 'close') abort the run so the
        // engine cancels the in-flight upstream call and stops reconnecting — otherwise an infinite
        // SSE stream would run forever, buffering chunks, for a caller that has already left.
        const controller = new AbortController();
        const onClose = (): void => controller.abort();
        req.on('close', onClose);
        res.on('close', onClose);
        try {
            const stream = stitch.stream({
                ...input,
                signal: controller.signal,
            }) as AsyncIterable<StitchEvent>;
            if (wantsSse(req, url)) await streamSse(res, stream);
            else await runJson(res, stream);
        } finally {
            req.off('close', onClose);
            res.off('close', onClose);
        }
    };
}

// Start a local server exposing the registry. `port: 0` (or the default 8787 taken)
// resolves to whatever port the OS assigned, reported on the handle.
export function serve(
    registry: StitchRegistry,
    opts: ServeOptions = {},
): Promise<ServeHandle> {
    const host = opts.host ?? '127.0.0.1';
    const handle = createServeHandler(
        registry,
        compact({ maxBodyBytes: opts.maxBodyBytes }),
    );
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
