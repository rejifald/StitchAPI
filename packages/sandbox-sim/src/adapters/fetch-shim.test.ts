/**
 * fetch-shim normalization tests — the request-shaping `dispatch.test.ts` (T6–T8)
 * does not reach.
 *
 * dispatch.test.ts already drives the shim for a string input, the sandbox-404
 * (unknown host), a known JSON route, and a streamed Response. This file covers
 * the request NORMALIZATION the shim owns: URL- and Request-object inputs, method
 * upper-casing and the GET default, header parsing, body parsing (JSON / text /
 * ReadableStream / absent), and the per-call `getDefaultKnobs` read.
 *
 * Uses only node:assert + an inline echo handler. Run with:
 *   npx tsx packages/sandbox-sim/src/adapters/fetch-shim.test.ts
 */
import type {
    SimHandler,
    SimKnobs,
    SimRequest,
    SimResponse,
} from '../../../../docs/sandbox/contracts/sim';
import { createFetchShim } from './fetch-shim';

import assert from 'node:assert/strict';

// An echo handler that reflects the NORMALIZED request back as JSON, so a test
// asserts exactly what the shim produced from the raw fetch arguments.
const echo: SimHandler = {
    match(req: SimRequest): boolean {
        return req.url.pathname === '/echo';
    },
    handle(req: SimRequest, _knobs: SimKnobs): SimResponse {
        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: {
                method: req.method,
                path: req.url.pathname,
                auth: req.headers.get('authorization'),
                body: req.body,
            },
        };
    },
};

const HANDLERS: SimHandler[] = [echo];
const ECHO = 'https://api.example.com/echo';

async function main(): Promise<void> {
    // T1: a lowercase init.method is upper-cased, a plain-object header reaches
    // the handler, and a JSON string body is parsed to an object.
    {
        const fetchShim = createFetchShim(HANDLERS);
        const res = await fetchShim(ECHO, {
            method: 'post',
            headers: { authorization: 'Bearer X' },
            body: JSON.stringify({ hi: 1 }),
        });
        assert.equal(res.status, 200, 'T1: status');
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.method, 'POST', 'T1: method upper-cased');
        assert.equal(body.auth, 'Bearer X', 'T1: object header normalized');
        assert.deepEqual(body.body, { hi: 1 }, 'T1: JSON string body parsed');
        console.log('T1 PASS — method/header/JSON-body normalization');
    }

    // T2: a non-JSON string body falls back to raw text.
    {
        const fetchShim = createFetchShim(HANDLERS);
        const res = await fetchShim(ECHO, {
            method: 'PUT',
            body: 'plain-text',
        });
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.method, 'PUT', 'T2: explicit method');
        assert.equal(body.body, 'plain-text', 'T2: non-JSON body kept as text');
        console.log('T2 PASS — text body fallback');
    }

    // T3: with no init, the method defaults to GET and the body is absent.
    {
        const fetchShim = createFetchShim(HANDLERS);
        const res = await fetchShim(ECHO);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.method, 'GET', 'T3: default method GET');
        assert.equal(body.body, undefined, 'T3: absent body → undefined');
        console.log('T3 PASS — default GET, no body');
    }

    // T4: a URL-object input is accepted (not only a string).
    {
        const fetchShim = createFetchShim(HANDLERS);
        const res = await fetchShim(new URL(ECHO));
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.path, '/echo', 'T4: URL object input');
        console.log('T4 PASS — URL object input');
    }

    // T5: a Request-object input — method + headers are read off the Request.
    {
        const fetchShim = createFetchShim(HANDLERS);
        const req = new Request(ECHO, {
            method: 'DELETE',
            headers: { authorization: 'Bearer R' },
        });
        const res = await fetchShim(req);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.method, 'DELETE', 'T5: method off Request');
        assert.equal(body.auth, 'Bearer R', 'T5: headers off Request');
        console.log('T5 PASS — Request object input');
    }

    // T6: a ReadableStream body is drained to text, then best-effort JSON-parsed.
    {
        const fetchShim = createFetchShim(HANDLERS);
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('{"streamed":'));
                controller.enqueue(new TextEncoder().encode('true}'));
                controller.close();
            },
        });
        const res = await fetchShim(ECHO, { method: 'POST', body: stream });
        const body = (await res.json()) as Record<string, unknown>;
        assert.deepEqual(
            body.body,
            { streamed: true },
            'T6: stream body drained + parsed',
        );
        console.log('T6 PASS — ReadableStream body drained');
    }

    // T7: getDefaultKnobs is read on EVERY call, so the host can vary the baseline
    // between runs without rebuilding the shim.
    {
        let status = 500;
        const fetchShim = createFetchShim(HANDLERS, () => ({ status }));
        const r1 = await fetchShim(ECHO);
        assert.equal(r1.status, 500, 'T7: first call uses the current knob');
        status = 503;
        const r2 = await fetchShim(ECHO);
        assert.equal(r2.status, 503, 'T7: knob re-read on the next call');
        console.log('T7 PASS — getDefaultKnobs read per call');
    }

    console.log('\nfetch-shim OK');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
