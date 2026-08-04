// USER CODE, part 2 — everything in rotating-refresh-strategy.ts PLUS cross-process mutual
// exclusion, built on the only two `StitchStore` primitives that can express a lock:
// `increment(key, ttl)` (atomic; the winner is whoever gets `1`) and `set(key, undefined)`
// (a delete, part of the documented store contract — see `verifyStoreContract`, testing.ts:224).
//
// Losers do NOT redeem. They poll the vault until the winner publishes a new access token, which
// is what keeps a single-use refresh token from being presented twice.
//
// CAVEAT the proof cannot check: `verifyStoreContract` only requires `increment` to be atomic
// WITHIN a process (testing.ts:160-162, 291). A real deployment needs a backend whose increment is
// atomic ACROSS processes (Redis `INCR`, `UPDATE ... RETURNING`). That is a stronger guarantee
// than the store contract demands.
import type {
    Adapter,
    AuthContext,
    AuthStrategy,
} from '../../../../packages/core/src/types';

export interface LockedRotatingRefreshOptions {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    /** Vault namespace — the connected account. Every worker must pass the SAME value. */
    key: string;
    seedRefreshToken: string;
    adapter: Adapter;
    /** Treat the access token as stale this long before its stated expiry. Default 30s. */
    skewMs?: number;
    /** Lock lease. Must exceed a redemption's worst-case latency; a crash frees it after this. */
    lockTtlMs?: number;
    /** How long a loser waits for the winner's token before giving up. Default 5s. */
    waitMs?: number;
    /** Loser poll interval. Default 25ms. */
    pollMs?: number;
}

interface CachedAccess {
    token: string;
    expiresAt: number;
}

interface TokenResponse {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
}

const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

export function lockedRotatingRefresh(
    opts: LockedRotatingRefreshOptions,
): AuthStrategy {
    const skew = opts.skewMs ?? 30_000;
    const lockTtl = opts.lockTtlMs ?? 10_000;
    const waitMs = opts.waitMs ?? 5_000;
    const pollMs = opts.pollMs ?? 25;
    const accessKey = `lr:${opts.key}:access`;
    const refreshKey = `lr:${opts.key}:refresh`;
    const lockKey = `lr:${opts.key}:lock`;
    let inFlight: Promise<void> | undefined;

    const fresh = (c: CachedAccess | undefined): boolean =>
        !!c && (c.expiresAt === 0 || Date.now() < c.expiresAt - skew);

    /** Redeem the stored refresh token ONCE: rotate, persist the new one, cache the access token. */
    const redeem = async (ctx: AuthContext): Promise<void> => {
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
        // Durability ordering: the rotated token lands BEFORE the access token is published.
        if (body.refresh_token)
            await ctx.vault.set(refreshKey, body.refresh_token);
        const ttl = body.expires_in ? body.expires_in * 1000 : undefined;
        await ctx.vault.set(
            accessKey,
            { token: body.access_token, expiresAt: ttl ? Date.now() + ttl : 0 },
            ttl,
        );
    };

    /**
     * Redeem under a store-backed lock scoped to the account. `previous` is the token the caller
     * was holding — a loser is done as soon as the vault shows something different.
     */
    const withLock = async (
        ctx: AuthContext,
        previous: string | undefined,
    ): Promise<void> => {
        const deadline = Date.now() + waitMs;
        for (;;) {
            if ((await ctx.vault.increment(lockKey, lockTtl)) === 1) {
                try {
                    await redeem(ctx);
                } finally {
                    await ctx.vault.set(lockKey, undefined); // release
                }
                return;
            }
            if (Date.now() >= deadline)
                throw new Error(
                    `timed out waiting ${waitMs}ms for another worker to refresh ${opts.key}`,
                );
            await sleep(pollMs);
            const cached = (await ctx.vault.get(accessKey)) as
                CachedAccess | undefined;
            if (cached && cached.token !== previous) return; // the winner published
        }
    };

    /** In-process coalescing IN FRONT of the lock, so one process makes one lock attempt. */
    const redeemOnce = (
        ctx: AuthContext,
        previous: string | undefined,
    ): Promise<void> =>
        (inFlight ??= withLock(ctx, previous).finally(() => {
            inFlight = undefined;
        }));

    return {
        name: 'lockedRotatingRefresh',
        async apply(req, ctx) {
            let cached = (await ctx.vault.get(accessKey)) as
                CachedAccess | undefined;
            if (!fresh(cached)) {
                await redeemOnce(ctx, cached?.token);
                cached = (await ctx.vault.get(accessKey)) as
                    CachedAccess | undefined;
            }
            if (!cached) throw new Error(`no access token for ${opts.key}`);
            req.headers['authorization'] = `Bearer ${cached.token}`;
        },
        shouldRefresh: (res) => res.status === 401,
        async refresh(ctx) {
            const cached = (await ctx.vault.get(accessKey)) as
                CachedAccess | undefined;
            await redeemOnce(ctx, cached?.token);
        },
    };
}
