import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

export interface ReqInfo {
    method: string;
    path: string;
    headers: Record<string, string>;
    cookies: Record<string, string>;
    query: Record<string, string>;
    body: unknown;
}

export interface RouteBehavior {
    statuses?: number[];
    /** Pause (ms) before responding — a number, or a per-call sequence (last repeats). */
    delay?: number | number[];
    body?: unknown | unknown[] | ((callIndex: number, req: ReqInfo) => unknown);
    requireCookie?: { name: string; value?: string };
    requireHeader?: { name: string; value?: string };
    setCookie?: { name: string; value: string };
    setCookies?: { name: string; value: string }[];
    /** Emit a `Retry-After` header with this many delta-seconds (the header's native unit). */
    retryAfterSeconds?: number;
    headers?: Record<string, string>;
    /**
     * Stream the body as a real chunked HTTP response (no `content-length`) instead of one buffered
     * send — for the `sse`/`stream` surfaces. Each chunk is written separately, with an optional
     * `chunkDelay` pause (ms) *before* each, so a test can observe cross-chunk boundaries over a
     * real socket, abort mid-stream, or break early. Set `headers['content-type']` (e.g.
     * `'text/event-stream'`); the loop stops as soon as the client goes away.
     */
    stream?: { chunks: (string | Uint8Array)[]; chunkDelay?: number };
    /**
     * Send this body verbatim over the socket — raw bytes (Buffer/Uint8Array) or a string encoded
     * utf8 — bypassing the JSON/`{}` default of `body`. Pairs with `declaredLength` /
     * `truncateAfterBytes` for the buffered-download fault cases (M1 download rig): together they let
     * a route lie about `Content-Length` or short-write the socket. Content-type still defaults to
     * `application/octet-stream` unless `headers['content-type']` overrides it.
     */
    rawBody?: string | Uint8Array;
    /**
     * Advertise this exact `Content-Length` (in bytes) regardless of how many bytes are actually
     * written — so a route can claim a body larger than it sends (a truncation fault). Omitted ⇒
     * the transport frames the response itself (chunked / the real length). Only honoured on the
     * `rawBody` path.
     */
    declaredLength?: number;
    /**
     * Write only the first N bytes of `rawBody` and then cleanly `end()` the response — a real short
     * read over the socket (a clean FIN after fewer bytes than promised). Combine with a larger
     * `declaredLength` to reproduce "200 + Content-Length: N, body < N". Only honoured on the
     * `rawBody` path.
     */
    truncateAfterBytes?: number;
    /**
     * Server-side Range scaffolding (M1: a target for a FUTURE resume feature — no client code uses
     * it yet). When `true` AND the request carries a `Range: bytes=START-[END]` header, the route
     * answers `206 Partial Content` with the requested slice of `rawBody`/`body` and a correct
     * `Content-Range: bytes START-END/TOTAL`. A request with NO `Range` header is served normally
     * (a full `200`), so the same route reproduces the "stray 206" gap only when the client actually
     * asked for a range. Ignored unless a byte body is available.
     */
    serveRange?: boolean;
    /**
     * Write the first N bytes of `rawBody` and then **destroy the socket** — a real `ECONNRESET`
     * mid-body (M2 network-fault rig). The abrupt-close sibling of `truncateAfterBytes`: where that
     * one `end()`s cleanly (a FIN, which undici HANGS on), this one RSTs the connection (which undici
     * REJECTS with `UND_ERR_SOCKET`). The `Content-Length` still advertises the whole body
     * (`declaredLength ?? rawBody.length`), so the client is mid-buffer when the reset lands. Only
     * honoured on the `rawBody` path; wins over `truncateAfterBytes` if both are set.
     */
    resetAfterBytes?: number;
    /**
     * Write the first N bytes of `rawBody` and then **hold the connection open with no further
     * bytes** — an idle stall (M2). The body never finishes, so a buffered `download` blocks; only
     * the caller's `timeout` (engine-level) can cut it. The held socket is force-destroyed on BOTH
     * `reset()` and `close()` (the server tracks live sockets), so a stalled test can't wedge
     * teardown. `Content-Length` advertises the whole body. Only honoured on the `rawBody` path.
     */
    stallAfterBytes?: number;
    /**
     * Delay the status line + headers by N ms **after** the request is fully received, before any
     * response is written — a slow time-to-first-byte (M2). Distinct from `delay` (which is the
     * JSON-`body` path's pre-send pause): `ttfbDelay` is honoured on the `rawBody` path so a
     * download can pin that a slow TTFB rides the same `timeout` as everything else. The socket is
     * held open during the wait and is force-destroyed on `reset()`/`close()`.
     */
    ttfbDelay?: number;
    /**
     * Stream `rawBody` to the client in fixed-size slices of `chunkBytes` (default: the whole body in
     * one chunk), pausing `chunkDelay` **before each** slice — a steady bandwidth-throttle profile
     * (M2). Unlike `stallAfterBytes`, bytes keep flowing the whole time, so `onProgress` records a
     * rising `loaded`: this is the "healthy-but-slow" body the slow-vs-stall finding needs. The
     * response is a real chunked send (no `Content-Length`), so download progress reports `loaded`
     * with no `total`. Only honoured on the `rawBody` path; ignored if `chunkDelay` is unset (a
     * plain framed send covers the no-throttle case). The socket is tracked for teardown.
     */
    chunkBytes?: number;
    /**
     * Pause before each write, in ms (M2). On the `rawBody` chunked path (`chunkBytes`) it throttles
     * the body so bytes trickle out steadily; it is the top-level twin of `stream.chunkDelay` (the
     * SSE/stream path keeps its own nested field). Only meaningful on the `rawBody` chunked path.
     */
    chunkDelay?: number;
    /**
     * Answer with an HTTP redirect to `redirectTo` (M3 redirect-fault rig). The response is the
     * route's status (drawn from the `statuses` array so 301/302/303/307/308 can be scripted per
     * call; **defaults to 302** when the resolved status isn't itself a 3xx redirect code) plus a
     * `Location: <redirectTo>` header and a tiny body. `redirectTo` may be an **absolute** URL — e.g.
     * `${otherServer.url}/file`, which is cross-origin because a second `startMockServer()` binds a
     * different ephemeral port — or a **path** on the same server (same-origin). Wins over every
     * other body path (`rawBody`/`stream`/`body`), so a redirecting route never also writes a
     * payload. The request is still recorded (`calls()`/`callCount()` count the hop), and the
     * auth/counter checks above still run, so a `[503, 302]`-style transient-then-redirect is
     * expressible.
     */
    redirectTo?: string;
}

export interface MockServer {
    url: string;
    route(method: string, path: string, behavior: RouteBehavior): void;
    calls(path?: string): ReqInfo[];
    callCount(path?: string): number;
    reset(): void;
    close(): Promise<void>;
}

const at = (arr: unknown[], i: number): unknown =>
    arr[Math.min(i, arr.length - 1)];

const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

const parseCookies = (header: string | undefined): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
};

const collectHeaders = (req: IncomingMessage): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
        out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : (v ?? '');
    }
    return out;
};

const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            if (!raw) {
                resolve(undefined);
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                resolve(raw);
            }
        });
        req.on('error', () => {
            resolve(undefined);
        });
    });

export function startMockServer(): Promise<MockServer> {
    const routes = new Map<string, RouteBehavior>();
    const counters = new Map<string, number>();
    const log: ReqInfo[] = [];
    // Armed `delay` timers, so a pending response can't outlive the test that asked for it. A
    // timeout/abort test deliberately walks away from a slow route long before it answers; without
    // this the stray timer keeps the worker's event loop alive past `close()` and then writes to a
    // socket the client already dropped. Cleared on reset() and close().
    const pendingResponses = new Set<ReturnType<typeof setTimeout>>();
    // Every live TCP connection, tracked so a stalled/held socket (M2 `stallAfterBytes` /
    // `ttfbDelay`) can be force-destroyed on BOTH `reset()` and `close()` — otherwise a socket the
    // server is deliberately holding open would keep the event loop alive and hang test teardown.
    // `server.closeAllConnections()` only fires on close; `reset()` (per-test) needs this explicit
    // set. The timer set above is the same discipline one layer up: this kills the socket, that one
    // kills the not-yet-fired write.
    const sockets = new Set<Socket>();
    const key = (method: string, path: string): string =>
        `${method.toUpperCase()} ${path}`;

    const handler = async (
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> => {
        const method = (req.method ?? 'GET').toUpperCase();
        const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
        const path = parsed.pathname;
        const query: Record<string, string> = {};
        for (const [k, v] of parsed.searchParams.entries()) query[k] = v;
        const headers = collectHeaders(req);
        const info: ReqInfo = {
            method,
            path,
            headers,
            cookies: parseCookies(headers['cookie']),
            query,
            body: await readBody(req),
        };
        log.push(info);

        const rk = key(method, path);
        const behavior = routes.get(rk);
        const buildHeaders = (
            contentType: string,
            extra?: RouteBehavior,
        ): Record<string, string | string[]> => {
            const out: Record<string, string | string[]> = {
                'content-type': contentType,
            };
            // A route's own `headers` win — including `content-type` (e.g. text/event-stream).
            if (extra?.headers) Object.assign(out, extra.headers);
            if (extra?.setCookie)
                out['Set-Cookie'] =
                    `${extra.setCookie.name}=${extra.setCookie.value}`;
            if (extra?.setCookies)
                // Multiple Set-Cookie headers (array value → one header line each).
                out['Set-Cookie'] = extra.setCookies.map(
                    (c) => `${c.name}=${c.value}`,
                );
            if (extra?.retryAfterSeconds !== undefined)
                out['Retry-After'] = String(extra.retryAfterSeconds);
            return out;
        };
        const send = (
            status: number,
            payload: unknown,
            extra?: RouteBehavior,
        ): void => {
            // A Buffer/Uint8Array body is sent as raw bytes (octet-stream by default);
            // anything else is JSON-encoded. Lets routes serve binary downloads.
            const isBytes =
                Buffer.isBuffer(payload) || payload instanceof Uint8Array;
            res.writeHead(
                status,
                buildHeaders(
                    isBytes ? 'application/octet-stream' : 'application/json',
                    extra,
                ),
            );
            res.end(isBytes ? Buffer.from(payload) : JSON.stringify(payload));
        };
        // Send a byte body verbatim, optionally lying about `Content-Length` (`declaredLength`) and/or
        // short-writing the socket (`truncateAfterBytes`) — the buffered-download fault path. Unlike
        // `send`, the length header is set explicitly (a lie survives) and only a prefix may be
        // written before a clean `end()`. Swallows a client-abort reset so a half-read body can't
        // crash the handler.
        const sendRaw = (
            status: number,
            bytes: Buffer,
            extra: RouteBehavior,
        ): void => {
            res.on('error', () => {
                /* client went away mid-write */
            });
            const out = buildHeaders('application/octet-stream', extra);
            // A declared length wins even when it disagrees with the bytes on the wire (the truncation
            // lie); otherwise advertise the real length so the response is a plain framed 200.
            out['content-length'] = String(
                extra.declaredLength ?? bytes.length,
            );
            res.writeHead(status, out);
            const cut =
                extra.truncateAfterBytes !== undefined
                    ? bytes.subarray(0, extra.truncateAfterBytes)
                    : bytes;
            res.end(cut);
        };
        // Answer a `Range: bytes=START-[END]` request with `206 Partial Content` + the requested slice
        // and a correct `Content-Range` (M1 server-side scaffolding only — no client resume yet).
        // Returns true when it handled the request; false when there was no usable `Range` (the caller
        // then serves the full body — which for a byte body is the "stray 206"-free 200 path).
        const serveRangeIf = (full: Buffer, extra: RouteBehavior): boolean => {
            const m = /^bytes=(\d+)-(\d*)$/.exec(headers['range'] ?? '');
            if (!m) return false;
            const start = Number(m[1]);
            const end = m[2] ? Number(m[2]) : full.length - 1;
            if (start > end || start >= full.length) return false;
            const slice = full.subarray(start, end + 1);
            const out = buildHeaders('application/octet-stream', extra);
            out['content-range'] = `bytes ${start}-${end}/${full.length}`;
            out['content-length'] = String(slice.length);
            res.writeHead(206, out);
            res.end(slice);
            return true;
        };
        // Write the body as a real chunked response: one `res.write` per chunk (an optional pause
        // before each), then `res.end`. Bails the moment the client disconnects (abort / early
        // break) so a half-read stream can't wedge the server's `close()`.
        const streamResponse = async (
            status: number,
            extra: RouteBehavior,
        ): Promise<void> => {
            const spec = extra.stream!;
            // Swallow a client-abort reset (ECONNRESET) so a mid-stream abort/early-break doesn't
            // crash the handler. The loop guards on the response's own runtime flags rather than a
            // closure-set boolean (a flag mutated only inside the handler reads as a constant to the
            // type-aware lint rule): `destroyed` flips on a client disconnect, `writableEnded` once
            // we've ended — either means there is no point writing more.
            res.on('error', () => {
                /* client went away mid-write */
            });
            res.writeHead(
                status,
                buildHeaders('application/octet-stream', extra),
            );
            for (const chunk of spec.chunks) {
                if (spec.chunkDelay) await sleep(spec.chunkDelay);
                if (res.writableEnded || res.destroyed) break;
                res.write(
                    typeof chunk === 'string'
                        ? Buffer.from(chunk, 'utf8')
                        : Buffer.from(chunk),
                );
            }
            if (!res.writableEnded && !res.destroyed) res.end();
        };
        // ---- M2 network-fault sends (rawBody path) --------------------------------------------
        // Write the first N bytes of `bytes`, then RST the underlying socket → a real ECONNRESET
        // mid-body (the abrupt-close sibling of `truncateAfterBytes`'s clean FIN). `Content-Length`
        // still advertises the whole body, so the client is mid-buffer when the reset lands and undici
        // rejects with `UND_ERR_SOCKET`. `res.socket.destroy()` sends the RST; `res.destroy()` alone
        // can FIN cleanly, so we hit the socket directly.
        const sendReset = (
            status: number,
            bytes: Buffer,
            extra: RouteBehavior,
        ): void => {
            res.on('error', () => {
                /* socket torn down under us */
            });
            const out = buildHeaders('application/octet-stream', extra);
            out['content-length'] = String(
                extra.declaredLength ?? bytes.length,
            );
            res.writeHead(status, out);
            const n = extra.resetAfterBytes ?? 0;
            res.write(bytes.subarray(0, n));
            // Abrupt close: destroy the raw socket to force a TCP RST rather than a graceful FIN.
            res.socket?.destroy();
        };
        // Write the first N bytes, then HOLD the connection open forever (no `end`, no further
        // bytes) — an idle stall. The body never completes, so a buffered download blocks until the
        // caller's timeout fires. The socket is in the tracked `sockets` set, so `reset()`/`close()`
        // destroy it — this handler intentionally never finishes the response.
        const sendStall = (
            status: number,
            bytes: Buffer,
            extra: RouteBehavior,
        ): void => {
            res.on('error', () => {
                /* torn down at teardown */
            });
            const out = buildHeaders('application/octet-stream', extra);
            out['content-length'] = String(
                extra.declaredLength ?? bytes.length,
            );
            res.writeHead(status, out);
            const n = extra.stallAfterBytes ?? 0;
            if (n > 0) res.write(bytes.subarray(0, n));
            // Deliberately do NOT end: hold the socket open. Teardown destroys it.
        };
        // Stream `bytes` in fixed `chunkBytes`-sized slices, pausing `chunkDelay` before each — a
        // steady bandwidth throttle. Bytes keep flowing, so `onProgress` sees a rising `loaded`. Sent
        // as a real chunked response (no Content-Length), matching how `readWithProgress` reports
        // `loaded` without a `total`. Bails if the client disconnects so it can't wedge teardown.
        const sendChunked = async (
            status: number,
            bytes: Buffer,
            extra: RouteBehavior,
        ): Promise<void> => {
            res.on('error', () => {
                /* client went away mid-write */
            });
            res.writeHead(
                status,
                buildHeaders('application/octet-stream', extra),
            );
            const size = extra.chunkBytes ?? bytes.length;
            for (let off = 0; off < bytes.length; off += size) {
                if (extra.chunkDelay) await sleep(extra.chunkDelay);
                if (res.writableEnded || res.destroyed) break;
                res.write(bytes.subarray(off, off + size));
            }
            if (!res.writableEnded && !res.destroyed) res.end();
        };

        if (!behavior) {
            send(404, { error: 'not_found' });
            return;
        }

        const ck = behavior.requireCookie;
        if (
            ck &&
            (info.cookies[ck.name] === undefined ||
                (ck.value !== undefined && info.cookies[ck.name] !== ck.value))
        ) {
            send(401, { error: 'unauthorized' });
            return;
        }
        const hd = behavior.requireHeader;
        if (hd) {
            const have = headers[hd.name.toLowerCase()];
            if (
                have === undefined ||
                (hd.value !== undefined && have !== hd.value)
            ) {
                send(401, { error: 'unauthorized' });
                return;
            }
        }

        const idx = counters.get(rk) ?? 0;
        counters.set(rk, idx + 1);

        const status = behavior.statuses
            ? (at(behavior.statuses, idx) as number)
            : 200;

        // A redirecting route (M3): emit `Location: <redirectTo>` + a tiny body and return. It fires
        // when the resolved `status` is a 3xx redirect code (so a `statuses` array scripts
        // 301/302/303/307/308 per call), OR when no `statuses` array was given at all (default 302 —
        // a plain `redirectTo` with no status still redirects). When a `statuses` array yields a
        // NON-3xx (e.g. a `[503, 302]` transient-then-redirect), the non-3xx call FALLS THROUGH to
        // the normal body path below and answers that status verbatim — only the 3xx call redirects.
        // A redirect wins over the body paths, so a redirecting route never also writes a payload.
        // `redirectTo` may be absolute (cross-origin, a different ephemeral port) or a path (same-origin).
        const isRedirectCode = status >= 300 && status < 400;
        if (
            behavior.redirectTo !== undefined &&
            (isRedirectCode || !behavior.statuses)
        ) {
            const out = buildHeaders('text/plain', behavior);
            out['location'] = behavior.redirectTo;
            res.writeHead(isRedirectCode ? status : 302, out);
            res.end('redirecting');
            return;
        }

        // A streaming route writes a real chunked response (auth/counter checks above still apply).
        if (behavior.stream) {
            await streamResponse(status, behavior);
            return;
        }

        // A raw byte body: honours `serveRange` (206 when the client sent a `Range`), then — after
        // an optional slow-TTFB pause — the M2 network faults (RST / stall / throttle) or the M1
        // truncation/`declaredLength` path, else a plain framed send. `body` (JSON) is ignored here —
        // `rawBody` is the explicit byte channel these download-fault cases use.
        if (behavior.rawBody !== undefined) {
            const full =
                typeof behavior.rawBody === 'string'
                    ? Buffer.from(behavior.rawBody, 'utf8')
                    : Buffer.from(behavior.rawBody);
            // serveRange short-circuits before any TTFB delay (it's an M1 range case, not a fault).
            if (behavior.serveRange && serveRangeIf(full, behavior)) return;
            // Slow time-to-first-byte: the request is fully received; hold before writing the status
            // line + headers. The socket is tracked, so teardown can cut a mid-wait hold.
            if (behavior.ttfbDelay) await sleep(behavior.ttfbDelay);
            if (res.writableEnded || res.destroyed) return; // torn down during the TTFB wait
            // Exactly one fault path wins, in precedence order: abrupt reset, idle stall, steady
            // throttle (chunked), then the M1 clean-FIN truncation / plain framed send.
            if (behavior.resetAfterBytes !== undefined)
                sendReset(status, full, behavior);
            else if (behavior.stallAfterBytes !== undefined)
                sendStall(status, full, behavior);
            else if (behavior.chunkDelay !== undefined)
                await sendChunked(status, full, behavior);
            else sendRaw(status, full, behavior);
            return;
        }

        let body: unknown = {};
        if (typeof behavior.body === 'function') {
            body = (behavior.body as (i: number, r: ReqInfo) => unknown)(
                idx,
                info,
            );
        } else if (Array.isArray(behavior.body)) {
            body = at(behavior.body, idx);
        } else if (behavior.body !== undefined) {
            body = behavior.body;
        }

        let delay = 0;
        if (Array.isArray(behavior.delay))
            delay = (at(behavior.delay, idx) as number) ?? 0;
        else if (typeof behavior.delay === 'number') delay = behavior.delay;

        const respond = (): void => {
            // The client may have aborted while we were sleeping out `delay` — writing to a
            // destroyed response emits an unhandled 'error' on it. Nothing to answer: drop it.
            if (res.writableEnded || res.destroyed) return;
            send(status, body, behavior);
        };
        if (delay > 0) {
            const timer = setTimeout(() => {
                pendingResponses.delete(timer);
                respond();
            }, delay);
            pendingResponses.add(timer);
        } else respond();
    };

    const server: Server = createServer((req, res) => {
        handler(req, res).catch(() => {
            if (!res.headersSent)
                res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal' }));
        });
    });
    // Track live sockets for deterministic teardown of held/stalled connections (see `sockets`).
    server.on('connection', (socket: Socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });

    const filter = (path?: string): ReqInfo[] =>
        path ? log.filter((r) => r.path === path) : log.slice();

    const clearPending = (): void => {
        for (const timer of pendingResponses) clearTimeout(timer);
        pendingResponses.clear();
    };

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            resolve({
                url: `http://127.0.0.1:${port}`,
                route(method, path, behavior) {
                    routes.set(key(method, path), behavior);
                },
                calls: filter,
                callCount: (path) => filter(path).length,
                reset() {
                    routes.clear();
                    counters.clear();
                    log.length = 0;
                    clearPending();
                    // Destroy any socket a prior test left deliberately open (a `stallAfterBytes`
                    // hold, a mid-`ttfbDelay` wait) so it can't leak into the next test or keep the
                    // loop alive. Each destroy fires the socket's own `close` → removed from the set.
                    for (const socket of sockets) socket.destroy();
                },
                close: () =>
                    new Promise<void>((res) => {
                        clearPending();
                        // Force-drop any still-open connection (a held/stalled M2 socket, a half-read
                        // stream from an early break) so close() can't hang waiting on it. Belt-and-
                        // braces: destroy tracked sockets AND call closeAllConnections (Node ≥ 18.2).
                        for (const socket of sockets) socket.destroy();
                        server.closeAllConnections();
                        server.close(() => {
                            res();
                        });
                    }),
            });
        });
    });
}
