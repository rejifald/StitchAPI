/**
 * Test-only sandbox-sim handlers implementing the AGREED ENDPOINT CONTRACTS.
 *
 * These let the smoke tests run the paginated + graphql snippets OFFLINE and
 * self-contained — even in this isolated worktree, before the sandbox-sim package
 * registers the production handlers (owned by Agent B). They match the agreed
 * contracts byte-for-byte, so once Agent B's handlers land the behaviour is
 * identical; the harness's own `score/run.ts` default (`allHandlers`) then picks
 * up the real ones.
 *
 * The fixture set is layered IN FRONT of sandbox-sim's `allHandlers` so the LLM
 * task (which uses the existing `/v1/chat/completions` handler) still works.
 */
import { createFetchShim } from '../../sandbox-sim/src/adapters/node';
import { allHandlers } from '../../sandbox-sim/src/handlers/index';
import type {
    SimHandler,
    SimKnobs,
    SimRequest,
    SimResponse,
} from '../../sandbox-sim/src/index';

interface User {
    id: number;
    name: string;
    email: string;
}

const PAGE_1: User[] = [
    { id: 1, name: 'Alice', email: 'alice@example.com' },
    { id: 2, name: 'Bob', email: 'bob@example.com' },
];
const PAGE_2: User[] = [
    { id: 3, name: 'Carol', email: 'carol@example.com' },
    { id: 4, name: 'Dave', email: 'dave@example.com' },
];

/**
 * GET /paged/users?cursor=<c|absent> → { items, nextCursor }.
 * 2 pages of 2. First call (no cursor) → page 1 + nextCursor 'p2'; cursor 'p2' →
 * page 2 with nextCursor:null. Answers 429 ONCE before the first page (retry path).
 */
function makePagedUsersHandler(): SimHandler {
    let firstAttemptSeen = false;
    return {
        match(req: SimRequest): boolean {
            return req.method === 'GET' && req.url.pathname === '/paged/users';
        },
        handle(req: SimRequest, _knobs: SimKnobs): SimResponse {
            const cursor = req.url.searchParams.get('cursor');
            // Transient 429 on the very first call, before page 1 — exercises retry.
            if (cursor === null && !firstAttemptSeen) {
                firstAttemptSeen = true;
                return {
                    status: 429,
                    headers: { 'retry-after': '0' },
                    body: { error: 'rate_limited' },
                };
            }
            if (cursor === 'p2') {
                return {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                    body: { items: PAGE_2, nextCursor: null },
                };
            }
            return {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: { items: PAGE_1, nextCursor: 'p2' },
            };
        },
    };
}

/**
 * POST /graphql { query, variables? } →
 *   { data: { user: { id, name, email } } } for a user query;
 *   { errors: [{ message }] } when the query names a missing field.
 */
const graphqlHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return req.method === 'POST' && req.url.pathname === '/graphql';
    },
    handle(req: SimRequest, _knobs: SimKnobs): SimResponse {
        const body = (req.body ?? {}) as { query?: string };
        const query = typeof body.query === 'string' ? body.query : '';
        // A query naming a non-existent field surfaces as GraphQL errors[] (200).
        if (/\bnope\b|missingField|doesNotExist/.test(query)) {
            return {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: {
                    errors: [
                        {
                            message:
                                'Cannot query field "nope" on type "User".',
                        },
                    ],
                },
            };
        }
        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: {
                data: {
                    user: {
                        id: 7,
                        name: 'Grace Hopper',
                        email: 'grace@example.com',
                    },
                },
            },
        };
    },
};

/** A fetch shim with the agreed fixtures layered in front of the real handlers. */
export function makeFixtureFetch(): typeof globalThis.fetch {
    const handlers: SimHandler[] = [
        makePagedUsersHandler(),
        graphqlHandler,
        ...allHandlers,
    ];
    return createFetchShim(handlers) as typeof globalThis.fetch;
}
