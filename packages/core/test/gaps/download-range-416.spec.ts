// Pins R4 (server-side scaffolding for the future resume feature): when a request carries a `Range` and
// the server answers 416 Range Not Satisfiable, the download FAILS CLOSED — a 416 is ≥400, so the
// engine throws it terminally; it is never silently accepted as a body. download() never sends a Range
// on its own, so we force one via a config header to exercise the path (the future resume-aware surface
// will send real Ranges). This pins the current surface's failure mode on a 416.
//
// Deferred (gated on the client-side resume feature landing, per the rig spec §2.4): the If-Range /
// ETag-change / 200-ignoring-Range (R3/R6/R8) RESUME behaviors — the mock server can now EMIT the
// validators (`etag`/`lastModified`/`acceptRanges`) and force a 200-on-Range (`forceStatusOnRange: 200`)
// as scaffolding, but there is no client that consumes them yet, so the client-side assertions wait for
// the resume feature. This spec pins only the meaningful CURRENT behavior: a 416 rejects.
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

test('a 416 to a Range request is rejected, not accepted as a body', async () => {
    server.route('GET', '/ranged', {
        statuses: [200],
        rawBody: 'HELLO-RANGE-BODY-0123456789',
        acceptRanges: 'bytes', // advertise Range support (validator scaffolding)
        etag: '"v1-abc"',
        forceStatusOnRange: 416, // any Range request → 416 Range Not Satisfiable
    });

    // download() never sends a Range itself; force one via a config header to reach the 416 path.
    const getIt = download({
        baseUrl: server.url,
        path: '/ranged',
        headers: { range: 'bytes=1000-2000' }, // out of bounds → the server forces 416
        retry: { attempts: 1 },
    });

    const err = await getIt().then(
        () => {
            throw new Error('416 download unexpectedly resolved');
        },
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/416/);
    // The server DID receive the Range (the fault path fired), confirming the request carried it.
    expect(server.calls('/ranged')[0]?.headers['range']).toBe(
        'bytes=1000-2000',
    );
});
