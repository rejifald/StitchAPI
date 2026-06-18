/**
 * Demo SSE event stream — GET /events.
 *
 * A short, deterministic Server-Sent-Events stream of order-lifecycle events,
 * terminated by a `[DONE]` frame. Mirrors the wire format the LLM endpoint uses
 * (S3) so the `sse` surface and the event spine have a plain (non-LLM) demo to
 * run against.
 *
 * Determinism: fixed event list, no Date.now / Math.random.
 */
import type {
    SimHandler,
    SimKnobs,
    SimRequest,
    SimResponse,
} from '../../../../docs/sandbox/contracts/sim';

const enc = new TextEncoder();

function sseFrame(payload: unknown): Uint8Array {
    return enc.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

/** Fixed order-lifecycle events — deterministic, keyed to the orders fixture. */
const EVENTS: readonly unknown[] = [
    { type: 'order.created', id: 2001, total: 999 },
    { type: 'order.paid', id: 1001, total: 4200 },
    { type: 'order.shipped', id: 1002, total: 1899 },
];

async function* makeEventsStream(): AsyncIterable<Uint8Array> {
    for (const event of EVENTS) {
        yield sseFrame(event);
    }
    yield enc.encode('data: [DONE]\n\n');
}

const eventsHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return req.method === 'GET' && req.url.pathname === '/events';
    },

    handle(_req: SimRequest, _knobs: SimKnobs): SimResponse {
        return {
            status: 200,
            headers: {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
            },
            stream: makeEventsStream(),
        };
    },
};

export const eventsHandlers: SimHandler[] = [eventsHandler];
