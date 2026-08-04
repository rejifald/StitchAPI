// Pins: the `download` surface must REJECT a `206 Partial Content` it never asked for.
//
// `download` NEVER sends a `Range` header, yet a `206` is `< 400`, so the engine's attempt loop
// (engine.ts:775 throws only on `>= 400`) lets it through to the surface's `interpret`. Pre-fix,
// `interpret` returned `{ ok: true }` unconditionally (download.ts) — so a stray 206 was accepted as
// a COMPLETE Blob, silently handing the caller a partial body as if it were the whole file. The fix
// makes `interpret` reject any non-`200`/`204` status. This test drives the real fetch adapter over a
// mock server that answers a range-less GET with a 206 body.
//
// Pre-fix behavior (before the interpret fix): the call RESOLVED and `out.blob` held the partial
// bytes. This committed test asserts the FIXED behavior — the call rejects with a 206 message.
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

test('a stray 206 (no Range was sent) is rejected, not accepted as a complete Blob', async () => {
    server.route('GET', '/partial', {
        statuses: [206],
        rawBody: 'PARTIAL', // a real body under a 206 status, to a request carrying no Range
        headers: {
            // A 206 in the wild carries a Content-Range; include one so the fixture is realistic.
            'content-range': 'bytes 0-6/1024',
        },
    });

    const getPartial = download({ baseUrl: server.url, path: '/partial' });

    // The surface must treat the unsolicited partial as a failure — the promise rejects with a
    // 206-flavored message. (Pre-fix this RESOLVED with `out.blob` holding the 7 partial bytes.)
    await expect(getPartial()).rejects.toThrow(/206|partial/i);

    // And it really did answer 206 to a range-less request (guards the fixture itself).
    expect(server.calls('/partial')[0]?.headers['range']).toBeUndefined();
});

// The opt-out, and the reason the rule reads `verdict.accept` at all (ADR 0022). `classifyStatus`
// consults `accept` only at `>= 400`, so a sub-400 status never reaches it — which means without an
// explicit read in `interpret`, a caller who declared `206` NORMAL would still be rejected. That
// would be the surface OVERRIDING a declaration rather than ruling where the caller made none, and
// nothing else on the config surface behaves that way. A caller talking to a proxy that always
// answers 206 gets the documented escape hatch; everyone else keeps the safe default above.
test('`verdict.accept` opts a caller back into a 206 — a declaration the surface must not override', async () => {
    server.route('GET', '/partial-ok', {
        statuses: [206],
        rawBody: 'PARTIAL',
        headers: { 'content-range': 'bytes 0-6/1024' },
    });

    const getPartial = download({
        baseUrl: server.url,
        path: '/partial-ok',
        verdict: { accept: 206 },
    });

    const out = await getPartial();
    expect(await out.blob.text()).toBe('PARTIAL');
});
