/**
 * Wave 4 — GraphQL surface handler.
 *
 *   POST /graphql   — parse { query, variables? }; resolve a single `user(id)`
 *                     selection against the fixed fixture.
 *
 * Contract (agreed with the eval-harness agent, both sides must match exactly):
 *   - A query that selects the `user` field with valid sub-fields returns
 *       200 { data: { user: { id, name, email } } }
 *   - A query that selects a non-existent field returns
 *       200 { errors: [{ message: 'Cannot query field "..." ...' }] }
 *     i.e. GraphQL transport-level success (HTTP 200) with a body-level error,
 *     which exercises the graphql surface's `errors[]-is-failure` path.
 *
 * Handlers are knob-agnostic — they produce the BASE response only; the generic
 * knobs (status override, latencyMs, flaky, stream) are applied by the dispatch
 * layer (S5) AFTER the handler returns.
 *
 * Determinism: no Date.now / Math.random. The resolved user is derived purely
 * from the requested id against the FIXTURE below (SANDBOX.md §4.3).
 */
import type {
    SimHandler,
    SimKnobs,
    SimRequest,
    SimResponse,
} from '../../../../docs/sandbox/contracts/sim';

// ---------------------------------------------------------------------------
// Fixed fixture — deterministic, never derived from runtime state.
// Shape matches the agreed contract: { id: number, name: string, email: string }.
// ---------------------------------------------------------------------------

interface GqlUser {
    id: number;
    name: string;
    email: string;
}

const FIXTURE_USERS: GqlUser[] = [
    { id: 1, name: 'Alice Liddell', email: 'alice@api.example.com' },
    { id: 2, name: 'Bob Hoskins', email: 'bob@api.example.com' },
    { id: 3, name: 'Carol Danvers', email: 'carol@api.example.com' },
];

const DEFAULT_USER_ID = 1;

// The set of fields the simulated `user` type knows how to resolve. A selection
// of any field outside this set is reported as an unknown-field error so the
// caller's errors[]-is-failure path is exercised.
const KNOWN_USER_FIELDS = new Set(['id', 'name', 'email']);

// ---------------------------------------------------------------------------
// Minimal request-body parsing — { query: string, variables?: object }.
// We do NOT implement a real GraphQL parser; we inspect the query text just
// enough to (a) confirm it asks for `user`, (b) extract the requested fields,
// and (c) resolve an id from the inline argument or the variables map.
// ---------------------------------------------------------------------------

interface GraphqlRequestBody {
    query: string;
    variables?: Record<string, unknown>;
}

function readGraphqlBody(body: unknown): GraphqlRequestBody | null {
    if (body == null || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    if (typeof b['query'] !== 'string') return null;
    const variables =
        b['variables'] != null && typeof b['variables'] === 'object'
            ? (b['variables'] as Record<string, unknown>)
            : undefined;
    return { query: b['query'], variables };
}

/**
 * Extract the field names selected inside the `user(...) { ... }` block.
 * Returns null when the query does not reference a `user` selection at all.
 */
function extractUserSelection(query: string): string[] | null {
    // Find `user` followed by an optional (args) then a `{ ... }` block.
    const match = query.match(/user\s*(?:\([^)]*\))?\s*\{([^}]*)\}/);
    if (!match) return null;
    return match[1]
        .split(/[\s,]+/)
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
}

/** Resolve the requested user id from an inline `id:` arg or the variables. */
function resolveRequestedId(
    query: string,
    variables: Record<string, unknown> | undefined,
): number {
    // Inline literal: `user(id: 2)`.
    const literal = query.match(/user\s*\(\s*id\s*:\s*(\d+)/);
    if (literal) return parseInt(literal[1], 10);

    // Variable reference: `user(id: $id)` resolved from variables.id.
    const varRef = query.match(/user\s*\(\s*id\s*:\s*\$(\w+)/);
    if (varRef && variables) {
        const v = variables[varRef[1]];
        if (typeof v === 'number') return v;
        if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10);
    }

    return DEFAULT_USER_ID;
}

function unknownFieldError(field: string): SimResponse {
    // HTTP 200 with a body-level GraphQL error — the agreed errors[] path.
    return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
            errors: [
                {
                    message: `Cannot query field "${field}" on type "User".`,
                },
            ],
        },
    };
}

// ---------------------------------------------------------------------------
// Handler: POST /graphql
// ---------------------------------------------------------------------------

const graphqlHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return req.method === 'POST' && req.url.pathname === '/graphql';
    },

    handle(req: SimRequest, _knobs: SimKnobs): SimResponse {
        const parsed = readGraphqlBody(req.body);
        if (!parsed) {
            // Malformed transport — surface as a GraphQL error (still HTTP 200,
            // matching how GraphQL servers report request-document problems).
            return {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: {
                    errors: [
                        {
                            message:
                                'Must provide a query string in the request body.',
                        },
                    ],
                },
            };
        }

        const selection = extractUserSelection(parsed.query);
        if (selection === null) {
            // The query did not reference `user` at all → unknown root field.
            return unknownFieldError('user');
        }

        // Any selected field outside the known set → errors[] (failure path).
        const unknown = selection.find((f) => !KNOWN_USER_FIELDS.has(f));
        if (unknown !== undefined) {
            return unknownFieldError(unknown);
        }

        const id = resolveRequestedId(parsed.query, parsed.variables);
        const user = FIXTURE_USERS.find((u) => u.id === id) ?? FIXTURE_USERS[0];

        // Project exactly the requested fields onto the data payload.
        const projected: Record<string, unknown> = {};
        for (const field of selection) {
            projected[field] = user[field as keyof GqlUser];
        }

        return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: { data: { user: projected } },
        };
    },
};

// ---------------------------------------------------------------------------
// Named export — registration wired by handlers/index.ts.
// ---------------------------------------------------------------------------

export const graphqlHandlers: SimHandler[] = [graphqlHandler];
