/**
 * F1 — Sandbox index handler (`GET /__sandbox`).
 *
 * A static, self-describing catalogue of all available demo routes and knobs.
 * Returns a deterministic (hand-written) index so the playground UI can discover
 * endpoints and their supported query knobs.
 *
 * Determinism: pure static const, no Date.now, no Math.random.
 */
import type {
    SimHandler,
    SimKnobs,
    SimRequest,
    SimResponse,
} from '../../../../docs/sandbox/contracts/sim';

// ---------------------------------------------------------------------------
// Static catalogue — hand-written, deterministic
// ---------------------------------------------------------------------------

const SANDBOX_CATALOGUE = {
    routes: [
        // Errors & status (S2)
        {
            method: 'GET',
            path: '/users',
            description: 'List all users (fixed fixture: Alice, Bob, Carol)',
            knobs: ['__status', '__latencyMs', '__stream', '__flaky'],
        },
        {
            method: 'GET',
            path: '/users/:id',
            description: 'Get a single user by numeric ID (1-3 in fixture)',
            knobs: ['__status', '__latencyMs', '__stream', '__flaky'],
        },
        {
            method: 'POST',
            path: '/users',
            description:
                'Create a user — echoes the posted body plus a deterministic assigned id (201)',
            knobs: ['__status', '__latencyMs', '__flaky'],
        },
        {
            method: 'GET',
            path: '/users/:id/orders',
            description:
                "A user's orders (fixed fixture; ids 1-3 have orders, others 404)",
            knobs: ['__status', '__latencyMs', '__stream', '__flaky'],
        },
        {
            method: 'GET',
            path: '/status/:code',
            description: 'Echo any HTTP status code (100-599) with a JSON body',
            knobs: ['__latencyMs', '__stream', '__flaky'],
        },
        {
            method: 'GET',
            path: '/malformed',
            description:
                'Return 200 with text/html body (not JSON), for parse-failure demos',
            knobs: ['__status', '__latencyMs', '__stream', '__flaky'],
        },
        // Streaming / LLM (S3)
        {
            method: 'GET',
            path: '/stream',
            description: 'Chunked raw bytes (deterministic fixed chunks)',
            knobs: ['__status', '__latencyMs', '__flaky'],
        },
        {
            method: 'POST',
            path: '/v1/chat/completions',
            description:
                'OpenAI-style SSE token streaming or JSON completion; supports tool-call variant when body.tools is set',
            knobs: ['__status', '__latencyMs', '__flaky'],
        },
        {
            method: 'GET',
            path: '/events',
            description:
                'Server-Sent-Events stream of demo order-lifecycle events, terminated by [DONE]',
            knobs: ['__status', '__latencyMs', '__flaky'],
        },
        // Auth / capability (S4)
        {
            method: 'GET',
            path: '/auth/me',
            description:
                'Requires bearer token or session cookie; returns 401 without credentials',
            knobs: ['__status', '__latencyMs', '__stream', '__flaky'],
        },
        {
            method: 'GET',
            path: '/limited',
            description:
                'Always returns 429 (Too Many Requests); flaky knob allows retry-succeed demo',
            knobs: ['__status', '__latencyMs', '__stream', '__flaky'],
        },
        {
            method: 'GET',
            path: '/drift',
            description:
                'Schema-valid response by default; __drift=1 returns drifted (invalid) payload',
            knobs: [
                '__status',
                '__latencyMs',
                '__stream',
                '__flaky',
                '__drift',
            ],
        },
        // GraphQL surface (Wave 4)
        {
            method: 'POST',
            path: '/graphql',
            description:
                'GraphQL endpoint: { query, variables? }; a user(id) selection returns { data: { user } }, an unknown field returns { errors: [...] } (HTTP 200)',
            knobs: ['__status', '__latencyMs', '__flaky'],
        },
        // Cursor pagination (Wave 4)
        {
            method: 'GET',
            path: '/paged/users',
            description:
                'Cursor-paged users (2 pages of 2). No cursor → page 1 + nextCursor "p2"; ?cursor=p2 → last page + nextCursor null. Opt-in ?firstHit429=1 returns 429 once per cursor',
            knobs: ['__status', '__latencyMs', '__stream', '__flaky'],
        },
    ],
    knobs: [
        {
            name: '__status',
            description:
                'Force this HTTP status code (overrides handler default)',
            example: '?__status=500',
        },
        {
            name: '__latencyMs',
            description: 'Delay the response by this many milliseconds',
            example: '?__latencyMs=800',
        },
        {
            name: '__stream',
            description:
                'Stream the body as raw chunks ("chunked") or SSE token frames ("sse")',
            example: '?__stream=sse',
        },
        {
            name: '__drift',
            description:
                'Return a schema-drifted body (violates the declared schema) for validation demos',
            example: '?__drift=1',
        },
        {
            name: '__flaky',
            description:
                'Fail the first N attempts with 503, then succeed deterministically',
            example: '?__flaky=2',
        },
    ],
};

// ---------------------------------------------------------------------------
// Handler: GET /__sandbox — return the static catalogue
// ---------------------------------------------------------------------------

const sandboxIndexHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return req.method === 'GET' && req.url.pathname === '/__sandbox';
    },

    handle(_req: SimRequest, _knobs: SimKnobs): SimResponse {
        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: SANDBOX_CATALOGUE,
        };
    },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const sandboxIndexHandlers: SimHandler[] = [sandboxIndexHandler];
