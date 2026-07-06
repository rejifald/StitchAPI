// Connection-level fault helpers for the download rig — the faults that live BELOW the HTTP layer and
// that `node:http` normalizes away (spec §5 "Layer 3b — raw net.Server escape hatch"). A real
// `node:net` server (or the absence of one) is the only way to produce a genuine ECONNREFUSED, an
// immediate FIN with no HTTP response, an accept-then-silence, or a broken TLS handshake — an HTTP
// route can't. Test-only; imports `node:net` freely (never bundled).
import { createServer as createNetServer } from 'node:net';
import type { Server, Socket } from 'node:net';

/**
 * A TCP port that nothing is listening on: bind an ephemeral port, capture it, close, hand it back.
 * A connect to `127.0.0.1:<port>` then fails with ECONNREFUSED — nothing accepts (N9). There is an
 * inherent (tiny) race — the OS could hand the port to someone else before the test connects — but on
 * a loopback test host it is effectively free, and a spurious accept would only make the assertion
 * fail loudly, never pass wrongly.
 */
export function unusedPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = createNetServer();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const addr = s.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            s.close(() => {
                resolve(port);
            });
        });
    });
}

export interface RawServer {
    /** `http://127.0.0.1:<port>` by default; pass `'https'` to drive a TLS-handshake fault (N8). */
    url: (scheme?: 'http' | 'https') => string;
    port: number;
    close: () => Promise<void>;
}

/**
 * A raw TCP server whose per-connection behaviour is entirely up to `onConnection(socket)` — the
 * escape hatch for connection-level faults an HTTP server can't express:
 *   • `socket.end()`      → immediate FIN, no HTTP response ever (N11 hangup / "no HTTP response").
 *   • `socket.destroy()`  → abrupt RST.
 *   • do nothing          → accept then silence; the client's own `timeout` must cut it (N10).
 *   • end/destroy on the first bytes → break a TLS ClientHello → handshake failure (N8).
 * Live sockets are tracked and force-destroyed on `close()` so a held connection can't wedge teardown.
 */
export function startRawServer(
    onConnection: (socket: Socket) => void,
): Promise<RawServer> {
    const sockets = new Set<Socket>();
    const server: Server = createNetServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        // A peer reset while we're deciding what to do must not throw an unhandled 'error'.
        socket.on('error', () => {
            /* peer went away */
        });
        onConnection(socket);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            resolve({
                url: (scheme = 'http') => `${scheme}://127.0.0.1:${port}`,
                port,
                close: () =>
                    new Promise<void>((res) => {
                        for (const s of sockets) s.destroy();
                        server.close(() => {
                            res();
                        });
                    }),
            });
        });
    });
}
