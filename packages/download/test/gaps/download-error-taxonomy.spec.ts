// Pins CONTRACT.md P10 (error-class taxonomy parity) for this package's two exported error classes.
//
// P10 has two halves, and only the second one is observable from outside:
//   • Parity by INHERITANCE — `DownloadCancelledError` and `DownloadIdleTimeoutError` extend
//     `StitchError`, so they carry the mandated field set (`status?`, `attempts`, `body?`, `url?`)
//     plus their own `name` discriminator, instead of re-declaring or omitting it.
//   • "No field is reachable only through `.cause`" — the instance the consumer ACTUALLY receives
//     must be the real one. A stalled item used to settle with a flattened base `StitchError` whose
//     `.cause` held the real `DownloadIdleTimeoutError`, so `err.idle` (the window that elapsed) was
//     unreachable on `ItemResult.error`. These tests read `idle` off the settled item directly, and
//     would fail against that shape.
//
// The cancel arm carries no `error` field by design (cancelling is not a failure), so
// `DownloadCancelledError` is observed where it IS surfaced: as the abort reason handed to a
// caller's own `hooks.onError`.
//
// Real-timer, LOOSE bounds (a socket test): the idle timer runs on the default `systemClock`; the
// stall hold is set with a wide margin vs the idle window. Held sockets are force-destroyed at
// teardown.
import { downloadAll } from '../../src';
import { DownloadCancelledError, DownloadIdleTimeoutError } from '../../src';
import type { ItemResult } from '../../src';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { StitchError } from 'stitchapi';

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

const asRejected = (
    r: ItemResult,
): Extract<ItemResult, { status: 'rejected' }> => {
    if (r.status !== 'rejected')
        throw new Error(`expected rejected but got ${r.status}`);
    return r;
};

test('both exported error classes ARE StitchErrors, with their own `name` and the inherited field set', () => {
    const cancelled = new DownloadCancelledError();
    const idle = new DownloadIdleTimeoutError(250);

    for (const e of [cancelled, idle]) {
        expect(e).toBeInstanceOf(StitchError);
        expect(e).toBeInstanceOf(Error);
        // The P10 field set, inherited rather than re-declared.
        expect(e).toHaveProperty('status');
        expect(e).toHaveProperty('attempts');
        expect(typeof e.attempts).toBe('number');
    }

    // …and each keeps `name` as its OWN discriminator — what a serialising host branches on once
    // the instance is gone.
    expect(cancelled.name).toBe('DownloadCancelledError');
    expect(idle.name).toBe('DownloadIdleTimeoutError');
    expect(idle.idle).toBe(250);
});

test('a real idle timeout settles with the DownloadIdleTimeoutError ITSELF — `idle` is readable on ItemResult.error, not via .cause', async () => {
    // Write 8 bytes of a declared 64, then hold the socket open forever → no forward progress.
    server.route('GET', '/stall', {
        statuses: [200],
        rawBody: 'y'.repeat(64),
        declaredLength: 64,
        stallAfterBytes: 8,
    });

    const results = await downloadAll([{ path: '/stall' }], {
        concurrency: 1,
        idle: 200,
        defaults: { baseUrl: server.url, retry: { attempts: 1 } },
    });

    const stall = asRejected(results[0]!);
    expect(stall.code).toBe('IDLE_TIMEOUT');
    expect(stall.retryable).toBe(true);

    // THE POINT: class identity and the window survive to the value the consumer receives. Before
    // #(this change) `error` was a base StitchError and the real instance sat on `.cause`.
    const err = stall.error;
    expect(err).toBeInstanceOf(DownloadIdleTimeoutError);
    expect(err).toBeInstanceOf(StitchError); // …and still branchable as the base
    expect((err as DownloadIdleTimeoutError).idle).toBe(200);
    expect(err.name).toBe('DownloadIdleTimeoutError');
    // Nothing is hiding one level down: the payload is HERE, not on the cause chain.
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
});

test('a duration STRING window is reported back as raw ms on the settled error (P17)', async () => {
    server.route('GET', '/stall-str', {
        statuses: [200],
        rawBody: 'z'.repeat(64),
        declaredLength: 64,
        stallAfterBytes: 8,
    });

    const results = await downloadAll([{ path: '/stall-str' }], {
        concurrency: 1,
        idle: '150ms',
        defaults: { baseUrl: server.url, retry: { attempts: 1 } },
    });

    const err = asRejected(results[0]!).error;
    expect(err).toBeInstanceOf(DownloadIdleTimeoutError);
    expect((err as DownloadIdleTimeoutError).idle).toBe(150);
});

test('cancelling an in-flight item hands a DownloadCancelledError to the caller’s own hooks.onError', async () => {
    server.route('GET', '/held', {
        statuses: [200],
        rawBody: 'held-body',
        ttfbDelay: 2000,
    });

    const seen: unknown[] = [];
    const batch = downloadAll([{ path: '/held', id: 'held' }], {
        concurrency: 1,
        defaults: {
            baseUrl: server.url,
            retry: { attempts: 1 },
            hooks: {
                onError: (ctx) => {
                    seen.push(ctx.error);
                },
            },
        },
    });

    // Let the request reach the wire, then cancel it.
    await new Promise((r) => setTimeout(r, 150));
    batch.cancel('held');
    const results = await batch;

    // The item settles as `cancelled` — that arm deliberately carries no `error`: cancelling is not
    // a failure, so there is nothing to classify.
    expect(results[0]!.status).toBe('cancelled');
    expect(results[0]!).not.toHaveProperty('error');

    // But the class is NOT inert — it is the abort reason, and a caller's own error hook receives
    // the instance, which is how a deliberate cancel is told apart from a transport fault.
    const cancel = seen.find((e) => e instanceof DownloadCancelledError);
    expect(cancel).toBeInstanceOf(DownloadCancelledError);
    expect(cancel).toBeInstanceOf(StitchError);
    expect((cancel as Error).name).toBe('DownloadCancelledError');
}, 20000);
