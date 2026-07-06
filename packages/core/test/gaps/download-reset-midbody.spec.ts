// Pins: a download whose socket is RST mid-body must REJECT — never resolve a partial Blob.
//
// The abrupt-close sibling of download-truncation.spec.ts's clean FIN. Where a short read + clean
// `end()` makes undici HANG (cured only by a timeout), an abrupt socket close mid-body makes undici
// REJECT at the transport (`UND_ERR_SOCKET`, "other side closed"), and the engine's try/catch
// (engine.ts:687) turns that into a rejected call. So there is nothing for the surface's `interpret`
// to accept — a partial body is never handed back as a complete Blob. No `src/` change is involved;
// this pins that the existing transport + engine path already fails closed on a real ECONNRESET.
//
// EMPIRICAL FINDING (Node 24 undici, measured for this rig): at the transport boundary the RST is a
//   TypeError: "fetch failed"
//     └─ cause: SocketError { code: 'UND_ERR_SOCKET', message: 'other side closed' }
// but the engine reduces a transport failure to its top-level MESSAGE on the error event and rebuilds
// a `StitchError('fetch failed', …)` WITHOUT the `.cause` chain — so the caller (both the throwing
// AND the `.safe()` path) sees `StitchError: fetch failed` with `err.cause === undefined`. The
// `UND_ERR_SOCKET` detail is therefore NOT visible to callers today; only the generic "fetch failed"
// survives. (A candidate future improvement: carry the transport `cause` through the error event so
// callers can distinguish a socket reset from other transport failures.) This spec asserts the shape
// that actually surfaces — a reject whose message is undici's transport-failure text — not the
// stripped socket cause. `retry: { attempts: 1 }` makes the first transport failure terminal, so the
// assertion is a clean single-shot reject (no backoff to wait on).
//
// Real-timer, loose bounds (a socket test): no timeout is needed — undici rejects promptly on the
// RST — but we keep `retry: { attempts: 1 }` so the reset is not papered over by a retry.
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

// 64 bytes advertised via Content-Length, but only the first 8 are written before the socket is
// destroyed (a TCP RST) — a real ECONNRESET mid-body. undici rejects; the call must too.
test('a socket RST mid-body rejects the download — never a partial Blob', async () => {
    server.route('GET', '/reset', {
        statuses: [200],
        rawBody:
            'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ012', // 64 bytes
        declaredLength: 64, // advertise 64…
        resetAfterBytes: 8, // …but write only 8, then RST the socket
    });

    const getReset = download({
        baseUrl: server.url,
        path: '/reset',
        retry: { attempts: 1 }, // the reset is terminal, not a transient to retry
    });

    // The call must reject — a partial body is never handed back as a complete Blob. The
    // engine-surfaced message is undici's transport-failure text ("fetch failed"); the underlying
    // UND_ERR_SOCKET/"other side closed" cause is stripped by the engine (see the header note), so we
    // pin the message that actually reaches the caller. It is NOT a surface-level ("download: …")
    // reject — the failure happens at the transport, before `interpret` ever runs.
    const err = await getReset().then(
        () => {
            throw new Error('reset-mid-body download unexpectedly resolved');
        },
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/fetch failed/i);
    // Guard that it was a transport reject, not the stray-206 / interpret-level path.
    expect((err as Error).message).not.toMatch(/^download:/);
});
