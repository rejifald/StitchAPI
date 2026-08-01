// Pins docs/GAP-AUDIT.md §2.6 (failure path): the oauth2 single-flight token
// fetch must NOT poison the shared in-flight slot when the fetch rejects.
// `singleFlight` (auth.ts:298) clears its map entry with `.finally(() =>
// inFlight.delete(key))`, so a REJECTED fetch is removed on settle rather than
// cached as a poisoned promise. This proves that contract end-to-end: a first
// concurrent burst all fails through ONE token POST, then a later call — after
// the token endpoint recovers — fetches a fresh token and SUCCEEDS.
import { env, stitch } from '../../src';
import { oauth2 } from '../../src/auth';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-single-flight-refresh-failure-${process.pid}.jsonl`,
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
 * GAP-AUDIT §2.6 (failure path): a rejected single-flight token fetch must not
 * poison the in-flight slot for later callers.
 *
 * The token endpoint is wired with `statuses: [500, 200]` (the mock server's
 * `at()` clamps to the last element, so the first POST 500s and every later
 * POST returns 200). Five concurrent COLD callers share one empty token cache,
 * so single-flight coalesces them onto ONE in-flight fetch — that first fetch
 * hits the 500 and ALL five reject. Because `singleFlight` deletes the slot on
 * settle (reject included), the slot is now empty rather than holding a cached
 * rejected promise. A SIXTH call therefore runs a fresh fetch, which the now-
 * recovered endpoint answers 200 — and the call succeeds.
 *
 * Pins two facts: (1) the burst made exactly ONE token POST (single-flight held
 * under failure), and (2) recovery is possible (the slot was cleared, not
 * poisoned). If the slot were cached as a rejected promise, the sixth call would
 * re-reject with the same 500 and never POST again — making this RED.
 */
test('a rejected single-flight token fetch does not poison the slot; recovery succeeds', async () => {
    server.route('POST', '/token', {
        // First POST 500s; the `delayMs` holds it in flight long enough that
        // every concurrent cold caller takes the cache-miss branch before it
        // settles — making the coalescing deterministic, not timing-dependent.
        // Subsequent POSTs (after the burst rejects) clamp to status 200.
        delayMs: 50,
        statuses: [500, 200],
        body: [
            { error: 'temporarily_unavailable' },
            {
                access_token: 'T-recovered',
                token_type: 'Bearer',
                expires_in: 3600,
            },
        ],
    });
    server.route('GET', '/data', {
        requireHeader: { name: 'authorization', value: 'Bearer T-recovered' },
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

    // Burst of 5 cold calls — coalesced onto one in-flight token fetch, which 500s.
    const settled = await Promise.allSettled(
        Array.from({ length: 5 }, () => data()),
    );

    // All five reject (the single shared fetch failed), and with the SAME error
    // text — proving they awaited one fetch, not five independent ones.
    expect(settled.map((s) => s.status)).toEqual(
        Array.from({ length: 5 }, () => 'rejected'),
    );
    for (const s of settled) {
        expect(s.status).toBe('rejected');
        const reason = (s as PromiseRejectedResult).reason as Error;
        expect(reason.message).toMatch(/token request failed/i);
    }

    // Single-flight held under failure: the coalesced burst made ONE token POST,
    // and never reached /data (auth.apply threw before the request was sent).
    expect(server.callCount('/token')).toBe(1);
    expect(server.callCount('/data')).toBe(0);

    // The slot was CLEARED on the rejection (not cached as a poisoned promise):
    // a fresh call now fetches a new token from the recovered endpoint and wins.
    const recovered = await data();
    expect(recovered).toEqual({ ok: true });

    // The recovery made a SECOND token POST (the burst's one + this one) — proof
    // the in-flight slot was empty, forcing a real fetch rather than replaying a
    // cached rejection.
    expect(server.callCount('/token')).toBe(2);
    expect(server.callCount('/data')).toBe(1);
}, 10000);
