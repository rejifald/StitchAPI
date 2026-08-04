// Pins issue #155 part B: a thrown `StitchError` now carries `{ body, url }` — the parsed error
// payload and the final request URL of the failing response — alongside `.status`/`.attempts`, on
// BOTH the awaited path and `.safe()`. The response rides a NON-enumerable error channel
// (ERROR_SOURCE), so a result-shaped caller can read the API's `{ error: "…" }` payload while the
// body never serialises into a trace sink (privacy preserved). Applies to the buffered and
// streaming throw sites.
import {
    type StitchError,
    type StitchEvent,
    type TraceSink,
    stitch,
} from '../../src';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-gap-error-body-${process.pid}.jsonl`,
);

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

// Await a call expected to reject; return the thrown error narrowed to a StitchError.
async function rejectionOf(call: PromiseLike<unknown>): Promise<StitchError> {
    return Promise.resolve(call).then(
        () => {
            throw new Error('expected the call to reject, but it resolved');
        },
        (e: unknown) => e as StitchError,
    );
}

// ── A. the awaited path throws a StitchError carrying status + body + url ──
test('await throws a StitchError with .status, .body (parsed payload), and .url', async () => {
    server.route('GET', '/err', {
        statuses: [422],
        body: { error: 'unprocessable', field: 'email' },
    });
    const call = stitch({ baseUrl: server.url, path: '/err' });

    const err = await rejectionOf(call());

    expect(err.name).toBe('StitchError');
    expect(err.status).toBe(422);
    // The parsed error payload — exactly what an API's `{ error: "…" }` body needs.
    expect(err.body).toEqual({ error: 'unprocessable', field: 'email' });
    // The final request URL (after redirects), surfaced from the response.
    expect(err.url).toBe(`${server.url}/err`);
});

// ── B. .safe() surfaces the same body + url without throwing ──
test('.safe() returns a StitchError carrying .body and .url (never throws)', async () => {
    server.route('GET', '/err-safe', {
        statuses: [400],
        body: { error: 'bad_request' },
    });
    const call = stitch({ baseUrl: server.url, path: '/err-safe' });

    const out = await call.safe();
    expect(out.ok).toBe(false);
    expect(out.error?.status).toBe(400);
    expect(out.error?.body).toEqual({ error: 'bad_request' });
    expect(out.error?.url).toBe(`${server.url}/err-safe`);
});

// ── C. the error body does NOT reach a trace sink's error event (privacy) ──
// The response rides the non-enumerable ERROR_SOURCE channel, never an enumerable field. A capturing
// sink sees the enumerable `status`/`message`/`attempts` of the error event but never the body or
// the raw response — so a JSONL/console trace can't leak the failing payload.
test('the error body is absent from a capturing trace sink event', async () => {
    server.route('GET', '/err-trace', {
        statuses: [403],
        body: { error: 'forbidden', secret: 'do-not-log-me' },
    });
    const captured: StitchEvent[] = [];
    const sink: TraceSink = {
        handle(event) {
            captured.push(event);
        },
        flush() {
            /* nothing buffered */
        },
    };
    const call = stitch({
        baseUrl: server.url,
        path: '/err-trace',
        trace: sink,
    });

    // The awaited caller still gets the body…
    const err = await rejectionOf(call());
    expect(err.body).toEqual({ error: 'forbidden', secret: 'do-not-log-me' });

    // …but the sink's error event must not carry it. Assert across the raw event AND its JSON
    // serialisation (what a JSONL/console sink would actually write), since ERROR_SOURCE is a
    // non-enumerable Symbol key that both Object.keys and JSON.stringify skip.
    const errorEvent = captured.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent).toHaveProperty('status', 403);
    expect(errorEvent).not.toHaveProperty('body');
    expect(errorEvent).not.toHaveProperty('response');
    expect(errorEvent).not.toHaveProperty('url');
    const serialised = JSON.stringify(captured);
    expect(serialised).not.toContain('do-not-log-me');
});

// ── D. the streaming throw site also carries body + url ──
// A streaming surface that hits a non-accepted error surfaces it through the SAME pinned channel, so
// the awaited (collected) path's StitchError carries `.body`/`.url` too.
test('a failing streaming call throws a StitchError with .body and .url', async () => {
    server.route('GET', '/err-stream', {
        statuses: [500],
        body: { error: 'stream_boom' },
    });
    const call = stitch({
        baseUrl: server.url,
        path: '/err-stream',
        kind: {
            id: 'text-stream',
            stream: async function* (res) {
                const body = res.body as ReadableStream<Uint8Array>;
                const reader = body.getReader();
                const dec = new TextDecoder();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    yield dec.decode(value, { stream: true });
                }
            },
        },
    });

    const err = await rejectionOf(call());
    expect(err.status).toBe(500);
    expect(err.body).toEqual({ error: 'stream_boom' });
    expect(err.url).toBe(`${server.url}/err-stream`);
});

// ── E. a transport/internal error leaves body + url undefined ──
// `.body`/`.url` are populated only from an HTTP response. A connection failure (no response) yields
// a StitchError with no status, body, or url — proving the fields are additive, not always-present.
test('a transport error yields a StitchError with body and url undefined', async () => {
    // Point at a closed port on localhost — the connection is refused before any response.
    const call = stitch({
        baseUrl: 'http://127.0.0.1:1',
        path: '/nope',
        timeout: { each: '500ms' },
    });

    const err = await rejectionOf(call());
    expect(err.name).toBe('StitchError');
    expect(err.body).toBeUndefined();
    expect(err.url).toBeUndefined();
});
