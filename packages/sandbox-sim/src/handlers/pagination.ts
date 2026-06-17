/**
 * Wave 4 — Cursor pagination handler.
 *
 *   GET /paged/users   — cursor-paged user list (2 pages of 2 items).
 *
 * Contract (agreed with the eval-harness agent, both sides must match exactly):
 *   - No cursor (?cursor absent)  → 200 { items: [u1, u2], nextCursor: 'p2' }
 *   - ?cursor=p2                  → 200 { items: [u3, u4], nextCursor: null }
 *   Following `nextCursor` until it is null walks the whole collection — this
 *   is what the caller's pagination surface (cursor follow-through) exercises.
 *
 * Optional flakiness: an opt-in `?firstHit429=1` flag makes the FIRST hit to a
 * given cursor return 429 once, then succeed on the next identical request.
 * It is OFF by default so the endpoint is stable/deterministic for smoke tests;
 * the generic `__flaky` dispatch knob remains the primary retry-demo mechanism.
 *
 * Handlers are knob-agnostic for the GENERIC knobs (status / latencyMs / flaky /
 * stream are applied by the S5 dispatch layer). The opt-in 429 here is a
 * handler-intrinsic, deterministic behaviour gated behind an explicit flag.
 *
 * Determinism: no Date.now / Math.random. Pages are derived purely from the
 * FIXTURE and the requested cursor (SANDBOX.md §4.3). The opt-in 429 uses a
 * per-cursor seen-counter that is resettable for test isolation.
 */
import type {
    SimHandler,
    SimKnobs,
    SimRequest,
    SimResponse,
} from '../../../../docs/sandbox/contracts/sim';

// ---------------------------------------------------------------------------
// Fixed fixture — deterministic. Shape matches the agreed contract:
// { id: number, name: string, email: string }.
// ---------------------------------------------------------------------------

interface PagedUser {
    id: number;
    name: string;
    email: string;
}

interface Page {
    items: PagedUser[];
    nextCursor: string | null;
}

// Two pages of two items each, keyed by the incoming cursor.
// The absent-cursor case maps to the FIRST_PAGE_KEY entry.
const FIRST_PAGE_KEY = '';

const PAGES: Record<string, Page> = {
    [FIRST_PAGE_KEY]: {
        items: [
            { id: 1, name: 'Alice Liddell', email: 'alice@demo.stitchapi.dev' },
            { id: 2, name: 'Bob Hoskins', email: 'bob@demo.stitchapi.dev' },
        ],
        nextCursor: 'p2',
    },
    p2: {
        items: [
            { id: 3, name: 'Carol Danvers', email: 'carol@demo.stitchapi.dev' },
            { id: 4, name: 'Dave Lister', email: 'dave@demo.stitchapi.dev' },
        ],
        nextCursor: null,
    },
};

// ---------------------------------------------------------------------------
// Opt-in 429 flakiness — per-cursor seen-counter (module-level for test
// isolation via resetPaginationFlaky). OFF unless ?firstHit429=1 is set.
// ---------------------------------------------------------------------------

const firstHitSeen = new Map<string, number>();

/** Reset the per-cursor opt-in-429 counters (call between tests). */
export function resetPaginationFlaky(): void {
    firstHitSeen.clear();
}

// ---------------------------------------------------------------------------
// Handler: GET /paged/users
// ---------------------------------------------------------------------------

const pagedUsersHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return req.method === 'GET' && req.url.pathname === '/paged/users';
    },

    handle(req: SimRequest, _knobs: SimKnobs): SimResponse {
        const cursor = req.url.searchParams.get('cursor') ?? FIRST_PAGE_KEY;

        // Opt-in deterministic 429-once on the first hit of a given cursor.
        const firstHit429 = req.url.searchParams.get('firstHit429');
        if (firstHit429 === '1' || firstHit429 === 'true') {
            const seen = firstHitSeen.get(cursor) ?? 0;
            if (seen === 0) {
                firstHitSeen.set(cursor, 1);
                return {
                    status: 429,
                    headers: {
                        'content-type': 'application/json',
                        'retry-after': '1',
                    },
                    body: {
                        error: 'rate_limited',
                        message:
                            'Simulated first-hit rate limit; retry the same request to succeed.',
                        sandbox: true,
                    },
                };
            }
            // Subsequent hits fall through to the normal page.
        }

        const page = PAGES[cursor];
        if (!page) {
            return {
                status: 404,
                headers: { 'content-type': 'application/json' },
                body: {
                    error: 'unknown_cursor',
                    message: `Cursor "${cursor}" is not a valid page cursor in the sandbox fixture.`,
                    sandbox: true,
                },
            };
        }

        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: { items: page.items, nextCursor: page.nextCursor },
        };
    },
};

// ---------------------------------------------------------------------------
// Named export — registration wired by handlers/index.ts.
// ---------------------------------------------------------------------------

export const paginationHandlers: SimHandler[] = [pagedUsersHandler];
