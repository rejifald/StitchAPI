// Resumable SSE (issue #71): the `sse` surface reconnects a dropped `text/event-stream`, replaying
// the last `id:` as the `Last-Event-ID` request header and honouring a server-sent `retry:` as the
// reconnect backoff (falling back to `reconnect.backoffMs` / the stitch's `retry` policy). Off by
// default — these specs prove both the unchanged default and the opt-in reconnect loop, driving
// timing the way the repo's other backoff tests do: small distinct delays + real elapsed bounds
// (no fake timers anywhere in this package).
import { sse, sseSurface } from '../src/sse';
import type { Adapter, AdapterRequest, StitchEvent } from '../src/types';
import { asValidator } from './support/schema';
import { streamOf, streamThenError } from './support/streams';

import { z } from 'zod';

// An adapter that hands back a DIFFERENT scripted body per call and records every request it saw —
// so a test can assert what header (e.g. Last-Event-ID) rode the Nth open. Bodies past the script
// fall back to `tail` (default: an immediately-closing empty stream, which a resumable surface
// treats as another reconnect signal — handy for exercising the attempts cap deterministically).
function scriptedAdapter(
    bodies: (() => ReadableStream<Uint8Array>)[],
    init: { status?: number; tail?: () => ReadableStream<Uint8Array> } = {},
): { adapter: Adapter; requests: AdapterRequest[] } {
    const requests: AdapterRequest[] = [];
    let i = 0;
    const tail = init.tail ?? (() => streamOf([]));
    const adapter: Adapter = (req) => {
        if (!req.stream)
            return Promise.reject(new Error('expected req.stream to be set'));
        requests.push(req);
        const make = bodies[i++] ?? tail;
        return Promise.resolve({
            status: init.status ?? 200,
            headers: {},
            body: make(),
        });
    };
    return { adapter, requests };
}

interface Drained {
    types: string[];
    deltas: unknown[];
    reconnects: { attempt: number; waitedMs: number | undefined }[];
    drifts: { level: string }[];
    result: unknown;
    error: { message: string; status: number | undefined } | undefined;
    doneOk: boolean | undefined;
}

// Like the shared `collectEvents`, but also captures `progress.reconnect` events (the reconnect
// signal lives on the `progress` spine — no new StitchEvent type) so a test can assert the backoff.
async function drainAll(
    gen: AsyncGenerator<StitchEvent, void>,
): Promise<Drained> {
    const out: Drained = {
        types: [],
        deltas: [],
        reconnects: [],
        drifts: [],
        result: undefined,
        error: undefined,
        doneOk: undefined,
    };
    for await (const ev of gen) {
        out.types.push(ev.type);
        if (ev.type === 'delta') out.deltas.push(ev.chunk);
        else if (ev.type === 'progress' && ev.phase === 'reconnect')
            out.reconnects.push({ attempt: ev.attempt, waitedMs: ev.waitedMs });
        else if (ev.type === 'drift')
            out.drifts.push({ level: ev.finding.level });
        else if (ev.type === 'result') out.result = ev.value;
        else if (ev.type === 'error')
            out.error = { message: ev.message, status: ev.status };
        else if (ev.type === 'done') out.doneOk = ev.ok;
    }
    return out;
}

describe('sse reconnect is OFF by default (issue #71)', () => {
    test('a stream that ends is NOT reconnected — exactly one open, unchanged behaviour', async () => {
        const { adapter, requests } = scriptedAdapter([
            () => streamOf(['id: 1\ndata: a\n\n', 'id: 2\ndata: b\n\n']),
        ]);
        const s = sse({ url: 'https://x.test/e', adapter });

        const out = await drainAll(s.stream());
        expect(out.deltas).toEqual([
            { id: '1', data: 'a' },
            { id: '2', data: 'b' },
        ]);
        expect(requests).toHaveLength(1); // no reconnect
        expect(out.reconnects).toEqual([]);
        expect(out.types).toEqual([
            'start',
            'progress', // request
            'delta',
            'delta',
            'result',
            'done',
        ]);
        expect(out.doneOk).toBe(true);
    });

    test('a mid-stream error ends with error+done (no reconnect) when reconnect is off', async () => {
        const { adapter, requests } = scriptedAdapter([
            () => streamThenError(['id: 1\ndata: a\n\n']),
        ]);
        const s = sse({ url: 'https://x.test/e', adapter });

        const out = await drainAll(s.stream());
        expect(out.deltas).toEqual([{ id: '1', data: 'a' }]);
        expect(requests).toHaveLength(1);
        expect(out.types).toContain('error');
        expect(out.doneOk).toBe(false);
    });
});

describe('sse reconnect replays Last-Event-ID (issue #71)', () => {
    test('the SECOND open carries Last-Event-ID: 2 and its events continue to flow', async () => {
        // First body: id 1, id 2 then closes. Second body: id 3, id 4 then closes. The third open
        // (an empty tail) closes immediately; cap at attempts so it terminates deterministically.
        const { adapter, requests } = scriptedAdapter([
            () => streamOf(['id: 1\ndata: a\n\n', 'id: 2\ndata: b\n\n']),
            () => streamOf(['id: 3\ndata: c\n\n', 'id: 4\ndata: d\n\n']),
        ]);
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 2, backoffMs: 1 } },
            adapter,
        });

        const out = await drainAll(s.stream());
        // First open carries NO Last-Event-ID; the reconnect replays the last id seen (2), then the
        // third reconnect replays 4.
        expect(requests[0]?.headers['Last-Event-ID']).toBeUndefined();
        expect(requests[1]?.headers['Last-Event-ID']).toBe('2');
        expect(requests[2]?.headers['Last-Event-ID']).toBe('4');
        // Events from BOTH live connections flowed as deltas, in order, collected into the result.
        expect(out.deltas).toEqual([
            { id: '1', data: 'a' },
            { id: '2', data: 'b' },
            { id: '3', data: 'c' },
            { id: '4', data: 'd' },
        ]);
        expect(out.result).toEqual(out.deltas);
        expect(out.reconnects.map((r) => r.attempt)).toEqual([1, 2]);
        expect(out.doneOk).toBe(true);
    });
});

describe('sse reconnect backoff: server retry: vs fallback (issue #71)', () => {
    test('a server-sent retry: paces the reconnect (it dominates the tiny fallback)', async () => {
        // The event carries retry: 120 (ms). With a 1ms fallback, only the server value can produce
        // a ≥100ms wait — proving the server `retry:` won. One reconnect, then stop.
        const { adapter } = scriptedAdapter([
            () => streamOf(['retry: 120\nid: 1\ndata: a\n\n']),
        ]);
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 1, backoffMs: 1 } },
            adapter,
        });

        const t0 = Date.now();
        const out = await drainAll(s.stream());
        const elapsed = Date.now() - t0;
        expect(out.reconnects[0]?.waitedMs).toBe(120);
        expect(elapsed).toBeGreaterThanOrEqual(110);
        expect(out.doneOk).toBe(true);
    });

    test('with no server retry:, the configured reconnect.backoffMs is used', async () => {
        const { adapter } = scriptedAdapter([
            () => streamOf(['id: 1\ndata: a\n\n']),
        ]);
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 1, backoffMs: 90 } },
            adapter,
        });

        const t0 = Date.now();
        const out = await drainAll(s.stream());
        const elapsed = Date.now() - t0;
        expect(out.reconnects[0]?.waitedMs).toBe(90);
        expect(elapsed).toBeGreaterThanOrEqual(80);
        expect(out.doneOk).toBe(true);
    });

    test('with neither, the stitch retry backoff (fixed baseMs) supplies the delay', async () => {
        // No server retry:, no reconnect.backoffMs → fall back to the `retry` policy: fixed 70ms.
        const { adapter } = scriptedAdapter([
            () => streamOf(['id: 1\ndata: a\n\n']),
        ]);
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 1 } },
            retry: { backoff: 'fixed', baseMs: 70 },
            adapter,
        });

        const t0 = Date.now();
        const out = await drainAll(s.stream());
        const elapsed = Date.now() - t0;
        expect(out.reconnects[0]?.waitedMs).toBe(70);
        expect(elapsed).toBeGreaterThanOrEqual(60);
        expect(out.doneOk).toBe(true);
    });
});

describe('sse reconnect respects the attempts cap (issue #71)', () => {
    test('reconnects stop after N attempts; the stream ends with what it collected', async () => {
        // Every body is a single event then closes — a resumable surface treats each close as a
        // reconnect signal, so this would loop forever without the cap. attempts: 2 ⇒ 3 opens.
        const { adapter, requests } = scriptedAdapter([], {
            tail: () => streamOf(['data: tick\n\n']),
        });
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 2, backoffMs: 1 } },
            adapter,
        });

        const out = await drainAll(s.stream());
        expect(requests).toHaveLength(3); // first open + 2 reconnects
        expect(out.reconnects.map((r) => r.attempt)).toEqual([1, 2]);
        expect(out.deltas).toEqual([
            { data: 'tick' },
            { data: 'tick' },
            { data: 'tick' },
        ]);
        expect(out.doneOk).toBe(true); // a clean close after the cap finalizes successfully
    });

    test('true means enabled with sane defaults (3 reconnects) and no fallback backoff override', async () => {
        const { adapter, requests } = scriptedAdapter([], {
            tail: () => streamOf(['data: x\n\n']),
        });
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: true },
            retry: { backoff: 'fixed', baseMs: 1 }, // keep the default-attempt fallback fast
            adapter,
        });

        const out = await drainAll(s.stream());
        expect(requests).toHaveLength(4); // first open + 3 default reconnects
        expect(out.reconnects.map((r) => r.attempt)).toEqual([1, 2, 3]);
    });
});

describe('sse reconnect resumes from the last id after a mid-stream ERROR (issue #71)', () => {
    test('a body that throws partway reconnects and replays the last id seen', async () => {
        // First body emits id 1, id 2 then THROWS mid-stream. The reconnect must carry
        // Last-Event-ID: 2 and continue with the second body's events.
        const { adapter, requests } = scriptedAdapter([
            () => streamThenError(['id: 1\ndata: a\n\n', 'id: 2\ndata: b\n\n']),
            () => streamOf(['id: 3\ndata: c\n\n']),
        ]);
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 1, backoffMs: 1 } },
            adapter,
        });

        const out = await drainAll(s.stream());
        expect(requests[1]?.headers['Last-Event-ID']).toBe('2');
        expect(out.deltas).toEqual([
            { id: '1', data: 'a' },
            { id: '2', data: 'b' },
            { id: '3', data: 'c' },
        ]);
        expect(out.doneOk).toBe(true);
    });

    test('when reconnects run out on an ERROR, the real error surfaces as error+done', async () => {
        // Both opens throw; attempts: 1 ⇒ one reconnect, then the second throw is terminal and
        // its real message is surfaced (not a synthetic placeholder).
        const { adapter, requests } = scriptedAdapter([
            () => streamThenError(['id: 1\ndata: a\n\n'], new Error('drop-1')),
            () => streamThenError(['id: 2\ndata: b\n\n'], new Error('drop-2')),
        ]);
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 1, backoffMs: 1 } },
            adapter,
        });

        const out = await drainAll(s.stream());
        expect(requests).toHaveLength(2);
        expect(out.deltas).toEqual([
            { id: '1', data: 'a' },
            { id: '2', data: 'b' },
        ]);
        expect(out.error?.message).toBe('drop-2');
        expect(out.doneOk).toBe(false);
    });
});

describe('sse per-delta output validation keeps firing across a reconnect (issue #71)', () => {
    test('a bad payload on the SECOND connection still fails the stream', async () => {
        const { adapter } = scriptedAdapter([
            () => streamOf(['id: 1\ndata: {"tok":"hi"}\n\n']),
            () => streamOf(['id: 2\ndata: {"nope":1}\n\n']),
        ]);
        const s = sse({
            url: 'https://x.test/e',
            output: asValidator(z.object({ tok: z.string() })),
            sse: { reconnect: { attempts: 2, backoffMs: 1 } },
            adapter,
        });

        const out = await drainAll(s.stream());
        // The first connection's valid event flows; the reconnect's bad `.data` trips drift→error.
        expect(out.deltas).toEqual([{ id: '1', data: { tok: 'hi' } }]);
        expect(out.drifts[0]?.level).toBe('error');
        expect(out.doneOk).toBe(false);
    });
});

describe('sse reconnect config round-trips as JSON (contract-not-dependency gate)', () => {
    test('the boolean form survives JSON.parse(JSON.stringify(cfg))', () => {
        const s = sse({ url: 'https://x.test/e', sse: { reconnect: true } });
        const json = JSON.parse(JSON.stringify(s.__config)) as {
            kind?: unknown;
            sse?: { reconnect?: unknown };
        };
        expect(json.kind).toBe('sse'); // surface redacted to its id
        expect(json.sse).toEqual({ reconnect: true });
    });

    test('the object form (attempts + backoffMs) survives the round-trip intact', () => {
        const cfg = {
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 5, backoffMs: 250 } },
        };
        const s = sse(cfg);
        const json = JSON.parse(JSON.stringify(s.__config)) as {
            sse?: { reconnect?: { attempts?: number; backoffMs?: number } };
        };
        expect(json.sse?.reconnect).toEqual({ attempts: 5, backoffMs: 250 });
    });
});

describe('sse resume hooks are wired on the surface (issue #71)', () => {
    test('resumeToken reads id, resumeRetryMs reads retry, applyResume sets Last-Event-ID', () => {
        expect(sseSurface.resumeToken?.({ data: 'x', id: '7' })).toBe('7');
        expect(sseSurface.resumeRetryMs?.({ data: 'x', retry: 1500 })).toBe(
            1500,
        );
        const req: AdapterRequest = {
            url: 'https://x.test/e',
            method: 'GET',
            headers: {},
        };
        sseSurface.applyResume?.(req, '42');
        expect(req.headers['Last-Event-ID']).toBe('42');
    });
});
