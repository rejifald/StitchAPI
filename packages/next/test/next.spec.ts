// @stitchapi/next behaviour — Web-standard Response helpers driven with fake event
// sources and errors. No engine, no Next.
import { isStitchError, sseResponse, stitchErrorResponse } from '../src';

import type { StitchEvent } from 'stitchapi';
import { describe, expect, test } from 'vitest';

async function* events(
    ...evs: StitchEvent[]
): AsyncGenerator<StitchEvent, void> {
    for (const e of evs) {
        await Promise.resolve();
        yield e;
    }
}

const delta = (chunk: unknown): StitchEvent => ({
    type: 'delta',
    chunk,
    at: 0,
});
const result = (value: unknown): StitchEvent => ({
    type: 'result',
    data: value,
    status: 200,
    attempts: 1,
    at: 0,
});
const done: StitchEvent = {
    type: 'done',
    ok: true,
    elapsed: 1,
    attempts: 1,
    at: 0,
};

function stitchError(message: string, status?: number): Error {
    const e = new Error(message) as Error & { status?: number };
    e.name = 'StitchError';
    if (status !== undefined) e.status = status;
    return e;
}

// --- sseResponse -----------------------------------------------------------

describe('sseResponse', () => {
    test('streams each delta as an SSE frame and sets the content type', async () => {
        const res = sseResponse(
            events(delta('a'), delta('b'), result(['a', 'b']), done),
        );
        expect(res.headers.get('content-type')).toBe(
            'text/event-stream; charset=utf-8',
        );
        const body = await res.text();
        expect(body).toBe('data: a\n\ndata: b\n\n');
    });

    test('a `data` mapper pulls text out of a structured chunk', async () => {
        const res = sseResponse(events(delta({ text: 'hi' }), done), {
            data: (c) => (c as { text: string }).text,
        });
        expect(await res.text()).toBe('data: hi\n\n');
    });

    test('an error event ends the stream with a named error frame', async () => {
        const res = sseResponse(
            events(delta('a'), {
                type: 'error',
                name: 'StitchError',
                message: 'boom',
                status: 500,
                attempts: 1,
                at: 0,
            }),
        );
        const body = await res.text();
        expect(body).toContain('data: a\n\n');
        expect(body).toContain('event: error');
        expect(body).toContain('"message":"boom"');
    });

    test('the event option labels each frame', async () => {
        const res = sseResponse(events(delta('a'), done), { event: 'token' });
        expect(await res.text()).toBe('event: token\ndata: a\n\n');
    });

    test('the id option emits an id: line per frame with the zero-based index', async () => {
        const res = sseResponse(events(delta('a'), delta('b'), done), {
            id: (chunk, i) => `${String(chunk)}-${i}`,
        });
        expect(await res.text()).toBe(
            'id: a-0\ndata: a\n\nid: b-1\ndata: b\n\n',
        );
    });

    test('a multi-line chunk gets one data: prefix per line (SSE spec)', async () => {
        const res = sseResponse(events(delta('l1\nl2'), done));
        expect(await res.text()).toBe('data: l1\ndata: l2\n\n');
    });

    test('extra headers merge over the SSE defaults, with overrides winning', async () => {
        const res = sseResponse(events(delta('a'), done), {
            headers: { 'x-custom': '1', 'cache-control': 'no-store' },
        });
        expect(res.headers.get('x-custom')).toBe('1');
        // A default that is not overridden survives…
        expect(res.headers.get('content-type')).toBe(
            'text/event-stream; charset=utf-8',
        );
        // …and an explicit override wins (spread after the defaults).
        expect(res.headers.get('cache-control')).toBe('no-store');
        await res.text();
    });

    test('a pre-aborted signal yields no frames', async () => {
        const res = sseResponse(events(delta('a'), delta('b'), done), {
            signal: AbortSignal.abort(),
        });
        expect(await res.text()).toBe('');
    });

    test('a throw mid-stream ends with an error frame carrying the message', async () => {
        async function* boom(): AsyncGenerator<StitchEvent, void> {
            yield delta('a');
            throw new Error('stream blew up');
        }
        const res = sseResponse(boom());
        const body = await res.text();
        expect(body).toContain('data: a\n\n');
        expect(body).toContain('event: error');
        expect(body).toContain('"message":"stream blew up"');
    });
});

// --- stitchErrorResponse ---------------------------------------------------

describe('stitchErrorResponse', () => {
    test('a StitchError maps to 502 by default with a JSON body', async () => {
        const res = stitchErrorResponse(stitchError('upstream down', 503));
        expect(res.status).toBe(502);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(await res.json()).toEqual({ error: 'upstream down' });
    });

    test('status can propagate the upstream status', async () => {
        const res = stitchErrorResponse(stitchError('rate limited', 429), {
            status: (e) => e.status ?? 502,
        });
        expect(res.status).toBe(429);
    });

    test('a non-StitchError defaults to 500', async () => {
        const res = stitchErrorResponse(new Error('oops'));
        expect(res.status).toBe(500);
    });
});

describe('isStitchError', () => {
    test('matches the branded error only', () => {
        expect(isStitchError(stitchError('x'))).toBe(true);
        expect(isStitchError(new Error('x'))).toBe(false);
        expect(isStitchError('x')).toBe(false);
    });
});
