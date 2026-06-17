/**
 * Wave 4 smoke test — cursor pagination handler.
 *
 * Run with:
 *   npx -y tsx packages/sandbox-sim/src/handlers/pagination.test.ts
 *
 * Prints "Pagination OK" and exits 0 on success; throws / exits non-zero on
 * failure. Uses node:assert only — no test framework required.
 *
 * Asserts the AGREED contract:
 *   - No cursor → { items: [×2], nextCursor: 'p2' }.
 *   - ?cursor=p2 → { items: [×2], nextCursor: null }.
 *   - Following nextCursor until null walks the whole collection (2 pages).
 *   - Item shape is { id, name, email }.
 *   - Opt-in ?firstHit429=1 returns 429 once then succeeds (default: no 429).
 *   - Determinism: identical requests return identical bodies.
 */
import type {
    SimKnobs,
    SimRequest,
} from '../../../../docs/sandbox/contracts/sim';
import { paginationHandlers, resetPaginationFlaky } from './pagination';

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PageBody {
    items: Array<{ id: number; name: string; email: string }>;
    nextCursor: string | null;
}

function makeReq(search = ''): SimRequest {
    return {
        method: 'GET',
        url: new URL(`https://demo.stitchapi.dev/paged/users${search}`),
        headers: new Headers(),
    };
}

const EMPTY_KNOBS: SimKnobs = {};

function findHandler(req: SimRequest) {
    const h = paginationHandlers.find((handler) => handler.match(req));
    if (!h)
        throw new Error(`No handler matched ${req.method} ${req.url.pathname}`);
    return h;
}

async function dispatch(req: SimRequest) {
    return findHandler(req).handle(req, EMPTY_KNOBS);
}

function assertUserShape(item: { id: number; name: string; email: string }) {
    assert.ok(typeof item.id === 'number', 'item.id should be a number');
    assert.ok(typeof item.name === 'string', 'item.name should be a string');
    assert.ok(typeof item.email === 'string', 'item.email should be a string');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
    resetPaginationFlaky();

    // ------------------------------------------------------------------
    // 1. First page (no cursor) → 2 items + nextCursor 'p2'
    // ------------------------------------------------------------------
    {
        const res = await dispatch(makeReq());
        assert.equal(res.status, 200, 'first page status should be 200');
        const body = res.body as PageBody;
        assert.ok(Array.isArray(body.items), 'items should be an array');
        assert.equal(body.items.length, 2, 'first page should have 2 items');
        assert.equal(
            body.nextCursor,
            'p2',
            'first page nextCursor should be "p2"',
        );
        for (const item of body.items) assertUserShape(item);
        assert.equal(body.items[0].id, 1, 'first item id should be 1');
        assert.equal(body.items[1].id, 2);
    }

    // ------------------------------------------------------------------
    // 2. Following the cursor (?cursor=p2) → last page + nextCursor null
    // ------------------------------------------------------------------
    {
        const res = await dispatch(makeReq('?cursor=p2'));
        assert.equal(res.status, 200, 'second page status should be 200');
        const body = res.body as PageBody;
        assert.equal(body.items.length, 2, 'second page should have 2 items');
        assert.equal(
            body.nextCursor,
            null,
            'last page nextCursor should be null',
        );
        for (const item of body.items) assertUserShape(item);
        assert.equal(body.items[0].id, 3, 'third item id should be 3');
        assert.equal(body.items[1].id, 4);
    }

    // ------------------------------------------------------------------
    // 3. Cursor follow-through walks the whole collection (no overlap)
    // ------------------------------------------------------------------
    {
        const collected: number[] = [];
        let cursor: string | null = null;
        let guard = 0;
        do {
            const search = cursor === null ? '' : `?cursor=${cursor}`;
            const res = await dispatch(makeReq(search));
            const body = res.body as PageBody;
            for (const item of body.items) collected.push(item.id);
            cursor = body.nextCursor;
            if (++guard > 10) throw new Error('pagination did not terminate');
        } while (cursor !== null);

        assert.deepEqual(
            collected,
            [1, 2, 3, 4],
            'walking nextCursor should yield all 4 ids in order',
        );
    }

    // ------------------------------------------------------------------
    // 4. Opt-in 429: ?firstHit429=1 returns 429 once, then succeeds
    // ------------------------------------------------------------------
    {
        resetPaginationFlaky();
        const first = await dispatch(makeReq('?firstHit429=1'));
        assert.equal(first.status, 429, 'first hit with flag should be 429');
        const errBody = first.body as { error: string };
        assert.equal(errBody.error, 'rate_limited');

        const second = await dispatch(makeReq('?firstHit429=1'));
        assert.equal(second.status, 200, 'retry should succeed with 200');
        const body = second.body as PageBody;
        assert.equal(body.items.length, 2, 'retry returns the first page');
        assert.equal(body.nextCursor, 'p2');
    }

    // ------------------------------------------------------------------
    // 5. Default behaviour (no flag) never 429s — stable for smoke runs
    // ------------------------------------------------------------------
    {
        resetPaginationFlaky();
        const a = await dispatch(makeReq());
        const b = await dispatch(makeReq());
        assert.equal(a.status, 200, 'default first call should be 200');
        assert.equal(b.status, 200, 'default repeat call should be 200');
    }

    // ------------------------------------------------------------------
    // 6. Determinism — identical request returns identical body twice
    // ------------------------------------------------------------------
    {
        resetPaginationFlaky();
        const r1 = await dispatch(makeReq('?cursor=p2'));
        const r2 = await dispatch(makeReq('?cursor=p2'));
        assert.deepEqual(
            r1.body,
            r2.body,
            'identical pagination requests must return identical bodies',
        );
    }

    // ------------------------------------------------------------------
    // 7. Only GET /paged/users is claimed (POST should not match)
    // ------------------------------------------------------------------
    {
        const postReq: SimRequest = {
            method: 'POST',
            url: new URL('https://demo.stitchapi.dev/paged/users'),
            headers: new Headers(),
        };
        const claimed = paginationHandlers.some((h) => h.match(postReq));
        assert.equal(claimed, false, 'POST /paged/users should not be matched');
    }

    console.log('Pagination OK');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
