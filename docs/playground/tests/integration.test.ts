/**
 * T-α — Integration test over the REAL sim + dispatch layer.
 *
 * After `registerAllHandlers()`, builds the node fetch-shim over `allHandlers`
 * and asserts the §9-relevant behaviours end-to-end by issuing fetch-shim
 * requests. This is the "what does the fake API actually do, end-to-end" proof
 * that the per-unit smokes (S2–S5, D1, R1, U1) don't individually give.
 *
 * Covers the §9 acceptance criteria and enough SEC-xx invariants to prove the
 * sim/dispatch integration is wired correctly. Browser-only invariants
 * (CSP, Worker termination, globalThis isolation) remain in R1's worker_threads
 * harness — that's the right home for them.
 *
 * Run with:  npx -y tsx docs/playground/tests/integration.test.ts
 * Expected:  prints "T-ALPHA OK" with a pass/fail count, exits 0.
 */

import { registerAllHandlers, allHandlers } from '../../../packages/sandbox-sim/src/handlers/index';
import { createFetchShim } from '../../../packages/sandbox-sim/src/adapters/node';
import { resetFlaky } from '../../../packages/sandbox-sim/src/dispatch';
import { scanSurface } from '../contracts/scan-surface';

// ---------------------------------------------------------------------------
// Minimal assertion harness (no framework needed)
// ---------------------------------------------------------------------------

/**
 * Typed assertion function — asserts c is truthy.
 * Throws with `msg` when the assertion fails.
 */
function assert(c: unknown, msg?: string): asserts c {
    if (!c) throw new Error(msg ?? 'Assertion failed');
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  ok  ${name}`);
    } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`  FAIL [${name}]: ${msg}`);
        console.error(`  FAIL ${name}: ${msg}`);
    }
}

// ---------------------------------------------------------------------------
// Main: setup + all checks run in sequence inside async main()
// ---------------------------------------------------------------------------

async function main(): Promise<void> {

// Setup: register all handlers once; build the shim
registerAllHandlers();
const simFetch = createFetchShim(allHandlers);

// ---------------------------------------------------------------------------
// §9 / SEC-xx integration checks
// ---------------------------------------------------------------------------

// 1. Error/status: /status/500 → 500
await check('/status/500 → 500', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/status/500');
    assert(res.status === 500, `Expected 500, got ${res.status}`);
    const body = await res.json() as Record<string, unknown>;
    assert(body.sandbox === true, 'Expected body.sandbox === true');
    assert(body.status === 500, `Expected body.status === 500, got ${String(body.status)}`);
});

// 2. Error/status: /malformed → 200 with non-JSON body
await check('/malformed → 200 with HTML (non-JSON) body', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/malformed');
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const text = await res.text();
    assert(text.startsWith('<!DOCTYPE html>'), 'Expected HTML body to start with <!DOCTYPE html>');
    // Content-type must be text/html, not application/json
    const ct = res.headers.get('content-type') ?? '';
    assert(ct.includes('text/html'), `Expected text/html content-type, got ${ct}`);
});

// 3. /drift?__drift=1 → drifted payload that fails {id:number, name:string}
//    Asserted structurally — no zod import.
await check('/drift?__drift=1 → payload fails {id:number,name:string} shape', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/drift?__drift=1');
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const body = await res.json() as Record<string, unknown>;
    // Drift violations: id should be string (not number), name absent, extra present
    assert(typeof body.id === 'string', `DRIFT: body.id should be string, got ${typeof body.id}`);
    assert(!('name' in body), 'DRIFT: body.name should be absent');
    assert('extra' in body, 'DRIFT: body.extra should be present');
});

// 3b. /drift (no drift) → schema-valid {id:number, name:string}
await check('/drift (no drift) → valid {id:number, name:string} shape', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/drift');
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const body = await res.json() as Record<string, unknown>;
    assert(typeof body.id === 'number', `body.id should be number, got ${typeof body.id}`);
    assert(typeof body.name === 'string', `body.name should be string, got ${typeof body.name}`);
    assert(!('extra' in body), 'body.extra should not be present');
});

// 4. /limited → 429 + Retry-After
await check('/limited → 429 + Retry-After header', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/limited');
    assert(res.status === 429, `Expected 429, got ${res.status}`);
    const retryAfter = res.headers.get('Retry-After');
    assert(retryAfter !== null, 'Expected Retry-After header to be present');
    assert(retryAfter === '1', `Expected Retry-After: 1, got ${retryAfter}`);
    const body = await res.json() as Record<string, unknown>;
    assert(body.error === 'rate_limited', `Expected error=rate_limited, got ${String(body.error)}`);
    assert(body.retryAfterSeconds === 1, `Expected retryAfterSeconds=1, got ${String(body.retryAfterSeconds)}`);
});

// 5. __flaky=2 → fails twice then succeeds
await check('__flaky=2 → fails twice then succeeds (§9 resilience)', async () => {
    resetFlaky();
    const url = 'https://demo.stitchapi.dev/limited?__flaky=2';
    const r1 = await simFetch(url);
    assert(r1.status === 503, `Attempt 1: expected 503, got ${r1.status}`);
    const r2 = await simFetch(url);
    assert(r2.status === 503, `Attempt 2: expected 503, got ${r2.status}`);
    const r3 = await simFetch(url);
    // After 2 flaky failures the dispatch falls through to the real handler (429)
    assert(r3.status !== 503, `Attempt 3: expected non-503, got ${r3.status}`);
});

// 6. /auth/me → 401 without bearer
await check('/auth/me → 401 without bearer (§9 auth)', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/auth/me');
    assert(res.status === 401, `Expected 401, got ${res.status}`);
    const body = await res.json() as Record<string, unknown>;
    assert(body.error === 'unauthorized', `Expected error=unauthorized, got ${String(body.error)}`);
    const wwwAuth = res.headers.get('WWW-Authenticate');
    assert(wwwAuth !== null, 'Expected WWW-Authenticate header');
});

// 7. /auth/me → 200 with bearer token
await check('/auth/me → 200 with bearer token (§9 auth)', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/auth/me', {
        headers: { Authorization: 'Bearer sandbox-demo-token' },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const body = await res.json() as Record<string, unknown>;
    assert(typeof body.id === 'number', 'Expected body.id to be a number');
    assert(typeof body.username === 'string', 'Expected body.username to be a string');
    assert(body.credentialKind === 'bearer', `Expected credentialKind=bearer, got ${String(body.credentialKind)}`);
});

// 8. Streaming: GET /stream yields chunks (§9 streaming)
await check('GET /stream → yields multiple chunks', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/stream');
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body !== null && res.body !== undefined, 'Expected a ReadableStream body');
    const text = await res.text();
    assert(text.includes('chunk-alpha'), 'Expected stream to contain chunk-alpha');
    assert(text.includes('chunk-delta'), 'Expected stream to contain chunk-delta');
});

// 9. POST /v1/chat/completions {stream:true} SSE ends with [DONE] (§9 LLM)
await check('POST /v1/chat/completions stream:true → SSE ends with [DONE]', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: true, messages: [] }),
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const text = await res.text();
    assert(text.includes('[DONE]'), 'Expected SSE stream to end with [DONE]');
    assert(text.includes('Hello'), 'Expected SSE stream to contain "Hello" token');
    assert(text.includes('"finish_reason":"stop"'), 'Expected SSE stream to have finish_reason:stop');
    assert(text.includes('data:'), 'Expected SSE data: prefix');
});

// 10. Tool-call variant: SSE with tools → tool_calls present, ends with [DONE]
await check('POST /v1/chat/completions stream:true + tools → tool_calls SSE + [DONE]', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            stream: true,
            messages: [],
            tools: [{ type: 'function', function: { name: 'get_weather' } }],
        }),
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const text = await res.text();
    assert(text.includes('[DONE]'), 'Expected tool SSE stream to end with [DONE]');
    assert(text.includes('tool_calls'), 'Expected SSE stream to contain tool_calls');
    assert(text.includes('get_weather'), 'Expected SSE stream to contain tool name');
    assert(text.includes('"finish_reason":"tool_calls"'), 'Expected tool_calls finish_reason');
});

// 11. Unknown host → sandbox-404, assert NO real network (SEC-03)
await check('Unknown host → sandbox-404, no real network (SEC-03)', async () => {
    const res = await simFetch('https://example.com/x');
    assert(res.status === 404, `Expected 404, got ${res.status}`);
    const body = await res.json() as Record<string, unknown>;
    assert(body.error === 'sandbox_not_found', `Expected sandbox_not_found, got ${String(body.error)}`);
    assert(
        typeof body.message === 'string' &&
            (body.message as string).includes('is not reachable inside the StitchAPI sandbox'),
        `Expected sandbox message, got: ${String(body.message)}`,
    );
    assert(body.sandbox === true, 'Expected sandbox: true');
    // The shim has no real fetch — if we got here without an exception, no real
    // network was attempted (the shim is the ONLY fetch in scope; there is no
    // real platform fetch to fall through to).
});

// 12. Unknown route on known host → sandbox-404 (not a crash)
await check('Unknown route on known host → sandbox-404', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/this-route-does-not-exist-in-sim');
    assert(res.status === 404, `Expected 404, got ${res.status}`);
    const body = await res.json() as Record<string, unknown>;
    assert(body.error === 'sandbox_not_found', `Expected sandbox_not_found, got ${String(body.error)}`);
});

// 13. Determinism (SEC-05): two fetches to the same URL yield identical bodies
await check('Determinism: two fetches to /users/1 → identical bodies (SEC-05)', async () => {
    const r1 = await simFetch('https://demo.stitchapi.dev/users/1');
    const r2 = await simFetch('https://demo.stitchapi.dev/users/1');
    const b1 = await r1.json();
    const b2 = await r2.json();
    assert(
        JSON.stringify(b1) === JSON.stringify(b2),
        `Expected identical bodies, got:\n  ${JSON.stringify(b1)}\n  ${JSON.stringify(b2)}`,
    );
});

// 14. Determinism: sandbox-404 is also deterministic (SEC-05)
await check('Determinism: two sandbox-404 responses → identical bodies (SEC-05)', async () => {
    const r1 = await simFetch('https://unknown.host.com/path');
    const r2 = await simFetch('https://unknown.host.com/path');
    const b1 = await r1.json();
    const b2 = await r2.json();
    assert(
        JSON.stringify(b1) === JSON.stringify(b2),
        `Sandbox-404 not deterministic:\n  ${JSON.stringify(b1)}\n  ${JSON.stringify(b2)}`,
    );
});

// 15. dispatch routing: scanSurface on a keychain(...) snippet → server tier / browser-shim path
await check('scanSurface: keychain(...) snippet → tier:server (SEC-46)', () => {
    const code = `const val = keychain('MY_SECRET');`;
    const scan = scanSurface(code);
    assert(scan.tier === 'server', `Expected tier:server, got ${scan.tier}`);
    assert(scan.ambiguous === false, `Expected ambiguous:false, got ${String(scan.ambiguous)}`);
    assert(
        scan.nodeOnlyHits.includes('keychain'),
        `Expected keychain in nodeOnlyHits, got ${JSON.stringify(scan.nodeOnlyHits)}`,
    );
});

// 16. dispatch routing: ambiguous core['key'+'chain'] → ambiguous:true + browser
await check("scanSurface: core['key'+'chain'] → ambiguous+browser (SEC-47)", () => {
    const code = `const k = core['key' + 'chain'];`;
    const scan = scanSurface(code);
    assert(scan.ambiguous === true, `Expected ambiguous:true, got ${String(scan.ambiguous)}`);
    assert(scan.tier === 'browser', `Expected tier:browser, got ${scan.tier}`);
    // ambiguous must NEVER route to server — the only safe default is browser
    assert(scan.tier !== 'server', 'Ambiguous access must not route to server');
});

// 17. dispatch routing: clean stitch('/users') snippet → browser tier
await check("scanSurface: stitch('/users') snippet → tier:browser", () => {
    const code = `const u = await stitch('https://demo.stitchapi.dev/users');`;
    const scan = scanSurface(code);
    assert(scan.tier === 'browser', `Expected tier:browser, got ${scan.tier}`);
    assert(scan.ambiguous === false, `Expected ambiguous:false, got ${String(scan.ambiguous)}`);
    assert(
        scan.nodeOnlyHits.length === 0,
        `Expected no nodeOnlyHits, got ${JSON.stringify(scan.nodeOnlyHits)}`,
    );
});

// 18. SEC-48: scan with malformed input is fail-safe → browser, never throws
await check('scanSurface: malformed input → fail-safe browser, no throw (SEC-48)', () => {
    let threw = false;
    let scan: ReturnType<typeof scanSurface> | undefined;
    try {
        scan = scanSurface('const ){[ "unterminated  /* `');
    } catch {
        threw = true;
    }
    assert(!threw, 'scanSurface must not throw on malformed input');
    assert(scan !== undefined, 'scanSurface must return a result');
    assert(scan!.tier === 'browser', `Expected tier:browser, got ${scan?.tier}`);
});

// 19. /__sandbox → 200 with self-describing catalogue (SANDBOX §4.3)
await check('GET /__sandbox → 200 + routes catalogue', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/__sandbox');
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const body = await res.json() as Record<string, unknown>;
    assert(Array.isArray(body.routes), 'Expected routes array in catalogue');
    const routes = body.routes as unknown[];
    assert(routes.length > 0, 'Catalogue routes should not be empty');
    // /drift should be present — it is documented in the catalogue
    const hasDrift = routes.some(
        (r: unknown) =>
            typeof r === 'object' &&
            r !== null &&
            (r as Record<string, unknown>).path === '/drift',
    );
    assert(hasDrift, 'Catalogue should include /drift route');
});

// 20. Non-streaming LLM: POST /v1/chat/completions {stream:false} → JSON body
await check('POST /v1/chat/completions stream:false → JSON body with content', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: false, messages: [] }),
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const body = await res.json() as Record<string, unknown>;
    assert(body.object === 'chat.completion', `Expected object=chat.completion, got ${String(body.object)}`);
    const choices = body.choices as Array<{ message: { content: string } }>;
    assert(Array.isArray(choices) && choices.length > 0, 'Expected choices array');
    assert(
        typeof choices[0].message.content === 'string' && choices[0].message.content.includes('Hello'),
        'Expected content to include "Hello"',
    );
});

// 21. GET /users → list of users with expected shape (§9 basic fetch)
await check('GET /users → list of fixture users (§9 basic fetch)', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/users');
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const body = await res.json() as { data: unknown[]; total: number };
    assert(Array.isArray(body.data), 'Expected data array');
    assert(body.data.length === 3, `Expected 3 users, got ${body.data.length}`);
    assert(body.total === 3, `Expected total=3, got ${body.total}`);
    const first = body.data[0] as Record<string, unknown>;
    assert(first.id === 1, `Expected first user id=1, got ${String(first.id)}`);
    assert(first.name === 'Alice Liddell', `Expected Alice Liddell, got ${String(first.name)}`);
});

// 22. GET /users/2 → specific user (§9 basic fetch)
await check('GET /users/2 → Bob Hoskins (§9 basic fetch)', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/users/2');
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const body = await res.json() as { data: Record<string, unknown> };
    assert(body.data.id === 2, `Expected id=2, got ${String(body.data.id)}`);
    assert(body.data.name === 'Bob Hoskins', `Expected Bob Hoskins, got ${String(body.data.name)}`);
});

// 23. __status knob works end-to-end through the shim adapter
await check('__status=403 knob applied end-to-end via fetch shim', async () => {
    const res = await simFetch('https://demo.stitchapi.dev/users?__status=403');
    assert(res.status === 403, `Expected 403, got ${res.status}`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
    for (const f of failures) console.error(f);
    console.error('T-ALPHA FAIL');
    process.exit(1);
}
console.log('T-ALPHA OK');

} // end main()

main().catch((err) => {
    console.error('Unexpected test runner error:', err);
    process.exit(1);
});
