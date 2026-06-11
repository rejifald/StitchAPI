/**
 * S5 smoke tests — dispatch core + adapters.
 *
 * Uses only node:assert + inline toy handlers.
 * Run with: npx tsx packages/sandbox-sim/src/dispatch.test.ts
 */
import type {
    SimHandler,
    SimKnobs,
    SimRequest,
    SimResponse,
} from '../../../docs/playground/contracts/sim';
import { createFetchShim } from './adapters/node';
import { dispatch, resetFlaky } from './dispatch';

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Inline toy handlers
// ---------------------------------------------------------------------------

const helloHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return req.method === 'GET' && req.url.pathname === '/hello';
    },
    handle(_req: SimRequest, _knobs: SimKnobs): SimResponse {
        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: { message: 'hello from sandbox' },
        };
    },
};

const echoHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return req.method === 'POST' && req.url.pathname === '/echo';
    },
    handle(req: SimRequest, _knobs: SimKnobs): SimResponse {
        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: { echo: req.body },
        };
    },
};

const HANDLERS: SimHandler[] = [helloHandler, echoHandler];

// ---------------------------------------------------------------------------
// Helper: make a minimal SimRequest
// ---------------------------------------------------------------------------

function makeReq(url: string, method = 'GET', body?: unknown): SimRequest {
    return {
        method,
        url: new URL(url),
        headers: new Headers(),
        body,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    // -----------------------------------------------------------------------
    // Test 1: match → handle path
    // -----------------------------------------------------------------------
    {
        const res = await dispatch(
            HANDLERS,
            makeReq('https://demo.stitchapi.dev/hello'),
        );
        assert.equal(res.status, 200, 'T1: status should be 200');
        assert.deepEqual(
            res.body,
            { message: 'hello from sandbox' },
            'T1: body should match handler output',
        );
        console.log('T1 PASS — match→handle');
    }

    // -----------------------------------------------------------------------
    // Test 2: unknown route → sandbox-404 body, never real network
    // -----------------------------------------------------------------------
    {
        const res = await dispatch(
            HANDLERS,
            makeReq('https://demo.stitchapi.dev/not-a-real-route'),
        );
        assert.equal(res.status, 404, 'T2: unknown route should be 404');
        const body = res.body as Record<string, unknown>;
        assert.equal(body.error, 'sandbox_not_found', 'T2: error field');
        assert.ok(
            typeof body.message === 'string' &&
                body.message.includes(
                    'is not reachable inside the StitchAPI sandbox',
                ),
            'T2: message should mention sandbox',
        );
        assert.equal(body.sandbox, true, 'T2: sandbox flag');
        console.log('T2 PASS — unknown route → sandbox-404');
    }

    // -----------------------------------------------------------------------
    // Test 3: __status=500 override
    // -----------------------------------------------------------------------
    {
        const res = await dispatch(
            HANDLERS,
            makeReq('https://demo.stitchapi.dev/hello?__status=500'),
        );
        assert.equal(res.status, 500, 'T3: status knob should override to 500');
        // body still comes from the handler
        assert.deepEqual(
            res.body,
            { message: 'hello from sandbox' },
            'T3: handler body should still be present',
        );
        console.log('T3 PASS — __status=500 override');
    }

    // -----------------------------------------------------------------------
    // Test 4: __flaky=2 fails twice then succeeds
    // -----------------------------------------------------------------------
    {
        resetFlaky();
        const url = 'https://demo.stitchapi.dev/hello?__flaky=2';

        const r1 = await dispatch(HANDLERS, makeReq(url));
        assert.equal(r1.status, 503, 'T4: flaky attempt 1 should be 503');

        const r2 = await dispatch(HANDLERS, makeReq(url));
        assert.equal(r2.status, 503, 'T4: flaky attempt 2 should be 503');

        const r3 = await dispatch(HANDLERS, makeReq(url));
        assert.equal(
            r3.status,
            200,
            'T4: flaky attempt 3 should succeed (200)',
        );
        assert.deepEqual(
            r3.body,
            { message: 'hello from sandbox' },
            'T4: body on success',
        );

        console.log('T4 PASS — __flaky=2 fails twice then succeeds');
    }

    // -----------------------------------------------------------------------
    // Test 5: __stream=sse wraps body as an AsyncIterable stream
    // -----------------------------------------------------------------------
    {
        const res = await dispatch(
            HANDLERS,
            makeReq('https://demo.stitchapi.dev/hello?__stream=sse'),
        );
        assert.ok(res.stream !== undefined, 'T5: stream should be present');
        assert.equal(
            res.body,
            undefined,
            'T5: body should be undefined when stream is set',
        );

        const chunks: string[] = [];
        for await (const chunk of res.stream!) {
            chunks.push(new TextDecoder().decode(chunk));
        }
        const full = chunks.join('');
        assert.ok(
            full.includes('data:'),
            'T5: SSE output should contain "data:"',
        );
        assert.ok(
            full.includes('hello from sandbox'),
            'T5: SSE output should contain original body content',
        );
        assert.ok(
            full.includes('[DONE]'),
            'T5: SSE output should contain [DONE]',
        );
        console.log('T5 PASS — __stream=sse wraps body as stream');
    }

    // -----------------------------------------------------------------------
    // Test 6: unknown host via node adapter → sandbox-404, no real network
    // -----------------------------------------------------------------------
    {
        const fetchShim = createFetchShim(HANDLERS);
        const res = await fetchShim('https://evil.example.com/x');
        assert.equal(res.status, 404, 'T6: unknown host should be 404');
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.error, 'sandbox_not_found', 'T6: error field');
        assert.ok(
            typeof body.message === 'string' &&
                body.message.includes(
                    'is not reachable inside the StitchAPI sandbox',
                ),
            'T6: sandbox message for unknown host',
        );
        console.log(
            'T6 PASS — unknown host via node adapter → sandbox-404, no real network',
        );
    }

    // -----------------------------------------------------------------------
    // Test 7: node adapter — known route returns correct Response
    // -----------------------------------------------------------------------
    {
        const fetchShim = createFetchShim(HANDLERS);
        const res = await fetchShim('https://demo.stitchapi.dev/hello');
        assert.equal(
            res.status,
            200,
            'T7: status 200 for known route via adapter',
        );
        const body = (await res.json()) as Record<string, unknown>;
        assert.deepEqual(
            body,
            { message: 'hello from sandbox' },
            'T7: body via adapter',
        );
        console.log('T7 PASS — node adapter known route');
    }

    // -----------------------------------------------------------------------
    // Test 8: node adapter — streaming Response has a ReadableStream body
    // -----------------------------------------------------------------------
    {
        const fetchShim = createFetchShim(HANDLERS);
        const res = await fetchShim(
            'https://demo.stitchapi.dev/hello?__stream=sse',
        );
        assert.equal(res.status, 200, 'T8: streaming status 200');
        assert.ok(
            res.body instanceof ReadableStream,
            'T8: body should be ReadableStream',
        );
        const text = await res.text();
        assert.ok(text.includes('data:'), 'T8: SSE response text via adapter');
        console.log('T8 PASS — node adapter streaming Response');
    }

    console.log('\nS5 OK');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
