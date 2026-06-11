/**
 * S4 — Auth/capability + Rate-limit/retry/drift handlers.
 *
 * Implements three demo endpoints against the frozen SimHandler contract:
 *
 *   GET /auth/me   — 401 without a bearer token or session cookie; 200 with any
 *                    non-empty token (bearer or cookie).  Demonstrates bearer /
 *                    oauth2 / cookieSession and the "capability not credential"
 *                    story: the simulator accepts ANY non-empty token — the token
 *                    is *simulated*; auth plumbing is what's being shown, not
 *                    real credential validation.
 *
 *   GET /limited   — Always returns 429 with Retry-After: 1 and a JSON error body.
 *                    The "succeed after retry" flaky behaviour is delegated to the
 *                    generic __flaky knob handled by the S5 dispatch layer; this
 *                    handler is the always-429 demo endpoint.
 *
 *   GET /drift     — Honors SimKnobs.drift (the __drift query knob parsed by S5).
 *                    When drift is falsy  → schema-valid payload.
 *                    When drift is truthy → drifted payload that violates the schema.
 *
 *                    Canonical schema (violated when drift=true):
 *                      { id: number, name: string }
 *                    Drift violations: id becomes a string, name is omitted,
 *                    and a spurious `extra` field appears.
 *
 * All handlers are deterministic — no Date.now(), no Math.random().
 */
import type {
    SimHandler,
    SimKnobs,
    SimRequest,
    SimResponse,
} from '../../../../docs/sandbox/contracts/sim';

// ---------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------

/**
 * Returns the bearer token from the Authorization header, or null.
 * Accepts the form "Bearer <token>" (case-insensitive scheme).
 */
function extractBearer(req: SimRequest): string | null {
    const authHeader =
        req.headers.get('Authorization') ?? req.headers.get('authorization');
    if (!authHeader) return null;
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1] : null;
}

/**
 * Returns the session token from the Cookie header (key: `session`), or null.
 * Minimal cookie parser — reads the first `session=<value>` pair.
 */
function extractSessionCookie(req: SimRequest): string | null {
    const cookieHeader = req.headers.get('Cookie') ?? req.headers.get('cookie');
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key.trim() === 'session' && rest.length > 0) {
            return rest.join('=').trim();
        }
    }
    return null;
}

const authMeHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return req.method === 'GET' && req.url.pathname === '/auth/me';
    },

    handle(req: SimRequest, _knobs: SimKnobs): SimResponse {
        const bearer = extractBearer(req);
        const cookie = extractSessionCookie(req);
        const credential = bearer ?? cookie;

        // Any non-empty credential is accepted — the token is simulated.
        if (!credential || credential.trim() === '') {
            return {
                status: 401,
                headers: {
                    'Content-Type': 'application/json',
                    // RFC 6750 §3 — prompt the client with bearer challenge.
                    'WWW-Authenticate':
                        'Bearer realm="sandbox", error="unauthorized"',
                },
                body: {
                    error: 'unauthorized',
                    message:
                        'No credentials supplied. Pass "Authorization: Bearer <token>" or a "session" cookie. ' +
                        'Any non-empty token is accepted in the sandbox.',
                },
            };
        }

        // Deterministic user payload — no wall-clock, no Math.random.
        return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: {
                id: 1,
                username: 'sandbox-user',
                email: 'user@sandbox.stitchapi.dev',
                // Echo the capability kind so snippets can inspect it.
                credentialKind: bearer ? 'bearer' : 'cookieSession',
                // Note: the token value itself is NOT echoed back — demos the
                // "capability not credential" story (you prove capability; the
                // system doesn't repeat your secret back to you).
                scopes: ['read:me', 'read:data'],
            },
        };
    },
};

// ---------------------------------------------------------------------------
// GET /limited
// ---------------------------------------------------------------------------

const rateLimitHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return req.method === 'GET' && req.url.pathname === '/limited';
    },

    handle(_req: SimRequest, _knobs: SimKnobs): SimResponse {
        // Always 429 — "flaky then succeed" is the __flaky knob owned by S5.
        return {
            status: 429,
            headers: {
                'Content-Type': 'application/json',
                'Retry-After': '1',
            },
            body: {
                error: 'rate_limited',
                message: 'Too many requests. Retry after 1 second.',
                retryAfterSeconds: 1,
            },
        };
    },
};

// ---------------------------------------------------------------------------
// GET /drift
// ---------------------------------------------------------------------------

/**
 * Canonical schema for the /drift endpoint:
 *   { id: number, name: string }
 *
 * Drift violations (when knobs.drift is truthy):
 *   - id is returned as a string instead of a number
 *   - name is omitted
 *   - a spurious `extra` field is added
 */
const driftHandler: SimHandler = {
    match(req: SimRequest): boolean {
        return req.method === 'GET' && req.url.pathname === '/drift';
    },

    handle(_req: SimRequest, knobs: SimKnobs): SimResponse {
        if (knobs.drift) {
            // Drifted payload — violates { id: number, name: string }:
            //   • id → string (type violation)
            //   • name → absent (missing required field)
            //   • extra → unexpected field
            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: {
                    id: '42', // DRIFT: should be number
                    // name omitted — DRIFT: required field missing
                    extra: true, // DRIFT: unexpected field
                },
            };
        }

        // Schema-valid payload: { id: number, name: string }
        return {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: {
                id: 42,
                name: 'sandbox-item',
            },
        };
    },
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const authResilienceHandlers: SimHandler[] = [
    authMeHandler,
    rateLimitHandler,
    driftHandler,
];
