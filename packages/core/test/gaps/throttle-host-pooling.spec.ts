// Pins docs/GAP-AUDIT.md §1.4: throttle scope:'host' must pool the budget across stitch instances in-process, as throttle.mdx documents
import { stitch } from '../../src';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-gap-throttle-host-pooling-${process.pid}.jsonl`,
);

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});

describe('GAP-AUDIT §1.4 — throttle scope:"host" pools across instances', () => {
    test('two separate stitches (no shared store) hitting the same host share one 2/s budget', async () => {
        // Record the server-side arrival time of each request.
        const hits: number[] = [];
        server.route('GET', '/pooled', {
            body: () => {
                hits.push(Date.now());
                return { ok: true };
            },
        });

        // Two INDEPENDENT stitch() instances — no `store` configured — both
        // declaring host pooling against the same origin. throttle.mdx says
        // 'host' "pools the budget across every stitch hitting the same host",
        // so the 2/s budget (500ms spacing) must apply across BOTH instances.
        // `a` uses the canonical `pool` (CONTRACT.md P2); `b` uses the
        // `@deprecated` `scope` alias — they MUST pool together, proving the
        // alias is byte-equivalent to the new field.
        const a = stitch({
            baseUrl: server.url,
            path: '/pooled',
            throttle: { rate: '2/s', pool: 'host' },
        });
        const b = stitch({
            baseUrl: server.url,
            path: '/pooled',
            throttle: { rate: '2/s', scope: 'host' },
        });

        await Promise.all([a(), b()]);

        expect(hits).toHaveLength(2);
        hits.sort((x, y) => x - y);
        const gap = (hits[1] ?? 0) - (hits[0] ?? 0);
        // Pooled 2/s budget → second request paced ~500ms after the first. The
        // lower bound is deliberately LOOSE (>= 250, not ~500): this is a real
        // wall-clock measurement and a loaded CI runner can shave the observed
        // gap well below the nominal 500ms pacing (seen at 380ms). 250ms still
        // sits an order of magnitude above the ~0ms a BROKEN pool produces (each
        // instance firing from its own closure-local throttle map), so the test
        // keeps its meaning — it only passes when the budget is actually pooled.
        expect(gap).toBeGreaterThanOrEqual(250);
    });
});
