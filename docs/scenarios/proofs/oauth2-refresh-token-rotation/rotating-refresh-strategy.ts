// USER CODE — a custom `AuthStrategy` (the exported type) implementing the rotating
// `grant_type=refresh_token` grant that `oauth2()` cannot express. This file is the answer to
// "how much code does a user have to write?", so it contains NOTHING but the strategy.
//
// It provides, in order of importance:
//   1. rotation      — the `refresh_token` from each response becomes the next request's input;
//   2. durability    — the rotated token is written to `ctx.vault` BEFORE the access token is
//                      handed out, so a crash costs an access token, not the account;
//   3. single-flight — concurrent callers of one account await ONE redemption (in-process).
//
// It does NOT provide cross-process mutual exclusion — see locked-refresh-strategy.ts (proved by
// c6-cross-process-lock.ts).
import type {
    Adapter,
    AuthContext,
    AuthStrategy,
} from '../../../../packages/core/src/types';

export interface RotatingRefreshOptions {
    /** The provider's token endpoint. */
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    /** Vault namespace — the CONNECTED ACCOUNT, which is the correct scope of mutual exclusion. */
    key: string;
    /** Refresh token to start from; used only when the vault holds none yet. */
    seedRefreshToken: string;
    /** Transport for the token request (the proof injects a fake provider here). */
    adapter: Adapter;
    /** Treat the access token as stale this long before its stated expiry. Default 30s. */
    skewMs?: number;
}

interface CachedAccess {
    token: string;
    expiresAt: number; // epoch ms; 0 = no known expiry
}

interface TokenResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
}

export function rotatingRefresh(opts: RotatingRefreshOptions): AuthStrategy {
    const skew = opts.skewMs ?? 30_000;
    const accessKey = `rr:${opts.key}:access`;
    const refreshKey = `rr:${opts.key}:refresh`;
    // In-process single-flight, scoped to this strategy instance (one account per instance).
    let inFlight: Promise<string> | undefined;

    /** Redeem the stored refresh token ONCE: rotate, persist, cache. */
    const redeem = async (ctx: AuthContext): Promise<string> => {
        const stored = (await ctx.vault.get(refreshKey)) as string | undefined;
        const res = await opts.adapter({
            url: opts.tokenUrl,
            method: 'POST',
            headers: { accept: 'application/json' },
            body: {
                grant_type: 'refresh_token',
                refresh_token: stored ?? opts.seedRefreshToken,
                client_id: opts.clientId,
                client_secret: opts.clientSecret,
            },
            bodyType: 'form',
        });
        const body = (res.body ?? {}) as TokenResponse;
        if (res.status >= 400 || !body.access_token)
            throw new Error(
                `refresh_token grant failed: HTTP ${res.status}. The account may need re-authorization.`,
            );
        // Persist the ROTATED token first: the old one is spent server-side the moment the
        // provider answered, so the write must land before the access token is used.
        if (body.refresh_token)
            await ctx.vault.set(refreshKey, body.refresh_token);
        const ttl = body.expires_in ? body.expires_in * 1000 : undefined;
        await ctx.vault.set(
            accessKey,
            { token: body.access_token, expiresAt: ttl ? Date.now() + ttl : 0 },
            ttl,
        );
        return body.access_token;
    };

    /** Coalesce concurrent redemptions into one; clear on settle so a failure never sticks. */
    const redeemOnce = (ctx: AuthContext): Promise<string> =>
        (inFlight ??= redeem(ctx).finally(() => {
            inFlight = undefined;
        }));

    return {
        name: 'rotatingRefresh',
        async apply(req, ctx) {
            const cached = (await ctx.vault.get(accessKey)) as
                CachedAccess | undefined;
            const fresh =
                cached &&
                (cached.expiresAt === 0 ||
                    Date.now() < cached.expiresAt - skew);
            req.headers['authorization'] =
                `Bearer ${fresh ? cached.token : await redeemOnce(ctx)}`;
        },
        shouldRefresh: (res) => res.status === 401,
        async refresh(ctx) {
            await redeemOnce(ctx);
        },
    };
}
