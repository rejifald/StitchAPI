// Pins: a truncated download — `200 OK` + `Content-Length: N` but a body of fewer than N bytes —
// must NEVER resolve as a complete Blob. It has to fail instead.
//
// EMPIRICAL FINDING (Node 20/22/24 undici, measured for this rig):
//   * CL-mismatch + a CLEAN FIN (server writes 8 of a promised 64 bytes, then `res.end()`):
//     undici does NOT reject — it HANGS waiting for the missing bytes until the caller's
//     timeout/abort fires. The body never finishes buffering, so the surface's `interpret` is
//     never even reached. The real cure for this mode is a `timeout` (engine-level), not a
//     length cross-check in `interpret`.
//   * CL-mismatch + an ABRUPT socket close (RST): undici DOES reject (`UND_ERR_SOCKET`,
//     "other side closed"); the engine's try/catch turns that into a rejected call already.
// Because undici never hands a SHORT Blob to `interpret` while a numeric `content-length`
// promised more (it hangs or it rejects at the transport), an interpret-level
// `blob.size !== content-length` check would be dead code — so `download.ts` deliberately does
// NOT add one (see the comment there). This test pins the clean-FIN mode: under a bounded
// `timeout`, the truncated download FAILS rather than silently resolving with a partial body.
//
// Real-timer, loose bounds (a socket test): the timeout is short but the assertion only cares that
// the call rejects well before the promised body could ever arrive.
import { download } from '../../src/download';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});

// 64 bytes of body advertised via Content-Length, but only the first 8 are written before a clean
// end — a real short read over the socket. undici blocks waiting for the other 56; a bounded
// per-attempt timeout must cut it and fail the call (never resolve with the 8 partial bytes).
test('a Content-Length-mismatch truncation (clean FIN) fails under a bounded timeout — never a partial Blob', async () => {
    server.route('GET', '/truncated', {
        statuses: [200],
        rawBody:
            'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ012', // 64 bytes
        declaredLength: 64, // advertise 64…
        truncateAfterBytes: 8, // …but write only 8, then a clean FIN
    });

    // A short total timeout so the undici hang is cut deterministically; no retry (a truncation is
    // not a transient the surface should paper over here).
    const getTruncated = download({
        baseUrl: server.url,
        path: '/truncated',
        timeout: 500,
        retry: { attempts: 1 },
    });

    // The call must reject — a partial body is never handed back as a complete Blob.
    await expect(getTruncated()).rejects.toThrow();
});
