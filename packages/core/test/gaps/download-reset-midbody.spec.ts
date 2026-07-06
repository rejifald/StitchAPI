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
// The engine surfaces the transport failure's top-level MESSAGE on the error event ("fetch failed"),
// and the rebuilt `StitchError` keeps that message — but it now ALSO carries the live transport error
// through the non-enumerable ERROR_SOURCE channel as `StitchError.cause` (engine.ts `errEvt` +
// stitch.ts `rebuildError`), so a caller (both the throwing AND the `.safe()` path) can reach
// `err.cause` and its nested `UND_ERR_SOCKET` code to tell a socket reset from a generic "fetch
// failed". (The cause is non-enumerable, so it never leaks into a trace sink — only the enumerable
// status/message do.) This spec asserts both: the surfaced message IS undici's transport text, AND the
// socket cause is now reachable through `err.cause`. `retry: { attempts: 1 }` makes the first transport
// failure terminal, so the assertion is a clean single-shot reject (no backoff to wait on).
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
    // UND_ERR_SOCKET/"other side closed" cause is now carried on `err.cause` (asserted below). It is
    // NOT a surface-level ("download: …") reject — the failure happens at the transport, before
    // `interpret` ever runs.
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

    // The transport cause is now carried through: `err.cause` — undefined before this change — holds
    // the live undici error, and its socket `code` (UND_ERR_SOCKET) is reachable through the cause
    // chain. This is what lets a caller (e.g. @stitchapi/download's classifier) tell an RST from any
    // other "fetch failed".
    const cause = (err as { cause?: unknown }).cause;
    expect(cause).toBeDefined();
    const codes: string[] = [];
    let cur: unknown = cause;
    for (let i = 0; cur != null && i < 5; i++) {
        const code = (cur as { code?: unknown }).code;
        if (typeof code === 'string') codes.push(code);
        cur = (cur as { cause?: unknown }).cause;
    }
    expect(codes).toContain('UND_ERR_SOCKET');

    // The `.safe()` path carries it too — both terminals go through the same rebuild.
    const safe = await getReset().safe();
    expect(safe.ok).toBe(false);
    expect((safe.error as { cause?: unknown }).cause).toBeDefined();
});
