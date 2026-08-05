// The stitches the MCP server exposes — the registry an operator would actually write.
//
// Ten stitches over four auth strategies, because C1 is only worth anything if it scans every
// shape a credential can take:
//
//   bearer(env(...))                       getOrder, listOrders, refund, mintApiKey
//   apiKey({ in: 'header' })               getReport
//   apiKey({ in: 'query' })                getMetrics       ← the credential rides in the URL
//   cookieSession({ login, cookie })       getProfile       ← the credential is a captured cookie
//   (none — it IS the login)               login            ← holds the login password
//
// Two shapes exist to isolate one variable each:
//   - `getOrderTyped` declares an `input.params` schema, so C7 can measure whether a declared
//     schema constrains what the model may send (and WHEN it is checked).
//   - `searchOrders` declares an `input.headers` schema, which is the one documented way to opt a
//     stitch INTO accepting model-supplied headers (mcp.ts:125-130). C2 measures what that opens.
//
// `listOrders` pins a tenant in its configured path (`/v1/orders?tenant=acme`). The vendor echoes
// the tenant it received, so the response body is a direct read-out of whose data the call
// returned — that echo is C2's sharpest measurement.
import {
    apiKey,
    bearer,
    cookieSession,
    env,
} from '../../../../packages/core/src/auth';
import { seam } from '../../../../packages/core/src/index';
import type { StitchRegistry } from '../../../../packages/core/src/registry';
import type { Stitch } from '../../../../packages/core/src/types';
import type { Validator } from '../../../../packages/core/src/validator';
import { BASE, ENV, type Wire } from './vendor';

/**
 * A hand-rolled `Validator` — `stitchapi` has no runtime dependencies and `docs/` has no manifest,
 * so the proofs in this directory build schemas out of predicates rather than importing Zod. Only
 * C7 depends on schema behaviour, and it depends on the ENGINE's use of a validator (when it runs,
 * what it rejects), not on any schema library's coercion rules.
 */
export function schema(
    label: string,
    ok: (value: unknown) => boolean,
): Validator {
    return {
        validate: (value) =>
            Promise.resolve(
                ok(value)
                    ? { ok: true as const, value }
                    : {
                          ok: false as const,
                          issues: [{ path: [], message: `expected ${label}` }],
                      },
            ),
    };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** `{ id: <digits> }` and nothing else — the tight params contract C7 measures against. */
const numericIdOnly = schema(
    '{ id: numeric string }',
    (v) =>
        isRecord(v) &&
        Object.keys(v).length === 1 &&
        typeof v['id'] === 'string' &&
        /^[0-9]+$/.test(v['id']),
);

/** A permissive headers contract — the shape an operator writes when they want ONE extra header. */
const anyHeaders = schema('an object', (v) => v === undefined || isRecord(v));

/**
 * Build the registry an operator would hand `serveStdio`. `wire` is the recording adapter every
 * stitch shares, so one script sees every outbound request in one ordered list.
 *
 * A `seam` carries the shared adapter, base URL and store — and, for `cookieSession`, the vault the
 * captured cookie lives in. `tenancy: 'app'` is the deliberate opt-in to one process-wide session
 * (the fail-closed default demands a bound principal, which an MCP server has no way to supply).
 */
export function buildRegistry(wire: Wire): StitchRegistry & {
    login: Stitch;
} {
    const api = seam({ baseUrl: BASE, adapter: wire.adapter() });

    const login = api.stitch({
        name: 'login',
        method: 'POST',
        path: '/auth/login',
    }) as Stitch;

    const session = cookieSession({
        login,
        cookie: 'SESSION',
        tenancy: 'app',
        loginInput: () => ({
            body: { user: 'svc', password: env(ENV.loginPassword)() },
        }),
    });

    return {
        login,
        getOrder: api.stitch({
            name: 'getOrder',
            path: '/v1/orders/{id}',
            auth: bearer(env(ENV.bearer)),
            pick: 'data',
        }),
        getOrderTyped: api.stitch({
            name: 'getOrderTyped',
            path: '/v1/orders/{id}',
            auth: bearer(env(ENV.bearer)),
            input: { params: numericIdOnly },
            pick: 'data',
        }),
        listOrders: api.stitch({
            name: 'listOrders',
            // The operator's tenant pin, in the configured path where a caller cannot see it.
            path: '/v1/orders?tenant=acme',
            auth: bearer(env(ENV.bearer)),
            pick: 'data',
        }),
        searchOrders: api.stitch({
            name: 'searchOrders',
            path: '/v1/orders',
            auth: bearer(env(ENV.bearer)),
            // The documented opt-in: declaring a headers schema is what lets agent-supplied
            // headers through `sanitizeAgentInput` at all.
            input: { headers: anyHeaders },
            pick: 'data',
        }),
        getReport: api.stitch({
            name: 'getReport',
            path: '/v1/reports',
            auth: apiKey({ in: 'header', secret: env(ENV.apiKeyHeader) }),
            pick: 'data',
        }),
        getMetrics: api.stitch({
            name: 'getMetrics',
            path: '/v1/metrics',
            auth: apiKey({ in: 'query', secret: env(ENV.apiKeyQuery) }),
            pick: 'data',
        }),
        getProfile: api.stitch({
            name: 'getProfile',
            path: '/v1/profile',
            auth: session,
            pick: 'data',
        }),
        refund: api.stitch({
            name: 'refund',
            method: 'POST',
            path: '/v1/refunds',
            auth: bearer(env(ENV.bearer)),
            pick: 'data',
        }),
        mintApiKey: api.stitch({
            name: 'mintApiKey',
            method: 'POST',
            path: '/v1/api-keys',
            auth: bearer(env(ENV.bearer)),
            pick: 'data',
        }),
    };
}
