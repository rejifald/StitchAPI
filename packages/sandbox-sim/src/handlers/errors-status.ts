/**
 * S2 — Errors & status handlers + demo REST surface.
 *
 * Covers:
 *  - GET  /users             list of users (fixed fixture)
 *  - GET  /users/:id         single user by id (fixed fixture)
 *  - POST /users             create a user (echoes body + an assigned id)
 *  - GET  /users/:id/orders  a user's orders (fixed fixture)
 *  - GET  /status/:code      echo any HTTP status code with a JSON body
 *  - GET  /malformed         200 with a non-JSON (HTML) body, for parse-failure demos
 *
 * Handlers are knob-agnostic — they produce the BASE response only.
 * Generic knobs (status override, latencyMs, flaky, stream) are applied by the
 * dispatch layer (S5) AFTER the handler returns.
 *
 * Determinism: no Date.now / Math.random anywhere in this file. Payloads are
 * derived entirely from the FIXED_USERS fixture below (SANDBOX.md §4.3).
 */
import type {
    SimHandler,
    SimKnobs,
    SimRequest,
    SimResponse,
} from '../../../../docs/sandbox/contracts/sim';

// ---------------------------------------------------------------------------
// Fixed fixture — deterministic, never derived from runtime state.
// ---------------------------------------------------------------------------

interface User {
    id: number;
    name: string;
    email: string;
    role: 'admin' | 'member' | 'viewer';
}

const FIXED_USERS: User[] = [
    {
        id: 1,
        name: 'Alice Liddell',
        email: 'alice@api.example.com',
        role: 'admin',
    },
    {
        id: 2,
        name: 'Bob Hoskins',
        email: 'bob@api.example.com',
        role: 'member',
    },
    {
        id: 3,
        name: 'Carol Danvers',
        email: 'carol@api.example.com',
        role: 'viewer',
    },
];

interface Order {
    id: number;
    total: number;
    status: 'open' | 'paid' | 'shipped';
}

// Orders keyed by the user ids above — deterministic fixture.
const ORDERS_BY_USER: Record<number, Order[]> = {
    1: [
        { id: 1001, total: 4200, status: 'paid' },
        { id: 1002, total: 1899, status: 'shipped' },
    ],
    2: [{ id: 2001, total: 999, status: 'open' }],
    3: [
        { id: 3001, total: 12500, status: 'paid' },
        { id: 3002, total: 700, status: 'open' },
    ],
};

// ---------------------------------------------------------------------------
// Helper: parse a numeric trailing segment from a pathname like /users/2
// Returns null when the path does not match or the segment is not an integer.
// ---------------------------------------------------------------------------

function parseTrailingId(pathname: string, prefix: string): number | null {
    if (!pathname.startsWith(prefix)) return null;
    const rest = pathname.slice(prefix.length);
    // rest must be a non-empty string of digits with nothing after
    if (!/^\d+$/.test(rest)) return null;
    return parseInt(rest, 10);
}

// ---------------------------------------------------------------------------
// Handler: GET /users  — list all users
// ---------------------------------------------------------------------------

const listUsersHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return req.method === 'GET' && req.url.pathname === '/users';
    },

    handle(_req: SimRequest, _knobs: SimKnobs): SimResponse {
        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: { data: FIXED_USERS, total: FIXED_USERS.length },
        };
    },
};

// ---------------------------------------------------------------------------
// Handler: GET /users/:id  — single user
// ---------------------------------------------------------------------------

const getUserHandler: SimHandler = {
    match(req: SimRequest): boolean {
        if (req.method !== 'GET') return false;
        return parseTrailingId(req.url.pathname, '/users/') !== null;
    },

    handle(req: SimRequest, _knobs: SimKnobs): SimResponse {
        const id = parseTrailingId(req.url.pathname, '/users/') as number;
        const user = FIXED_USERS.find((u) => u.id === id);
        if (!user) {
            return {
                status: 404,
                headers: { 'content-type': 'application/json' },
                body: {
                    error: 'not_found',
                    message: `User ${id} does not exist in the sandbox fixture.`,
                },
            };
        }
        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: { data: user },
        };
    },
};

// ---------------------------------------------------------------------------
// Handler: POST /users  — create a user (echoes the body + an assigned id)
// ---------------------------------------------------------------------------

const createUserHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return req.method === 'POST' && req.url.pathname === '/users';
    },

    handle(req: SimRequest, _knobs: SimKnobs): SimResponse {
        // Echo the posted fields plus a deterministic next id (one past the
        // fixed fixture). req.body is the parsed JSON the fetch-shim built.
        const fields =
            req.body && typeof req.body === 'object'
                ? (req.body as Record<string, unknown>)
                : {};
        const created = { id: FIXED_USERS.length + 1, ...fields };
        return {
            status: 201,
            headers: { 'content-type': 'application/json' },
            body: { data: created },
        };
    },
};

// ---------------------------------------------------------------------------
// Handler: GET /users/:id/orders  — a user's orders (fixed fixture)
// ---------------------------------------------------------------------------

const listOrdersHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return (
            req.method === 'GET' &&
            /^\/users\/\d+\/orders$/.test(req.url.pathname)
        );
    },

    handle(req: SimRequest, _knobs: SimKnobs): SimResponse {
        const id = parseInt(
            req.url.pathname.replace(/^\/users\/(\d+)\/orders$/, '$1'),
            10,
        );
        const orders = ORDERS_BY_USER[id];
        if (!orders) {
            return {
                status: 404,
                headers: { 'content-type': 'application/json' },
                body: {
                    error: 'not_found',
                    message: `User ${id} does not exist in the sandbox fixture.`,
                },
            };
        }
        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: { data: orders },
        };
    },
};

// ---------------------------------------------------------------------------
// Handler: GET /status/:code  — echo any HTTP status
// ---------------------------------------------------------------------------

const statusEchoHandler: SimHandler = {
    match(req: SimRequest): boolean {
        if (req.method !== 'GET') return false;
        const code = parseTrailingId(req.url.pathname, '/status/');
        return code !== null && code >= 100 && code <= 599;
    },

    handle(req: SimRequest, _knobs: SimKnobs): SimResponse {
        const code = parseTrailingId(req.url.pathname, '/status/') as number;
        return {
            status: code,
            headers: { 'content-type': 'application/json' },
            body: {
                status: code,
                description: HTTP_STATUS_DESCRIPTIONS[code] ?? 'Unknown status',
                sandbox: true,
            },
        };
    },
};

// Compact lookup for common codes — purely static, no runtime derivation.
const HTTP_STATUS_DESCRIPTIONS: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    301: 'Moved Permanently',
    302: 'Found',
    304: 'Not Modified',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    405: 'Method Not Allowed',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
};

// ---------------------------------------------------------------------------
// Handler: GET /malformed  — 200 with a non-JSON (HTML) body
// ---------------------------------------------------------------------------

const malformedHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return req.method === 'GET' && req.url.pathname === '/malformed';
    },

    handle(_req: SimRequest, _knobs: SimKnobs): SimResponse {
        return {
            status: 200,
            headers: { 'content-type': 'text/html' },
            // body is a plain string — the adapter renders it verbatim,
            // demonstrating that callers expecting JSON will fail to parse it.
            body: '<!DOCTYPE html><html><body><h1>Oops — this is HTML, not JSON</h1><p>The sandbox /malformed endpoint returns text/html on purpose so you can see how stitch handles a non-JSON response.</p></body></html>',
        };
    },
};

// ---------------------------------------------------------------------------
// Named export — registration wired by S5 dispatch layer.
// ---------------------------------------------------------------------------

export const errorsStatusHandlers: SimHandler[] = [
    listUsersHandler,
    getUserHandler,
    createUserHandler,
    listOrdersHandler,
    statusEchoHandler,
    malformedHandler,
];
