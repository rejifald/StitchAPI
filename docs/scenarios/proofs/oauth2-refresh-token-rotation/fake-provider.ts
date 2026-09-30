// A fake, in-memory OAuth2 provider that behaves like Atlassian / Asana: the refresh token is
// SINGLE-USE and ROTATES, and presenting an already-redeemed one is treated as theft — the whole
// token family is revoked (RFC 6819 §5.2.2.3 replay detection).
//
// Nothing here touches the network. Both endpoints are exposed as StitchAPI `Adapter`s so a proof
// can inject them via `stitch({ adapter })` (resource server) and `oauth2({ adapter })` (token
// endpoint) and COUNT every call precisely.
import type {
    Adapter,
    AdapterRequest,
    AdapterResult,
} from '../../../../packages/core/src/types';

const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

/** One recorded hit on the token endpoint — the exact form body StitchAPI sent. */
export interface TokenRequest {
    grant_type?: string;
    refresh_token?: string;
    client_id?: string;
    client_secret?: string;
    scope?: string;
    [k: string]: string | undefined;
}

export interface ProviderOptions {
    /** Seed refresh token for the connected account (the one a real integration has on disk). */
    refreshToken?: string;
    /** `expires_in` (seconds) returned with every access token. Default 3600. */
    expiresIn?: number;
}

export class FakeRotatingProvider {
    /** Every token-endpoint hit, in order. `tokenRequests.length` IS the call count. */
    readonly tokenRequests: TokenRequest[] = [];
    /** Every resource-server hit, in order (the Authorization header sent). */
    readonly resourceRequests: (string | undefined)[] = [];
    /** How many times a CONSUMED refresh token was presented — i.e. the bug we are hunting. */
    replayDetections = 0;
    /** Once true the account is dead: every later grant fails, the user must re-authorize. */
    familyRevoked = false;

    /** The refresh token the provider will currently accept. Rotates on every redemption. */
    activeRefreshToken: string;
    /** Refresh tokens already spent. Presenting one of these trips replay detection. */
    readonly consumedRefreshTokens = new Set<string>();

    /** The access token minted most recently (what the resource server accepts). */
    currentAccessToken: string | undefined;
    /** Access tokens the resource server now rejects with 401 (simulates server-side expiry). */
    readonly rejectedAccessTokens = new Set<string>();

    private seq = 0;
    private readonly expiresIn: number;

    constructor(opts: ProviderOptions = {}) {
        this.activeRefreshToken = opts.refreshToken ?? 'RT-0';
        this.expiresIn = opts.expiresIn ?? 3600;
    }

    /** Count of token-endpoint hits. */
    get tokenCalls(): number {
        return this.tokenRequests.length;
    }

    /** Mark the currently-issued access token as no longer accepted by the resource server. */
    expireCurrentAccessToken(): void {
        if (this.currentAccessToken)
            this.rejectedAccessTokens.add(this.currentAccessToken);
    }

    private mintAccessToken(): string {
        const t = `AT-${++this.seq}`;
        this.currentAccessToken = t;
        return t;
    }

    /**
     * The token endpoint. Handles `client_credentials` (no refresh token in play) and
     * `refresh_token` (single-use + rotating, with replay detection).
     */
    tokenAdapter(opts: { delayMs?: number } = {}): Adapter {
        return async (req: AdapterRequest): Promise<AdapterResult> => {
            const body = (req.body ?? {}) as TokenRequest;
            this.tokenRequests.push({ ...body });
            if (opts.delayMs) await sleep(opts.delayMs);

            // The client MUST authenticate (RFC 6749 §2.3.1): either `client_secret_post`
            // (credentials in the form body) or `client_secret_basic` (an HTTP Basic header).
            // A real provider answers an unauthenticated grant with 401 `invalid_client`, and so
            // does this one — otherwise a proof whose strategy silently stopped sending
            // credentials (e.g. reading an options field that no longer exists) still passes.
            const basic = /^Basic /i.test(req.headers['authorization'] ?? '');
            const posted = !!body.client_id && !!body.client_secret;
            if (!basic && !posted)
                return {
                    status: 401,
                    headers: {},
                    body: {
                        error: 'invalid_client',
                        error_description:
                            'no client authentication — expected client_id/client_secret in the body or an HTTP Basic Authorization header',
                    },
                };

            // A revoked family is permanently dead — exactly what makes this failure expensive.
            if (this.familyRevoked)
                return {
                    status: 400,
                    headers: {},
                    body: {
                        error: 'invalid_grant',
                        error_description: 'token family revoked',
                    },
                };

            const grant = body.grant_type ?? 'client_credentials';

            if (grant === 'refresh_token') {
                const presented = body.refresh_token ?? '';
                if (this.consumedRefreshTokens.has(presented)) {
                    // REPLAY. A real provider reads this as token theft and kills the family.
                    this.replayDetections++;
                    this.familyRevoked = true;
                    return {
                        status: 400,
                        headers: {},
                        body: {
                            error: 'invalid_grant',
                            error_description:
                                'refresh token already used — token family revoked',
                        },
                    };
                }
                if (presented !== this.activeRefreshToken)
                    return {
                        status: 400,
                        headers: {},
                        body: { error: 'invalid_grant' },
                    };
                // Valid redemption: consume the old token, ROTATE to a new one, mint an access token.
                this.consumedRefreshTokens.add(presented);
                this.activeRefreshToken = `RT-${this.seq + 1}`;
                return {
                    status: 200,
                    headers: {},
                    body: {
                        access_token: this.mintAccessToken(),
                        token_type: 'Bearer',
                        expires_in: this.expiresIn,
                        refresh_token: this.activeRefreshToken, // the NEXT one to use
                    },
                };
            }

            // client_credentials (what `oauth2()` sends by default): no refresh token at all.
            return {
                status: 200,
                headers: {},
                body: {
                    access_token: this.mintAccessToken(),
                    token_type: 'Bearer',
                    expires_in: this.expiresIn,
                },
            };
        };
    }

    /**
     * The resource server. 200 for the access token it currently accepts, 401 for anything
     * expired/rejected — the wall that makes N concurrent callers all decide to refresh at once.
     */
    resourceAdapter(opts: { delayMs?: number } = {}): Adapter {
        return async (req: AdapterRequest): Promise<AdapterResult> => {
            const auth = req.headers['authorization'];
            this.resourceRequests.push(auth);
            // The delay is what makes N calls genuinely OVERLAP: every caller is dispatched and
            // waiting before the first response lands, which is the real-world race.
            if (opts.delayMs) await sleep(opts.delayMs);
            const token = auth?.replace(/^Bearer /, '') ?? '';
            if (!token || this.rejectedAccessTokens.has(token))
                return {
                    status: 401,
                    headers: {},
                    body: { error: 'invalid_token' },
                };
            return { status: 200, headers: {}, body: { ok: true, token } };
        };
    }
}
