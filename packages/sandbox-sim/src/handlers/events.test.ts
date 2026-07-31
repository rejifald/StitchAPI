/**
 * Smoke test for the GET /events SSE handler.
 *
 * Prints "EVENTS OK" and exits 0 on success; throws / exits non-zero on failure.
 * Uses node:assert only — no test framework required.
 */
import type { SimRequest } from '../../../../docs/sandbox/contracts/sim';
import { eventsHandlers } from './events';

import assert from 'node:assert/strict';

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
    const dec = new TextDecoder();
    let out = '';
    for await (const chunk of stream) out += dec.decode(chunk);
    return out;
}

async function main() {
    const req: SimRequest = {
        method: 'GET',
        url: new URL('https://api.example.com/events'),
        headers: new Headers(),
    };
    const handler = eventsHandlers.find((h) => h.match(req));
    assert.ok(handler, 'a handler should match GET /events');

    const res = await handler.handle(req, {});
    assert.equal(res.status, 200, '/events status should be 200');
    assert.equal(
        res.headers?.['content-type'],
        'text/event-stream',
        '/events should be an SSE response',
    );
    assert.ok(res.stream, '/events should produce a stream, not a body');

    const text = await collect(res.stream as AsyncIterable<Uint8Array>);
    assert.ok(
        text.includes('order.created'),
        'stream should include the order.created event',
    );
    assert.ok(
        text.includes('order.shipped'),
        'stream should include the order.shipped event',
    );
    assert.ok(
        text.trimEnd().endsWith('data: [DONE]'),
        'stream should terminate with a [DONE] frame',
    );

    // POST /events (wrong method) should not match.
    const post: SimRequest = {
        method: 'POST',
        url: new URL('https://api.example.com/events'),
        headers: new Headers(),
    };
    assert.equal(
        eventsHandlers.some((h) => h.match(post)),
        false,
        'POST /events should not be matched',
    );

    console.log('EVENTS OK');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
