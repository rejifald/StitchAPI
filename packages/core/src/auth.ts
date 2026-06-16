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

/**
 * Base64-encode a UTF-8 string without Node's `Buffer`, so HTTP Basic credentials work in a
 * browser bundle too (the browser-first gate — `Buffer` is absent there). The bytes match
 * `Buffer.from(s, 'utf8').toString('base64')` exactly, non-ASCII included: `TextEncoder` emits
 * the same UTF-8 bytes, mapped 1:1 to a binary string for `btoa` (a DOM/Node global).
 */
function base64(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}

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

export function bearer(token: Secret): AuthStrategy {
    return {
        name: 'bearer',
        scheme: { type: 'http', scheme: 'bearer' },
        apply(req) {
            req.headers['authorization'] = `Bearer ${resolve(token)}`;
        },
    };
}

export function apiKey(opts: { header?: string; value: Secret }): AuthStrategy {
    const headerName = opts.header ?? 'X-API-Key';
    const header = headerName.toLowerCase();
    return {
        name: 'apiKey',
        scheme: { type: 'apiKey', in: 'header', name: headerName },
        apply(req) {
            req.headers[header] = resolve(opts.value);
        },
    };
}

export function basic(opts: { user: Secret; pass: Secret }): AuthStrategy {
    return {
        name: 'basic',
        scheme: { type: 'http', scheme: 'basic' },
        apply(req) {
            const token = base64(`${resolve(opts.user)}:${resolve(opts.pass)}`);
            req.headers['authorization'] = `Basic ${token}`;
        },
    };
}

export interface OAuth2Opts {
    /** The `client_credentials` token endpoint (POST, form-encoded). */
    tokenUrl: string;
    /** OAuth2 client id; resolved at call time (env/secretsFile), never committed. */
    clientId: Secret;
    /** OAuth2 client secret; resolved at call time. */
    clientSecret: Secret;
    /** Optional space-delimited scopes. */
    scope?: string;
    /**
     * How the client authenticates to the token endpoint (RFC 6749 §2.3.1). Default `'post'`
     * (`client_secret_post`) puts `client_id`/`client_secret` in the form body. `'basic'`
     * (`client_secret_basic`) sends them as an HTTP Basic `Authorization` header and keeps only
     * `grant_type` (plus `scope`/`audience`/`params`) in the body — what providers like Kyivstar
     * SMS require. The header is Base64 of `id:secret`, encoded browser-safe (no `Buffer`).
     */
    clientAuth?: 'post' | 'basic';
    /** OAuth2 `audience` (Auth0 / RFC 8693); added to the token-request body when set. */
    audience?: string;
    /**
     * Extra fields merged into the token-request form body — an escape hatch for provider-specific
     * params (`resource`, a custom `grant_type`, …). Merged over the built-ins, so it can override
     * `grant_type`/`scope`/`audience`; the client credentials are always applied last and can never
     * be overridden here.
     */
    params?: Record<string, string>;
    /**
     * Extra headers on the token request (e.g. a provider-required header). Keys are lower-cased;
     * cannot override the `Authorization` header that `clientAuth: 'basic'` sets.
     */
    headers?: Record<string, string>;
    /** Statuses that mean the token was rejected and should force a refresh. Default [401]. */
    refreshOn?: number[];
    /** Refresh this many ms BEFORE the token's expiry, so it is never used mid-flight. Default 30_000. */
    refreshSkewMs?: number;
    /** Store namespace — give two stitches the same `key` + a shared `store` to share one token. Default: `tokenUrl`. */
    key?: string;
    /**
     * Token tenancy (ADR 0002 §3). Default **`'app'`**: one token serves every caller — the right
     * model for `client_credentials`, which authenticates the *application*, not a user. Set
     * `'principal'` to fold the seam-bound principal into the token's cache key (and **throw if no
     * principal is bound**, mirroring {@link CookieSessionOpts.scope}); each tenant then caches its
     * own token and one tenant's 401/refresh never disturbs another's in-flight calls. Pair it with
     * per-tenant `clientId`/`clientSecret`/`scope` for full multi-tenant separation.
     */
    tenancy?: 'principal' | 'app';
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
    const baseKey = 'oauth2:' + (opts.key ?? opts.tokenUrl);
    const tenancy = opts.tenancy ?? 'app';
    const adapter = opts.adapter ?? fetchAdapter();
    const clientAuth = opts.clientAuth ?? 'post';
    const flight = singleFlight<string>();

    // The vault key for THIS call. Default 'app' shares one token across all callers (correct for
    // client_credentials — the token authenticates the application, not a user). 'principal' folds
    // the seam-bound principal in (fail-closed if none, mirroring cookieSession's scope), so each
    // tenant caches its own token and one tenant's 401/refresh never disturbs another's.
    const keyFor = (ctx: AuthContext): string => {
        if (tenancy === 'app') return baseKey;
        const principal = ctx.principal;
        if (principal == null || principal === '') {
            const e = new Error(
                "oauth2 with tenancy 'principal' requires a bound principal: create the stitch " +
                    'through a seam and call `seam.as(principalId)`, or use the default ' +
                    "tenancy 'app' to share one token across all callers.",
            );
            e.name = 'StitchAuthError';
            throw e;
        }
        // U+0000 can't appear in a principal id or key, so it's a collision-free separator.
        return `${baseKey}\u0000${principal}`;
    };

    const isFresh = (t: CachedToken | undefined): boolean =>
        !!t && (t.expiresAt === 0 || now() < t.expiresAt - skew);

    // Fetch a new token from the endpoint and cache it (with TTL = expires_in). Always hits
    // the network; callers gate on `isFresh` to reuse the cached token instead.
    const fetchToken = async (
        ctx: AuthContext,
        nsKey: string,
    ): Promise<string> => {
        ctx.emit('auth', 'token');
        const body: Record<string, string> = {
            grant_type: 'client_credentials',
        };
        if (opts.scope) body['scope'] = opts.scope;
        if (opts.audience) body['audience'] = opts.audience;
        // Escape-hatch params first, so they can set grant_type/resource/etc. — but BEFORE the
        // credentials below, which are applied last and can never be shadowed by `params`.
        if (opts.params) Object.assign(body, opts.params);

        const headers: Record<string, string> = { accept: 'application/json' };
        for (const [k, v] of Object.entries(opts.headers ?? {}))
            headers[k.toLowerCase()] = v;

        if (clientAuth === 'basic') {
            // client_secret_basic: credentials ride in an HTTP Basic header (set last, so a
            // caller-supplied header can't clobber it) and stay OUT of the body.
            const creds = base64(
                `${resolve(opts.clientId)}:${resolve(opts.clientSecret)}`,
            );
            headers['authorization'] = `Basic ${creds}`;
        } else {
            // client_secret_post: credentials in the form body, applied last so `params` can't shadow them.
            body['client_id'] = resolve(opts.clientId);
            body['client_secret'] = resolve(opts.clientSecret);
        }

        const res = await adapter({
            url: opts.tokenUrl,
            method: 'POST',
            headers,
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
        // The token is a secret → it lives in the vault (off `__config`, redacted from traces),
        // not the inspectable store. A shared seam/store still shares one token across workers.
        await ctx.vault.set(nsKey, cached, ttlMs);
        return cached.token;
    };

    const tokenFor = async (ctx: AuthContext): Promise<string> => {
        const nsKey = keyFor(ctx);
        const cached = (await ctx.vault.get(nsKey)) as CachedToken | undefined;
        // Cache miss/stale: coalesce concurrent callers into ONE in-flight fetch.
        return isFresh(cached)
            ? cached!.token
            : flight(nsKey, () => fetchToken(ctx, nsKey));
    };

    // Non-secret scheme for `export --openapi`: the token endpoint + declared scopes are public
    // (any OpenAPI document carries them); the client id/secret never leave the vault.
    const scopes: Record<string, string> = {};
    if (opts.scope)
        for (const s of opts.scope.split(/\s+/).filter(Boolean)) scopes[s] = '';

    return {
        name: 'oauth2',
        scheme: {
            type: 'oauth2',
            flows: { clientCredentials: { tokenUrl: opts.tokenUrl, scopes } },
        },
        async apply(req, ctx) {
            req.headers['authorization'] = `Bearer ${await tokenFor(ctx)}`;
        },
        shouldRefresh(res) {
            return refreshOn.includes(res.status);
        },
        async refresh(ctx) {
            // Force a fresh token, ignoring the cache — but simultaneous 401s
            // still share one fetch (an in-flight fetch IS the freshest token).
            const nsKey = keyFor(ctx);
            await flight(nsKey, () => fetchToken(ctx, nsKey));
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
    /**
     * Inputs (credentials) for the login call, resolved at call time. Receives the bound
     * `principal` (from `seam.as(id)`, `undefined` when none) so trusted code can map the
     * identity to that user's credentials — credentials still never originate from the caller.
     */
    loginInput?: (principal?: string) => StitchInput;
    /** Statuses that mean "the wall" and should trigger a re-login. Default [401]. */
    refreshOn?: number[];
    /** Inspect the response (status + body) for a soft wall — e.g. a 200 that is actually a login page. */
    refreshWhen?: (res: AdapterResponse) => boolean;
    /** Vault namespace — give two stitches the same `key` + a shared seam/store to share one session. */
    key?: string;
    /** Optional TTL (ms) for the stored session. With `scope: 'principal'`, set this — per-user sessions multiply. */
    ttlMs?: number;
    /**
     * Who the session belongs to (ADR 0002 §3). **Fail-closed default `'principal'`**: the
     * session is keyed by the seam-bound principal and the call **throws if no principal is
     * bound** — per-user auth can never silently run app-wide. `'app'` is the explicit opt-in to
     * sharing ONE session across all callers (the only safe choice for a standalone `stitch()`,
     * which never has a principal). Sessions always live in the {@link AuthContext.vault}.
     */
    scope?: 'principal' | 'app';
}

export function cookieSession(opts: CookieSessionOpts): AuthStrategy {
    const refreshOn = opts.refreshOn ?? [401];
    const jarMode = opts.jar === true || opts.cookie === '*';
    const scope = opts.scope ?? 'principal';
    const baseKey = (jarMode ? 'jar:' : 'cookie:') + (opts.key ?? opts.cookie);
    const flight = singleFlight<unknown>();

    // Resolve the session key (in the vault) + login principal for this call. With the
    // fail-closed `'principal'` default, the seam-bound principal is folded into the key — and a
    // call with NO principal bound throws, so per-user auth can never silently share a session
    // (ADR 0002 §3). `'app'` is the explicit opt-in to one shared session.
    const sessionFor = (
        ctx: AuthContext,
    ): { key: string; principal?: string } => {
        if (scope === 'app') return { key: baseKey };
        const principal = ctx.principal;
        if (principal == null || principal === '') {
            const e = new Error(
                "cookieSession with scope 'principal' (the default) requires a bound principal: " +
                    'create the stitch through a seam and call `seam.as(principalId)`, or set ' +
                    "`scope: 'app'` to deliberately share one session across all callers.",
            );
            e.name = 'StitchAuthError';
            throw e;
        }
        // U+0000 can't appear in a principal id or cookie key, so it's a collision-free separator.
        return { key: `${baseKey}\u0000${principal}`, principal };
    };

    const doRefresh = async (
        ctx: AuthContext,
        key: string,
        principal: string | undefined,
    ) => {
        ctx.emit('auth', 'login');
        // `__raw` runs the login once and returns its raw AdapterResponse (headers and all).
        // It is intentionally not on the public Stitch type, so reach it through a cast.
        const res = await (
            opts.login as unknown as {
                __raw: (input?: StitchInput) => Promise<AdapterResponse>;
            }
        ).__raw(opts.loginInput?.(principal));
        const setCookie =
            res.headers['set-cookie'] ?? res.headers['Set-Cookie'];
        if (jarMode) {
            // Capture the full jar: every name=value pair the login set.
            const jar = parseCookieJar(setCookie);
            if (Object.keys(jar).length > 0)
                await ctx.vault.set(key, jar, opts.ttlMs);
        } else {
            const value = parseCookie(setCookie, opts.cookie);
            if (value != null)
                await ctx.vault.set(key, `${opts.cookie}=${value}`, opts.ttlMs);
        }
    };

    return {
        name: 'cookieSession',
        // A session cookie is conventionally modelled as an apiKey-in-cookie scheme (the login
        // flow that fills it is out of band). Only the non-jar mode names a single cookie; jar
        // mode replays the whole Set-Cookie set, so it has no single scheme to declare.
        ...(jarMode
            ? {}
            : {
                  scheme: {
                      type: 'apiKey',
                      in: 'cookie',
                      name: opts.cookie,
                  } as const,
              }),
        async apply(req, ctx) {
            const { key, principal } = sessionFor(ctx);
            let stored = await ctx.vault.get(key);
            if (!stored) {
                // Concurrent cold sessions for the SAME principal share ONE login (the principal
                // is in the key, so different users never coalesce — GAP-AUDIT §2.6 + ADR §3).
                await flight(key, () => doRefresh(ctx, key, principal));
                stored = await ctx.vault.get(key);
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
            const { key, principal } = sessionFor(ctx);
            // Simultaneous 401-driven re-logins for the same principal coalesce into one login.
            await flight(key, () => doRefresh(ctx, key, principal));
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
