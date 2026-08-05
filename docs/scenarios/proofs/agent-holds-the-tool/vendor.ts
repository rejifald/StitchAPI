// The vendor, and the wire tap.
//
// Two things live here, and the second is what makes the scenario measurable:
//
//   1. `SECRETS` — four distinct, greppable credential VALUES, one per auth strategy under test.
//      Every C1 scan searches every JSON-RPC payload for all four by value, so a leak through any
//      strategy fails the same assertion. They are deliberately unlike each other (`sk_live_…`,
//      `ak_live_…`, `sess_live_…`) so a hit names which strategy leaked without printing the hit.
//   2. `Wire` — an `Adapter` that RECORDS every outbound request (url, method, headers, body)
//      before answering it. The whole of C2 is "what did the vendor actually receive", and an
//      adapter is the last seam before the transport, so a recording adapter is the closest thing
//      to a packet capture that stays offline.
//
// The vendor routes on the request URL and enforces its own auth: a call that arrives without the
// right credential gets a 401 with a body, so "the credential still reached the vendor" is proved
// by a 200 rather than assumed. Nothing here does network I/O.
import type {
    Adapter,
    AdapterRequest,
    AdapterResponse,
} from '../../../../packages/core/src/types';

export const BASE = 'https://api.vendor.test';

/**
 * The four credential values under test, keyed by the label a leak would be reported under.
 *
 * `mintedKey` is not one of StitchAPI's credentials at all — it is a key the VENDOR returns in a
 * response body, the way a real `POST /api-keys` endpoint does. It is in this set on purpose: C1
 * has to distinguish "the library leaked a secret it was holding" from "the model asked for data
 * and the data was a secret", and the only way to tell those apart is to scan for both.
 */
export const SECRETS = {
    bearer: 'sk_live_bearer_9f3a1c2e4d5b6a7c',
    apiKeyHeader: 'ak_live_hdr_1122334455667788',
    apiKeyQuery: 'ak_live_qry_8899aabbccddeeff',
    session: 'sess_live_cookie_abcdef0123456789',
    loginPassword: 'pw_live_login_0f1e2d3c4b5a6978',
    mintedKey: 'ak_live_minted_00112233445566778899',
} as const;

/** The credentials StitchAPI itself holds — the set the capability boundary is a promise about. */
export const HELD_SECRETS = {
    bearer: SECRETS.bearer,
    apiKeyHeader: SECRETS.apiKeyHeader,
    apiKeyQuery: SECRETS.apiKeyQuery,
    session: SECRETS.session,
    loginPassword: SECRETS.loginPassword,
} as const;

/** Environment variables the stitches resolve their secrets from, via `env(...)`. */
export const ENV = {
    bearer: 'VENDOR_BEARER_TOKEN',
    apiKeyHeader: 'VENDOR_API_KEY',
    apiKeyQuery: 'VENDOR_METRICS_KEY',
    loginPassword: 'VENDOR_LOGIN_PASSWORD',
} as const;

/** Export the secrets into the process environment so `env(NAME)` resolves them at call time. */
export function installSecrets(): void {
    process.env[ENV.bearer] = SECRETS.bearer;
    process.env[ENV.apiKeyHeader] = SECRETS.apiKeyHeader;
    process.env[ENV.apiKeyQuery] = SECRETS.apiKeyQuery;
    process.env[ENV.loginPassword] = SECRETS.loginPassword;
}

/** One outbound request, exactly as the transport would have sent it. */
export interface WireRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

/** How a route answers. Returning a response is the normal path; throwing models a transport failure. */
export type Route = (req: WireRequest) => AdapterResponse;

const json = (status: number, body: unknown): AdapterResponse => ({
    status,
    headers: { 'content-type': 'application/json' },
    body,
});

const UNAUTHORIZED = (what: string): AdapterResponse =>
    json(401, { error: 'unauthorized', detail: `bad or missing ${what}` });

/** Read a cookie pair out of a `Cookie` request header. */
function cookieValue(header: string | undefined, name: string): string | null {
    for (const part of (header ?? '').split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return null;
}

/**
 * The vendor's routing table. Each entry checks the credential it requires and answers 401 when it
 * is absent or wrong — so a passing 200 in a proof is evidence the real credential arrived, not an
 * artefact of a permissive stub.
 *
 * `/v1/orders` is deliberately configured with a PINNED query parameter upstream
 * (`path: '/v1/orders?tenant=acme'`), and echoes the tenant it received back in the body. That
 * echo is how C2 measures whether a model-supplied `query` can overwrite an operator's pin.
 */
export function route(req: WireRequest): AdapterResponse {
    const url = new URL(req.url);
    const path = url.pathname;
    const auth = req.headers['authorization'];
    const bearerOk = auth === `Bearer ${SECRETS.bearer}`;

    if (path === '/auth/login') {
        const body = req.body as { password?: string } | undefined;
        if (body?.password !== SECRETS.loginPassword)
            return UNAUTHORIZED('login password');
        return {
            status: 200,
            headers: {
                'content-type': 'application/json',
                'set-cookie': `SESSION=${SECRETS.session}; Path=/; HttpOnly`,
            },
            body: { ok: true },
        };
    }
    if (path === '/v1/profile') {
        const session = cookieValue(req.headers['cookie'], 'SESSION');
        if (session !== SECRETS.session) return UNAUTHORIZED('SESSION cookie');
        return json(200, { data: { id: 'u_1', email: 'ada@vendor.test' } });
    }
    if (path === '/v1/reports') {
        if (req.headers['x-api-key'] !== SECRETS.apiKeyHeader)
            return UNAUTHORIZED('X-API-Key header');
        return json(200, { data: { rows: 3 } });
    }
    if (path === '/v1/metrics') {
        // The query arm: the credential rides in the URL. Read the FIRST occurrence, which is what
        // Express/Rails/Go's net/http all do — it matters when a model appends a second one.
        if (url.searchParams.get('api_key') !== SECRETS.apiKeyQuery)
            return UNAUTHORIZED('api_key query param');
        return json(200, { data: { uptime: 0.999 } });
    }
    if (path === '/v1/orders') {
        if (!bearerOk) return UNAUTHORIZED('bearer token');
        return json(200, {
            data: {
                tenant: url.searchParams.get('tenant'),
                orders: [{ id: 'o_1', total: 4200 }],
            },
        });
    }
    if (path.startsWith('/v1/orders/')) {
        if (!bearerOk) return UNAUTHORIZED('bearer token');
        return json(200, {
            data: { id: path.slice('/v1/orders/'.length), total: 4200 },
        });
    }
    if (path === '/v1/refunds') {
        if (!bearerOk) return UNAUTHORIZED('bearer token');
        const body = req.body as { amount?: number } | undefined;
        return json(200, {
            data: { refundId: 're_9', amount: body?.amount ?? 0 },
        });
    }
    if (path === '/v1/api-keys') {
        if (!bearerOk) return UNAUTHORIZED('bearer token');
        // A real vendor endpoint that MINTS a credential and returns it in the response body.
        return json(200, {
            data: { id: 'key_7', secret: SECRETS.mintedKey },
        });
    }
    // The internal service an SSRF would aim at. Reachable only if something can redirect the host.
    if (url.host === 'metadata.internal')
        return json(200, { data: { role: 'admin', token: 'INTERNAL' } });
    return json(404, { error: 'no such route', path });
}

/**
 * The wire tap: an `Adapter` that appends every request to `requests` before answering it.
 *
 * `handler` defaults to the vendor's routing table; a script that needs a specific failure (a
 * transport throw, a 500, a slow call) passes its own and still gets the recording.
 */
export class Wire {
    readonly requests: WireRequest[] = [];
    constructor(private readonly handler: Route = route) {}

    adapter(): Adapter {
        return async (req: AdapterRequest): Promise<AdapterResponse> => {
            const seen: WireRequest = {
                url: req.url,
                method: req.method,
                headers: { ...req.headers },
                body: req.body,
            };
            this.requests.push(seen);
            return this.handler(seen);
        };
    }

    get count(): number {
        return this.requests.length;
    }
    /** The most recent request. Throws rather than returning `undefined` — a proof that reads a
     *  request that was never made should fail loudly, not compare against nothing. */
    get last(): WireRequest {
        const r = this.requests.at(-1);
        if (!r) throw new Error('wire: no request was made');
        return r;
    }
    /** Every request's URL, in order — the SSRF/redirect spine. */
    get urls(): string[] {
        return this.requests.map((r) => r.url);
    }
    reset(): void {
        this.requests.length = 0;
    }
}
