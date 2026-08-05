// Resumable SSE (issue #71): the `sse` surface reconnects a dropped `text/event-stream`, replaying
// the last `id:` as the `Last-Event-ID` request header and honouring a server-sent `retry:` as the
// reconnect backoff (falling back to `reconnect.delay` / the stitch's `retry` policy). Off by
// default — these specs prove both the unchanged default and the opt-in reconnect loop, driving
// timing the way the repo's other backoff tests do: small distinct delays + real elapsed bounds
// (no fake timers anywhere in this package).
import { stitch } from '../src';
import type { Surface } from '../src';
import { type SseEvent, sse, sseSurface } from '../src/sse';
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
    reconnects: { attempt: number; waited: number | undefined }[];
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
            out.reconnects.push({ attempt: ev.attempt, waited: ev.waited });
        else if (ev.type === 'drift')
            out.drifts.push({ level: ev.finding.level });
        else if (ev.type === 'result') out.result = ev.data;
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
        // First body: id 1, id 2 then DROPS. Second body: id 3, id 4 then drops too. The third open
        // (an empty tail) closes cleanly, which ends the stream (#640).
        const { adapter, requests } = scriptedAdapter([
            () => streamThenError(['id: 1\ndata: a\n\n', 'id: 2\ndata: b\n\n']),
            () => streamThenError(['id: 3\ndata: c\n\n', 'id: 4\ndata: d\n\n']),
        ]);
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 2, delay: 1 } },
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

describe('sse reconnect delay: server retry: vs fallback (issue #71)', () => {
    test('a server-sent retry: paces the reconnect (it dominates the tiny fallback)', async () => {
        // The event carries retry: 120 (ms). With a 1ms fallback, only the server value can produce
        // a ≥100ms wait — proving the server `retry:` won. One reconnect, then stop.
        const { adapter } = scriptedAdapter([
            () => streamThenError(['retry: 120\nid: 1\ndata: a\n\n']),
        ]);
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 1, delay: 1 } },
            adapter,
        });

        const t0 = Date.now();
        const out = await drainAll(s.stream());
        const elapsed = Date.now() - t0;
        expect(out.reconnects[0]?.waited).toBe(120);
        expect(elapsed).toBeGreaterThanOrEqual(110);
        expect(out.doneOk).toBe(true);
    });

    test('with no server retry:, the configured reconnect.delay is used', async () => {
        const { adapter } = scriptedAdapter([
            () => streamThenError(['id: 1\ndata: a\n\n']),
        ]);
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 1, delay: 90 } },
            adapter,
        });

        const t0 = Date.now();
        const out = await drainAll(s.stream());
        const elapsed = Date.now() - t0;
        expect(out.reconnects[0]?.waited).toBe(90);
        expect(elapsed).toBeGreaterThanOrEqual(80);
        expect(out.doneOk).toBe(true);
    });

    test('with neither, the stitch retry backoff (fixed backoff.base) supplies the delay', async () => {
        // No server retry:, no reconnect.delay → fall back to the `retry` policy: fixed 70ms.
        const { adapter } = scriptedAdapter([
            () => streamThenError(['id: 1\ndata: a\n\n']),
        ]);
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 1 } },
            retry: { backoff: { curve: 'fixed', base: 70 } },
            adapter,
        });

        const t0 = Date.now();
        const out = await drainAll(s.stream());
        const elapsed = Date.now() - t0;
        expect(out.reconnects[0]?.waited).toBe(70);
        expect(elapsed).toBeGreaterThanOrEqual(60);
        expect(out.doneOk).toBe(true);
    });
});

describe('a surface may return the canonical duration form from resumeRetry (P17)', () => {
    // `resumeRetry` is a value the SURFACE AUTHOR writes, so P17's consumer-authored widening
    // reaches it — the same call `SurfaceOutcome.after` got in #609, feeding the same sleep site.
    // Before the widening a token reached `sleepWithin` raw, where `setTimeout('120ms')` coerces
    // to NaN and fires immediately: the wait collapsed to ~0 with no error to see.
    const returning = (retry: number | string | undefined): Surface => ({
        ...sseSurface,
        resumeRetry: () => retry,
    });

    test('a duration token paces the reconnect exactly as the raw ms does', async () => {
        const { adapter } = scriptedAdapter([
            () => streamThenError(['id: 1\ndata: a\n\n']),
        ]);
        const s = stitch({
            kind: returning('120ms'),
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 1, delay: 1 } },
            adapter,
        });

        const t0 = Date.now();
        const out = await drainAll(s.stream());
        const elapsed = Date.now() - t0;
        // Parsed: neither NaN (the silent collapse) nor the 1ms fallback (the token ignored).
        expect(out.reconnects[0]?.waited).toBe(120);
        expect(elapsed).toBeGreaterThanOrEqual(110);
        expect(out.doneOk).toBe(true);
    });

    test('an unparseable token falls through to the fallback instead of collapsing the wait', async () => {
        const { adapter } = scriptedAdapter([
            () => streamThenError(['id: 1\ndata: a\n\n']),
        ]);
        const s = stitch({
            kind: returning('soon'),
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 1, delay: 90 } },
            adapter,
        });

        const t0 = Date.now();
        const out = await drainAll(s.stream());
        const elapsed = Date.now() - t0;
        expect(out.reconnects[0]?.waited).toBe(90); // reconnect.delay, untouched by the junk
        expect(elapsed).toBeGreaterThanOrEqual(80);
        expect(out.doneOk).toBe(true);
    });
});

describe('sse reconnect respects the attempts cap (issue #71)', () => {
    test('reconnects stop after N attempts, then the last drop surfaces', async () => {
        // Every body emits one id-carrying event then DROPS, so the stream stays resumable and
        // would reconnect forever without the cap. attempts: 2 ⇒ 3 opens, then the third drop is
        // terminal and its real error surfaces with the deltas collected so far preserved.
        const { adapter, requests } = scriptedAdapter([], {
            tail: () => streamThenError(['id: t\ndata: tick\n\n']),
        });
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 2, delay: 1 } },
            adapter,
        });

        const out = await drainAll(s.stream());
        expect(requests).toHaveLength(3); // first open + 2 reconnects
        expect(out.reconnects.map((r) => r.attempt)).toEqual([1, 2]);
        expect(out.deltas).toEqual([
            { id: 't', data: 'tick' },
            { id: 't', data: 'tick' },
            { id: 't', data: 'tick' },
        ]);
        expect(out.error?.message).toBe('stream broke mid-flight');
        expect(out.doneOk).toBe(false);
    });

    test('true means enabled with sane defaults (3 reconnects) and no fallback backoff override', async () => {
        const { adapter, requests } = scriptedAdapter([], {
            tail: () => streamThenError(['id: x\ndata: x\n\n']),
        });
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: true },
            retry: { backoff: { curve: 'fixed', base: 1 } }, // keep the default-attempt fallback fast
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
            sse: { reconnect: { attempts: 1, delay: 1 } },
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
            sse: { reconnect: { attempts: 1, delay: 1 } },
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
            () => streamThenError(['id: 1\ndata: {"tok":"hi"}\n\n']),
            () => streamOf(['id: 2\ndata: {"nope":1}\n\n']),
        ]);
        const s = sse({
            url: 'https://x.test/e',
            output: asValidator(z.object({ tok: z.string() })),
            sse: { reconnect: { attempts: 2, delay: 1 } },
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

    test('the object form (attempts + delay) survives the round-trip intact', () => {
        const cfg = {
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 5, delay: 250 } },
        };
        const s = sse(cfg);
        const json = JSON.parse(JSON.stringify(s.__config)) as {
            sse?: { reconnect?: { attempts?: number; delay?: number } };
        };
        expect(json.sse?.reconnect).toEqual({ attempts: 5, delay: 250 });
    });
});

describe('sse reconnect never replays a stream that FINISHED (issue #640)', () => {
    // The OpenAI shape: `data: {…}` frames with NO `id:` on any of them, terminated by a `[DONE]`
    // sentinel. Nothing in it is resumable — a reopened request carries no `Last-Event-ID`, so it
    // can only ask for the WHOLE completion again. Before #640 this opened 4×, delivered
    // `ABCDEABCDEABCDEABCDE`, and still ended `done(ok: true)`.
    const completion = (): ReadableStream<Uint8Array> =>
        streamOf([
            ...['A', 'B', 'C', 'D', 'E'].map(
                (tok) => `data: {"delta":"${tok}"}\n\n`,
            ),
            'data: [DONE]\n\n',
        ]);

    // The text a consumer assembles off the `delta` spine; the `[DONE]` sentinel parses to a bare
    // string and contributes nothing.
    const textOf = (deltas: unknown[]): string =>
        deltas
            .map((ev) => (ev as SseEvent<{ delta?: string }>).data)
            .map((d) => (typeof d === 'string' ? '' : (d.delta ?? '')))
            .join('');

    test('an id-less completion is opened ONCE and delivered ONCE', async () => {
        // Every open serves the whole completion, exactly as a model API would.
        const { adapter, requests } = scriptedAdapter([], { tail: completion });
        const s = sse({
            url: 'https://api.vendor.test/v1/chat',
            sse: { reconnect: true },
            retry: { backoff: { curve: 'fixed', base: 1 } }, // a fast curve, if it were ever used
            adapter,
        });

        const out = await drainAll(s.stream());
        expect(requests).toHaveLength(1); // was 4
        expect(textOf(out.deltas)).toBe('ABCDE'); // was ABCDEABCDEABCDEABCDE
        expect(out.deltas).toHaveLength(6); // 5 tokens + [DONE]; was 24
        expect(out.reconnects).toEqual([]);
        expect(out.doneOk).toBe(true); // a finished stream is still a SUCCESS
    });

    test('the `sse: true` shorthand carries the same fix', async () => {
        // `sse: true` normalizes to `{ reconnect: true }`, so it reaches the identical policy.
        const { adapter, requests } = scriptedAdapter([], { tail: completion });
        const s = sse({
            url: 'https://api.vendor.test/v1/chat',
            sse: true,
            retry: { backoff: { curve: 'fixed', base: 1 } },
            adapter,
        });

        const out = await drainAll(s.stream());
        expect(requests).toHaveLength(1);
        expect(textOf(out.deltas)).toBe('ABCDE');
        expect(out.doneOk).toBe(true);
    });

    test('an id-CARRYING feed that ends cleanly is not reopened either', async () => {
        // Defect 2 on its own: the body ran out with nothing to resume from. Reopening would only
        // replay `Last-Event-ID: 2` for a stream that already said everything it had.
        const { adapter, requests } = scriptedAdapter([
            () => streamOf(['id: 1\ndata: a\n\n', 'id: 2\ndata: b\n\n']),
        ]);
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 3, delay: 1 } },
            adapter,
        });

        const out = await drainAll(s.stream());
        expect(requests).toHaveLength(1);
        expect(out.deltas).toEqual([
            { id: '1', data: 'a' },
            { id: '2', data: 'b' },
        ]);
        expect(out.reconnects).toEqual([]);
        expect(out.doneOk).toBe(true);
    });

    test('an id-less stream that genuinely DROPS surfaces error+done, never a replay', async () => {
        // Defect 1 on its own: a real drop, but no resume token was ever seen, so a reopen would
        // re-deliver the two events already in the consumer's hands. Refuse, and report the drop —
        // exactly what the same stitch does with `reconnect` off.
        const { adapter, requests } = scriptedAdapter([
            () => streamThenError(['data: a\n\n', 'data: b\n\n']),
        ]);
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 3, delay: 1 } },
            adapter,
        });

        const out = await drainAll(s.stream());
        expect(requests).toHaveLength(1);
        expect(out.deltas).toEqual([{ data: 'a' }, { data: 'b' }]);
        expect(out.error?.message).toBe('stream broke mid-flight');
        expect(out.doneOk).toBe(false);
    });

    test('a drop before ANY delta still reconnects — there is nothing to duplicate', async () => {
        // The token gate is about not re-delivering what the consumer already has. A connection
        // that never handed over a chunk has nothing to duplicate, so the id-less connect-phase
        // failure keeps reconnecting exactly as before — this fix is not "reconnect off".
        const requests: AdapterRequest[] = [];
        let n = 0;
        const adapter: Adapter = (req) => {
            requests.push(req);
            if (n++ === 0) return Promise.reject(new Error('ECONNRESET'));
            return Promise.resolve({
                status: 200,
                headers: {},
                body: streamOf(['data: a\n\n']),
            });
        };
        const s = sse({
            url: 'https://x.test/e',
            sse: { reconnect: { attempts: 2, delay: 1 } },
            adapter,
        });

        const out = await drainAll(s.stream());
        expect(requests).toHaveLength(2); // the failed connect, then a successful one
        expect(out.reconnects.map((r) => r.attempt)).toEqual([1]);
        expect(out.deltas).toEqual([{ data: 'a' }]); // delivered once, not twice
        expect(out.doneOk).toBe(true);
    });
});

describe('sse resume hooks are wired on the surface (issue #71)', () => {
    test('resumeToken reads id, resumeRetry reads retry, applyResume sets Last-Event-ID', () => {
        expect(sseSurface.resumeToken?.({ data: 'x', id: '7' })).toBe('7');
        expect(sseSurface.resumeRetry?.({ data: 'x', retry: 1500 })).toBe(1500);
        const req: AdapterRequest = {
            url: 'https://x.test/e',
            method: 'GET',
            headers: {},
        };
        sseSurface.applyResume?.(req, '42');
        expect(req.headers['Last-Event-ID']).toBe('42');
    });
});
