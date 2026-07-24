// Pins docs/GAP-AUDIT.md §2.6: OAuth2 token fetch must be single-flight under concurrency
import { env, oauth2, stitch } from '../../src';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-single-flight-refresh-${process.pid}.jsonl`,
);

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});

const envSnapshot: Record<string, string | undefined> = {};
beforeEach(() => {
    server.reset();
    envSnapshot['OAUTH_CLIENT_ID'] = process.env['OAUTH_CLIENT_ID'];
    envSnapshot['OAUTH_CLIENT_SECRET'] = process.env['OAUTH_CLIENT_SECRET'];
    process.env['OAUTH_CLIENT_ID'] = 'cid';
    process.env['OAUTH_CLIENT_SECRET'] = 'csecret';
});
afterEach(() => {
    const id = envSnapshot['OAUTH_CLIENT_ID'];
    if (id === undefined) delete process.env['OAUTH_CLIENT_ID'];
    else process.env['OAUTH_CLIENT_ID'] = id;
    const secret = envSnapshot['OAUTH_CLIENT_SECRET'];
    if (secret === undefined) delete process.env['OAUTH_CLIENT_SECRET'];
    else process.env['OAUTH_CLIENT_SECRET'] = secret;
});

/**
 * GAP-AUDIT §2.6: the oauth2 strategy's get→check→fetch path (auth.ts:122-175)
 * must coalesce concurrent token fetches into a single in-flight request.
 * Five concurrent COLD calls through one stitch share one (empty) token cache,
 * so the desired contract is: exactly ONE POST to the token endpoint, and all
 * five calls succeed with the fetched token attached.
 *
 * Today `tokenFor` is non-atomic and has no in-flight coalescing — every cold
 * caller misses the cache before the first fetch lands, so each one POSTs the
 * token endpoint itself. The call-count assertion below pins the gap red.
 */
test('5 concurrent cold calls coalesce into exactly ONE token-endpoint POST', async () => {
    server.route('POST', '/token', {
        // The 50ms delay holds the first token fetch in flight long enough that
        // every concurrent cold caller has already taken the cache-miss branch —
        // making the race deterministic instead of timing-dependent.
        delay: 50,
        body: { access_token: 'T1', token_type: 'Bearer', expires_in: 3600 },
    });
    server.route('GET', '/data', {
        requireHeader: { name: 'authorization', value: 'Bearer T1' },
        body: { ok: true },
    });

    const data = stitch({
        baseUrl: server.url,
        path: '/data',
        auth: oauth2({
            tokenUrl: `${server.url}/token`,
            clientId: env('OAUTH_CLIENT_ID'),
            clientSecret: env('OAUTH_CLIENT_SECRET'),
        }),
    });

    // Fire 5 cold calls at once — none awaited before the others start.
    const results = await Promise.all(Array.from({ length: 5 }, () => data()));

    // All 5 calls succeed with the (single) token attached.
    expect(results).toEqual(Array.from({ length: 5 }, () => ({ ok: true })));
    expect(server.callCount('/data')).toBe(5);

    // THE PIN: single-flight means the token endpoint was POSTed exactly once.
    expect(server.callCount('/token')).toBe(1);
}, 10000);
