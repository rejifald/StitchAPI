// Auth strategies + secret resolvers. The key idea: the stitch holds the credential,
// resolved at call time — the caller (an agent) never sees it. `cookieSession` performs
// a login (another stitch) and manages the cookie jar, refreshing on a 401 wall.
import { fetchAdapter } from './http-adapter';
import type {
    Adapter,
    AdapterResponse,
    AuthContext,
    AuthStrategy,
    Stitch,
    StitchInput,
} from './types';
import { nodeFs, now, readEnv } from './util';

export type Secret = string | (() => string);
const resolve = (s: Secret): string => (typeof s === 'function' ? s() : s);

/** Resolve a secret from an environment variable at call time. */
export function env(name: string): () => string {
    return () => {
        const v = readEnv(name);
        if (v == null) throw new Error(`missing env var ${name}`);
        return v;
    };
}

/**
 * Read a named secret from `~/.stitch/secrets.json` (plaintext JSON — keep
 * the file private); falls back to the env var of the same name if the file
 * is absent or does not contain the key; throws if neither is available.
 *
 * WARNING: the secrets file is unencrypted plaintext JSON. Restrict its
 * permissions (`chmod 600 ~/.stitch/secrets.json`) and never commit it.
 */
export function secretsFile(name: string): () => string {
    return () => {
        try {
            // No node:fs (browser): skip the file, fall through to the env var.
            const fs = nodeFs();
            const file = `${readEnv('HOME')}/.stitch/secrets.json`;
            if (fs?.existsSync(file)) {
                const obj = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
                    string,
                    unknown
                >;
                if (obj[name] != null) return String(obj[name]);
            }
        } catch {
            /* fall through */
        }
        const v = readEnv(name);
        if (v == null) throw new Error(`missing secret ${name}`);
        return v;
    };
}

/**
 * @deprecated Use {@link secretsFile} instead — same behaviour, clearer name.
 */
export const keychain = secretsFile;

export function bearer(token: Secret): AuthStrategy {
    return {
        name: 'bearer',
        apply(req) {
            req.headers['authorization'] = `Bearer ${resolve(token)}`;
        },
    };
}

export function apiKey(opts: { header?: string; value: Secret }): AuthStrategy {
    const header = (opts.header ?? 'x-api-key').toLowerCase();
    return {
        name: 'apiKey',
        apply(req) {
            req.headers[header] = resolve(opts.value);
        },
    };
}

export function basic(opts: { user: Secret; pass: Secret }): AuthStrategy {
    return {
        name: 'basic',
        apply(req) {
            const token = Buffer.from(
                `${resolve(opts.user)}:${resolve(opts.pass)}`,
            ).toString('base64');
            req.headers['authorization'] = `Basic ${token}`;
        },
    };
}

export interface OAuth2Opts {
    /** The `client_credentials` token endpoint (POST, form-encoded). */
    tokenUrl: string;
    /** OAuth2 client id; resolved at call time (env/keychain), never committed. */
    clientId: Secret;
    /** OAuth2 client secret; resolved at call time. */
    clientSecret: Secret;
    /** Optional space-delimited scopes. */
    scope?: string;
    /** Statuses that mean the token was rejected and should force a refresh. Default [401]. */
    refreshOn?: number[];
    /** Refresh this many ms BEFORE the token's expiry, so it is never used mid-flight. Default 30_000. */
    refreshSkewMs?: number;
    /** Store namespace — give two stitches the same `key` + a shared `store` to share one token. Default: `tokenUrl`. */
    key?: string;
    /** Test seam / custom transport for the token request (default `fetchAdapter()`). */
    adapter?: Adapter;
}

interface CachedToken {
    token: string;
    expiresAt: number; // epoch ms; 0 = no known expiry (never proactively refreshed)
}

/**
 * In-process single-flight: concurrent callers of the same key await ONE shared
 * promise instead of each running `run` themselves (GAP-AUDIT §2.6). The entry
 * is cleared on settle, so a rejected run never poisons later retries.
 */
function singleFlight<T>(): (key: string, run: () => Promise<T>) => Promise<T> {
    const inFlight = new Map<string, Promise<T>>();
    return (key, run) => {
        let p = inFlight.get(key);
        if (!p) {
            p = run().finally(() => inFlight.delete(key));
            inFlight.set(key, p);
        }
        return p;
    };
}

/**
 * OAuth2 `client_credentials`: POST the token endpoint, cache the access token in the
 * StitchStore (TTL from `expires_in`), refresh it `refreshSkewMs` before expiry, and attach
 * it as `Authorization: Bearer …`. A SHARED store makes one token serve many stitches/workers
 * and survive restarts; a rejected token (status in `refreshOn`) forces a fresh fetch + retry.
 */
export function oauth2(opts: OAuth2Opts): AuthStrategy {
    const refreshOn = opts.refreshOn ?? [401];
    const skew = opts.refreshSkewMs ?? 30_000;
    const nsKey = 'oauth2:' + (opts.key ?? opts.tokenUrl);
    const adapter = opts.adapter ?? fetchAdapter();
    const flight = singleFlight<string>();

    const isFresh = (t: CachedToken | undefined): boolean =>
        !!t && (t.expiresAt === 0 || now() < t.expiresAt - skew);

    // Fetch a new token from the endpoint and cache it (with TTL = expires_in). Always hits
    // the network; callers gate on `isFresh` to reuse the cached token instead.
    const fetchToken = async (ctx: AuthContext): Promise<string> => {
        ctx.emit('auth', 'token');
        const body: Record<string, string> = {
            grant_type: 'client_credentials',
            client_id: resolve(opts.clientId),
            client_secret: resolve(opts.clientSecret),
        };
        if (opts.scope) body['scope'] = opts.scope;

        const res = await adapter({
            url: opts.tokenUrl,
            method: 'POST',
            headers: { accept: 'application/json' },
            body,
            bodyType: 'form',
        });
        if (res.status >= 400)
            throw new Error(`oauth2 token request failed: HTTP ${res.status}`);

        const payload = (res.body ?? {}) as {
            access_token?: string;
            expires_in?: number;
        };
        if (!payload.access_token)
            throw new Error('oauth2 token response missing access_token');

        const ttlMs =
            typeof payload.expires_in === 'number'
                ? payload.expires_in * 1000
                : undefined;
        const cached: CachedToken = {
            token: payload.access_token,
            expiresAt: ttlMs ? now() + ttlMs : 0,
        };
        await ctx.store.set(nsKey, cached, ttlMs);
        return cached.token;
    };

    const tokenFor = async (ctx: AuthContext): Promise<string> => {
        const cached = (await ctx.store.get(nsKey)) as CachedToken | undefined;
        // Cache miss/stale: coalesce concurrent callers into ONE in-flight fetch.
        return isFresh(cached)
            ? cached!.token
            : flight(nsKey, () => fetchToken(ctx));
    };

    return {
        name: 'oauth2',
        async apply(req, ctx) {
            req.headers['authorization'] = `Bearer ${await tokenFor(ctx)}`;
        },
        shouldRefresh(res) {
            return refreshOn.includes(res.status);
        },
        async refresh(ctx) {
            // Force a fresh token, ignoring the cache — but simultaneous 401s
            // still share one fetch (an in-flight fetch IS the freshest token).
            await flight(nsKey, () => fetchToken(ctx));
        },
    };
}

export interface CookieSessionOpts {
    /** The login stitch — its raw response (the Set-Cookie headers) seeds the session. */
    login: Stitch;
    /**
     * Cookie name to capture from Set-Cookie and replay on each request, or `'*'` to capture and
     * replay the WHOLE Set-Cookie jar (every cookie the login set, not just one named cookie).
     */
    cookie: string;
    /** Capture/replay the full Set-Cookie set — equivalent to `cookie: '*'` (in jar mode `cookie` only seeds the store key). */
    jar?: boolean;
    /** Inputs (credentials) for the login call, resolved at call time. */
    loginInput?: () => StitchInput;
    /** Statuses that mean "the wall" and should trigger a re-login. Default [401]. */
    refreshOn?: number[];
    /** Inspect the response (status + body) for a soft wall — e.g. a 200 that is actually a login page. */
    refreshWhen?: (res: AdapterResponse) => boolean;
    /** Store namespace — give two stitches the same `key` + a shared `store` to share one session. */
    key?: string;
    /** Optional TTL (ms) for the stored cookie. */
    ttlMs?: number;
}

export function cookieSession(opts: CookieSessionOpts): AuthStrategy {
    const refreshOn = opts.refreshOn ?? [401];
    const jarMode = opts.jar === true || opts.cookie === '*';
    const nsKey = (jarMode ? 'jar:' : 'cookie:') + (opts.key ?? opts.cookie);
    const flight = singleFlight<unknown>();

    const doRefresh = async (ctx: AuthContext) => {
        ctx.emit('auth', 'login');
        // `__raw` runs the login once and returns its raw AdapterResponse (headers and all).
        // It is intentionally not on the public Stitch type, so reach it through a cast.
        const res = await (
            opts.login as unknown as {
                __raw: (input?: StitchInput) => Promise<AdapterResponse>;
            }
        ).__raw(opts.loginInput?.());
        const setCookie =
            res.headers['set-cookie'] ?? res.headers['Set-Cookie'];
        if (jarMode) {
            // Capture the full jar: every name=value pair the login set.
            const jar = parseCookieJar(setCookie);
            if (Object.keys(jar).length > 0)
                await ctx.store.set(nsKey, jar, opts.ttlMs);
        } else {
            const value = parseCookie(setCookie, opts.cookie);
            if (value != null)
                await ctx.store.set(
                    nsKey,
                    `${opts.cookie}=${value}`,
                    opts.ttlMs,
                );
        }
    };

    return {
        name: 'cookieSession',
        async apply(req, ctx) {
            let stored = await ctx.store.get(nsKey);
            if (!stored) {
                // Concurrent cold sessions share ONE login (GAP-AUDIT §2.6).
                await flight(nsKey, () => doRefresh(ctx));
                stored = await ctx.store.get(nsKey);
            }
            // Non-jar: a stored `name=value` string. Jar: a stored map → serialize all pairs.
            const cookie = jarMode
                ? serializeJar(stored as Record<string, string> | undefined)
                : (stored as string | undefined);
            if (cookie) {
                req.headers['cookie'] = [req.headers['cookie'], cookie]
                    .filter(Boolean)
                    .join('; ');
            }
        },
        shouldRefresh(res) {
            return refreshOn.includes(res.status) || !!opts.refreshWhen?.(res);
        },
        async refresh(ctx) {
            // Simultaneous 401-driven re-logins coalesce into one login call.
            await flight(nsKey, () => doRefresh(ctx));
        },
    };
}

/**
 * Parse every `name=value` pair from a (possibly comma-joined) Set-Cookie header into a jar,
 * keeping only the cookie value (the first segment) and dropping attributes (Path, HttpOnly, …).
 */
function parseCookieJar(setCookie: string | undefined): Record<string, string> {
    const jar: Record<string, string> = {};
    if (!setCookie) return jar;
    for (const part of setCookie.split(/,(?=[^;]+=)/)) {
        const seg = part.trim().split(';')[0] ?? '';
        const eq = seg.indexOf('=');
        if (eq > 0) jar[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
    }
    return jar;
}

function parseCookie(
    setCookie: string | undefined,
    name: string,
): string | undefined {
    return parseCookieJar(setCookie)[name];
}

/** Serialize a captured jar back into a `name=value; name=value` Cookie header. */
function serializeJar(jar: Record<string, string> | undefined): string {
    if (!jar) return '';
    return Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}
