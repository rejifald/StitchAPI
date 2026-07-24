// Auth strategies + secret resolvers. The key idea: the stitch holds the credential,
// resolved at call time — the caller (an agent) never sees it. `cookieSession` performs
// a login (another stitch) and manages the cookie jar, refreshing on a 401 wall.
import { compact } from './compact';
import { fetchAdapter } from './http-adapter';
import { parseRetryAfter } from './resilience';
import type {
    Adapter,
    AdapterResponse,
    AuthContext,
    AuthStrategy,
    RunContext,
    Stitch,
    StitchInput,
} from './types';
import {
    appendQueryString,
    buildQuery,
    nodeFs,
    now,
    parseDuration,
    readEnv,
    registerSecretKey,
} from './util';

export type Secret = string | (() => string);
const resolve = (s: Secret): string => (typeof s === 'function' ? s() : s);

/**
 * A resolver that may yield no value: `bearer` attaches the header only when it resolves to a
 * value, and otherwise skips it (announcing the miss) instead of failing. Produced by
 * {@link optionalEnv}, and branded so `bearer` can tell it apart from a required {@link Secret} —
 * which also keeps it, at the type level, out of the strategies that demand a credential
 * (`apiKey`, `basic`, `oauth2`).
 */
export interface OptionalSecret {
    (): string | undefined;
    readonly __optional: true;
    /** Human-readable source (e.g. `env var GITHUB_TOKEN`), used in the announced `info` event. */
    readonly label: string;
}
const isOptional = (s: Secret | OptionalSecret): s is OptionalSecret =>
    typeof s === 'function' && '__optional' in s;

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

/**
 * Resolve a REQUIRED secret from an environment variable at call time. An exported-but-empty var
 * (`MY_TOKEN=`) counts as missing and throws — mirroring {@link optionalEnv}, which treats `''` as
 * absent — so a blank credential can never silently ride along. For the may-or-may-not-be-set case,
 * use {@link optionalEnv}.
 */
export function env(name: string): () => string {
    return () => {
        const v = readEnv(name);
        if (v == null || v === '')
            throw new Error(
                `missing env var ${name}. Fix: set it in the environment, or use optionalEnv()/secretFrom() if it's optional.`,
            );
        return v;
    };
}

/** A source `secretFrom` pulls a named value from: an object with a `get(name)` method
 *  (e.g. a NestJS ConfigService or a secrets-manager client) or a plain `(name) => value` fn. */
export type SecretSource =
    | { get(name: string): string | undefined }
    | ((name: string) => string | undefined);

/**
 * Resolve a REQUIRED secret from an arbitrary injected `source` at call time — for DI'd apps that
 * supply config WITHOUT touching `process.env` (a ConfigService, a secrets-manager client, a
 * validated config object). Throws if the source yields no value (unset or empty), mirroring
 * {@link env}. Compose with `bearer`/`apiKey`/`basic`/`oauth2` exactly like `env()`:
 * `bearer(secretFrom(configService, 'GITHUB_TOKEN'))`.
 */
export function secretFrom(source: SecretSource, name: string): () => string {
    return () => {
        const v =
            typeof source === 'function' ? source(name) : source.get(name);
        if (v == null || v === '')
            throw new Error(
                `missing secret ${name}. Fix: set it in the environment, or use optionalEnv()/secretFrom() if it's optional.`,
            );
        return v;
    };
}

/**
 * Like {@link env}, but OPTIONAL: resolves the variable's value, or *absent* (`undefined`) when it
 * is unset or empty — it never throws. Pass it to {@link bearer} to attach the credential only when
 * present, otherwise send the request unauthenticated (announced in the trace):
 * `bearer(optionalEnv('GITHUB_TOKEN'))`. For local/dev runs, notebooks, and agent loops where a
 * token may or may not be exported; when the call must be authenticated, use the throwing
 * `bearer(env('GITHUB_TOKEN'))`. In a browser bundle (no process environment) it resolves absent,
 * so `bearer` simply attaches nothing.
 */
export function optionalEnv(name: string): OptionalSecret {
    // An exported-but-empty var (`MY_TOKEN=`) counts as absent — never send `Bearer ` with no token.
    const read = (): string | undefined => {
        const v = readEnv(name);
        return v == null || v === '' ? undefined : v;
    };
    return Object.assign(read, {
        __optional: true as const,
        label: `env var ${name}`,
    });
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

export function bearer(token: Secret | OptionalSecret): AuthStrategy {
    return {
        name: 'bearer',
        scheme: { type: 'http', scheme: 'bearer' },
        apply(req, ctx) {
            // An optional secret (e.g. optionalEnv): attach the header only when it resolves to a
            // value; otherwise skip it and announce the miss — never a silent no-op. A required
            // Secret keeps the original behavior exactly (resolve, attach; env() throws if unset).
            if (isOptional(token)) {
                const value = token();
                if (value == null || value === '') {
                    ctx.emit(
                        'auth',
                        `no token: ${token.label} not set; request sent unauthenticated`,
                    );
                    return;
                }
                ctx.emit('auth', `bearer from ${token.label}`);
                req.headers['authorization'] = `Bearer ${value}`;
                return;
            }
            req.headers['authorization'] = `Bearer ${resolve(token)}`;
        },
    };
}

/**
 * API-key auth, in a request **header** (the default) or a **query param**. The key is a
 * {@link Secret} resolved at call time — the caller (an agent) never sees it.
 *
 * - `in: 'header'` (default): writes `header` (default `'x-api-key'`, lower-cased) — byte-for-byte
 *   the original behaviour, so existing stitches are unaffected.
 * - `in: 'query'`: appends `name=<resolved>` (default `'api_key'`) to the request URL,
 *   URL-encoded. The strategy runs in the attempt loop on the fully-built `req` (after
 *   templating/query-building), so it safely appends onto whatever query the URL already carries.
 *
 * SECURITY: a key in the URL leaks wherever URLs go — server access logs, proxies, the browser
 * history, a `Referer` header. Prefer `in: 'header'` when the API accepts it. The key stays out of
 * StitchAPI's own traces two ways: the strategy mutates only the request the transport sends (the
 * `start` event carries the pre-auth URL, so the key never lands there), and the configured query
 * `name` is registered with the URL-credential scrubber, so if it does surface in a sink (an OTLP
 * `url.full`, the structured `input.query`) it is REDACTED, like `api_key`/`access_token`/… are.
 */
export function apiKey(
    opts:
        | { in?: 'header'; header?: string; value: Secret }
        | { in: 'query'; name?: string; value: Secret },
): AuthStrategy {
    if (opts.in === 'query') {
        const name = opts.name ?? 'api_key';
        // Teach the trace scrubber this param name carries a secret, so the key never reaches a
        // sink in the clear — even when `name` is a vendor spelling the built-in stems don't catch.
        registerSecretKey(name);
        return {
            name: 'apiKey',
            scheme: { type: 'apiKey', in: 'query', name },
            apply(req) {
                // Resolve at call time (env()/thunk read per call), encode via the same query
                // builder the engine uses, and append onto the existing query — `appendQueryString`
                // switches the leading `?` to `&` and preserves any trailing `#fragment`.
                req.url = appendQueryString(
                    req.url,
                    buildQuery({ [name]: resolve(opts.value) }),
                );
            },
        };
    }
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

export interface OAuth2Options {
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
    /** Refresh this long BEFORE the token's expiry, so it is never used mid-flight — `30_000`, `'30s'`. Default 30s. */
    refreshSkew?: number | string;
    /** @deprecated Renamed to {@link OAuth2Options.refreshSkew} (CONTRACT.md P17). Read until the 1.0 GA cut. */
    refreshSkewMs?: number;
    /** Store namespace — give two stitches the same `key` + a shared `store` to share one token. Default: `tokenUrl`. */
    key?: string;
    /**
     * Token tenancy (ADR 0002 §3). Default **`'app'`**: one token serves every caller — the right
     * model for `client_credentials`, which authenticates the *application*, not a user. Set
     * `'principal'` to fold the seam-bound principal into the token's cache key (and **throw if no
     * principal is bound**, mirroring {@link CookieSessionOptions.tenancy}); each tenant then caches its
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
 * StitchStore (TTL from `expires_in`), refresh it `refreshSkew` before expiry, and attach
 * it as `Authorization: Bearer …`. A SHARED store makes one token serve many stitches/workers
 * and survive restarts; a rejected token (status in `refreshOn`) forces a fresh fetch + retry.
 */
export function oauth2(opts: OAuth2Options): AuthStrategy {
    const refreshOn = opts.refreshOn ?? [401];
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- `refreshSkewMs` is the @deprecated alias of `refreshSkew`, read for back-compat until the GA cut (CONTRACT.md P17)
    const skewInput = opts.refreshSkew ?? opts.refreshSkewMs;
    const skew = parseDuration(skewInput) ?? 30_000;
    const baseKey = 'oauth2:' + (opts.key ?? opts.tokenUrl);
    const tenancy = opts.tenancy ?? 'app';
    const adapter = opts.adapter ?? fetchAdapter();
    const clientAuth = opts.clientAuth ?? 'post';
    const flight = singleFlight<string>();

    // The vault key for THIS call. Default 'app' shares one token across all callers (correct for
    // client_credentials — the token authenticates the application, not a user). 'principal' folds
    // the seam-bound principal in (fail-closed if none, mirroring cookieSession's tenancy), so each
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
            throw new Error(
                `oauth2 token request failed: HTTP ${res.status}. Fix: check tokenUrl, clientId/clientSecret, and scope.`,
            );

        const payload = (res.body ?? {}) as {
            access_token?: string;
            expires_in?: number;
        };
        if (!payload.access_token)
            throw new Error(
                'oauth2 token response missing access_token. Fix: check tokenUrl, clientId/clientSecret, and scope.',
            );

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

/**
 * Why an `apply`/`refresh` login attempt failed, categorised so the HOST can drive its OWN
 * durable state machine (wrong-creds vs rate-limited vs network) — StitchAPI keeps doing the
 * mechanical cookie capture/replay, but it can't model a host's external recovery loop, so it
 * hands the host a categorised outcome instead. Surfaced via {@link CookieSessionOptions.onAuthFailure}.
 */
export interface AuthFailureResult {
    /** `'apply'` = cold session had no stored cookie; `'refresh'` = a 401-style wall was hit. */
    phase: 'apply' | 'refresh';
    /** The login response status when the login responded at all (absent when it threw). */
    status?: number;
    /** `Retry-After` parsed to ms when the login was rate-limited (status 429). */
    retryAfter?: number;
    /** @deprecated Renamed to {@link AuthFailureResult.retryAfter} (CONTRACT.md P17). Read until the 1.0 GA cut. */
    retryAfterMs?: number;
    /** The thrown value when the login stitch itself threw (network/transport failure). */
    error?: unknown;
    /**
     * - `'unauthenticated'` — login responded with a `refreshOn` status (e.g. 401) and set no cookie (bad/expired creds);
     * - `'rate-limited'` — login responded `429` (back off, then retry; see `retryAfter`);
     * - `'network'` — the login stitch threw before any response (DNS/connection/transport);
     * - `'unknown'` — login responded but captured no cookie for some other reason.
     */
    category: 'unauthenticated' | 'rate-limited' | 'network' | 'unknown';
}

/** Outcome of a single (re)login attempt, surfaced via {@link CookieSessionOptions.onRefresh}. */
export interface RefreshResult {
    /** A cookie (named, or any jar entry) was captured from the login response. */
    ok: boolean;
    /** The login response status when the login responded (absent when it threw). */
    status?: number;
}

export interface CookieSessionOptions {
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
    /** Optional TTL for the stored session — `60_000`, `'1m'`. With `tenancy: 'principal'`, set this — per-user sessions multiply. */
    ttl?: number | string;
    /** @deprecated Renamed to {@link CookieSessionOptions.ttl} (CONTRACT.md P17). Read until the 1.0 GA cut. */
    ttlMs?: number;
    /**
     * Who the session belongs to (ADR 0002 §3). **Fail-closed default `'principal'`**: the
     * session is keyed by the seam-bound principal and the call **throws if no principal is
     * bound** — per-user auth can never silently run app-wide. `'app'` is the explicit opt-in to
     * sharing ONE session across all callers (the only safe choice for a standalone `stitch()`,
     * which never has a principal). Sessions always live in the {@link AuthContext.vault}.
     *
     * The two defaults deliberately diverge (CONTRACT.md P8): a cookie session belongs to a user,
     * so it fails closed to `'principal'`, while {@link OAuth2Options.tenancy} defaults to `'app'`
     * because a client-credentials token belongs to the application.
     */
    tenancy?: 'principal' | 'app';
    /**
     * Host-owned hook fired once per ACTUAL login attempt that failed to capture a cookie — NOT
     * per coalesced waiter (it runs inside the single-flight-guarded `doRefresh`). The host maps the
     * categorised {@link AuthFailureResult} to its own status (active/backoff/failed/unauthenticated)
     * and owns the external recovery loop that StitchAPI's per-call single-flight can't model. A
     * throwing hook never crashes the call (it is caught and announced on the `auth` trace topic).
     */
    onAuthFailure?: (info: AuthFailureResult) => void | Promise<void>;
    /**
     * Host-owned hook fired once after EVERY (re)login attempt — success or failure — with its
     * {@link RefreshResult}, so the host can persist durable session state and clear/extend its
     * cooldown. Like {@link onAuthFailure}, it runs once per actual attempt (inside the
     * single-flight-guarded `doRefresh`), and a throw is caught so it can't crash the call.
     */
    onRefresh?: (result: RefreshResult) => void | Promise<void>;
}

export function cookieSession(opts: CookieSessionOptions): AuthStrategy {
    const refreshOn = opts.refreshOn ?? [401];
    const jarMode = opts.jar === true || opts.cookie === '*';
    const tenancy = opts.tenancy ?? 'principal';
    const baseKey = (jarMode ? 'jar:' : 'cookie:') + (opts.key ?? opts.cookie);
    const flight = singleFlight<unknown>();

    // Resolve the session key (in the vault) + login principal for this call. With the
    // fail-closed `'principal'` default, the seam-bound principal is folded into the key — and a
    // call with NO principal bound throws, so per-user auth can never silently share a session
    // (ADR 0002 §3). `'app'` is the explicit opt-in to one shared session.
    const sessionFor = (
        ctx: AuthContext,
    ): { key: string; principal?: string } => {
        if (tenancy === 'app') return { key: baseKey };
        const principal = ctx.principal;
        if (principal == null || principal === '') {
            const e = new Error(
                "cookieSession with tenancy 'principal' (the default) requires a bound principal: " +
                    'create the stitch through a seam and call `seam.as(principalId)`, or set ' +
                    "`tenancy: 'app'` to deliberately share one session across all callers.",
            );
            e.name = 'StitchAuthError';
            throw e;
        }
        // U+0000 can't appear in a principal id or cookie key, so it's a collision-free separator.
        return { key: `${baseKey}\u0000${principal}`, principal };
    };

    // Run a host hook without ever letting it crash the call (the host owns its own recovery loop;
    // its bookkeeping must not take the stitch down). A throw — sync or rejected promise — is
    // swallowed and announced on the `auth` trace topic. Returns a promise the caller awaits so a
    // slow async hook still completes before the login attempt is considered done.
    const runHook = async (
        ctx: AuthContext,
        name: 'onAuthFailure' | 'onRefresh',
        invoke: () => void | Promise<void>,
    ): Promise<void> => {
        try {
            await invoke();
        } catch (err) {
            ctx.emit(
                'auth',
                `${name} hook threw: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    };

    // Categorise a login response that captured no cookie, given its status + headers. A 429 means
    // rate-limited (back off per `Retry-After`); a `refreshOn` status (e.g. 401) means the creds were
    // rejected; anything else — including a soft 200 wall that set no cookie — is `unknown`.
    const classify = (
        phase: 'apply' | 'refresh',
        status: number,
        headers: Record<string, string>,
    ): AuthFailureResult => {
        if (status === 429) {
            // Omit `retryAfter` entirely when the header is absent/unparseable —
            // `exactOptionalPropertyTypes` forbids setting an optional prop to `undefined`.
            const retryAfter = parseRetryAfter(headers['retry-after']);
            const result: AuthFailureResult = compact({
                phase,
                status,
                category: 'rate-limited',
                retryAfter,
            });
            // Co-set the @deprecated `retryAfterMs` alias for back-compat (CONTRACT.md P17/P19), by
            // assignment (not a literal `*Ms:` key) so the contract lint's R2 stays clean.
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- writing the @deprecated alias for back-compat
            if (retryAfter !== undefined) result.retryAfterMs = retryAfter;
            return result;
        }
        if (refreshOn.includes(status))
            return { phase, status, category: 'unauthenticated' };
        return { phase, status, category: 'unknown' };
    };

    // Announce one login attempt's outcome to the host. `onRefresh` fires for EVERY attempt; on a
    // failure (no cookie captured) `onAuthFailure` fires too with the categorised `info`.
    const report = async (
        ctx: AuthContext,
        ok: boolean,
        status: number | undefined,
        failure?: AuthFailureResult,
    ): Promise<void> => {
        // Bind into locals so the optional hooks narrow to defined — no non-null assertion needed.
        const onRefresh = opts.onRefresh;
        if (onRefresh)
            await runHook(ctx, 'onRefresh', () =>
                // `status` only appears on the result object when the login actually responded.
                onRefresh(status === undefined ? { ok } : { ok, status }),
            );
        const onAuthFailure = opts.onAuthFailure;
        if (!ok && failure && onAuthFailure)
            await runHook(ctx, 'onAuthFailure', () => onAuthFailure(failure));
    };

    // ONE actual login attempt (single-flight-guarded by the callers below, so the hooks fire once
    // per real attempt, never per coalesced waiter). `__raw` RESOLVES only for a 2xx login and
    // THROWS otherwise — an error with a numeric `status` (+ a `response` for its headers) is a
    // response-derived failure (401/429/…); an error without a `status` is a transport failure. Each
    // path fires `onRefresh` always and `onAuthFailure` on failure, then re-throws so callers see the
    // original error exactly as before these hooks existed.
    const doRefresh = async (
        ctx: AuthContext,
        key: string,
        principal: string | undefined,
        phase: 'apply' | 'refresh',
    ) => {
        ctx.emit('auth', 'login');
        // `__raw` runs the login once and returns its raw AdapterResponse (headers and all);
        // `__rawTraced` does the same but TEES the login's events as a CHILD run (ADR 0007) of the
        // call that triggered it. Neither is on the public Stitch type, so reach them through a cast.
        const login = opts.login as unknown as {
            __raw: (input?: StitchInput) => Promise<AdapterResponse>;
            __rawTraced?: (
                input: StitchInput | undefined,
                parent: RunContext,
            ) => Promise<AdapterResponse>;
        };
        const loginInput = opts.loginInput?.(principal);
        let res: AdapterResponse;
        try {
            // Trace the login as a child of the caller's run when one is bound and the login
            // supports it; otherwise the original silent raw call (back-compat / standalone).
            res =
                ctx.run && login.__rawTraced
                    ? await login.__rawTraced(loginInput, ctx.run)
                    : await login.__raw(loginInput);
        } catch (error) {
            // A failed login: an HTTP error carries a numeric `status` (+ the `response` for its
            // headers); a transport error carries neither → `network`.
            const e = error as {
                status?: number;
                response?: AdapterResponse;
            };
            const status = typeof e.status === 'number' ? e.status : undefined;
            const failure: AuthFailureResult =
                status === undefined
                    ? { phase, category: 'network', error }
                    : classify(phase, status, e.response?.headers ?? {});
            await report(ctx, false, status, failure);
            // Re-throw so the caller sees the original error exactly as before these hooks existed.
            throw error;
        }

        const status = res.status;
        const setCookie =
            res.headers['set-cookie'] ?? res.headers['Set-Cookie'];
        let captured = false;
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- `ttlMs` is the @deprecated alias of `ttl`, read for back-compat until the GA cut (CONTRACT.md P17)
        const sessionTtl = parseDuration(opts.ttl ?? opts.ttlMs);
        if (jarMode) {
            // Capture the full jar: every name=value pair the login set.
            const jar = parseCookieJar(setCookie);
            if (Object.keys(jar).length > 0) {
                await ctx.vault.set(key, jar, sessionTtl);
                captured = true;
            }
        } else {
            const value = parseCookie(setCookie, opts.cookie);
            if (value != null) {
                await ctx.vault.set(key, `${opts.cookie}=${value}`, sessionTtl);
                captured = true;
            }
        }

        // A 2xx login that set no cookie is a soft wall (a login page served with 200) — report it as
        // a failure so the host still hears about it, classified by its (2xx) status → `unknown`.
        await report(
            ctx,
            captured,
            status,
            captured ? undefined : classify(phase, status, res.headers),
        );
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
                await flight(key, () =>
                    doRefresh(ctx, key, principal, 'apply'),
                );
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
            await flight(key, () => doRefresh(ctx, key, principal, 'refresh'));
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

// CONTRACT.md P3 — deprecated alias, removed at the 1.0 GA cut.
/** @deprecated Renamed to {@link AuthFailureResult} (CONTRACT.md P3). Imported name kept until the 1.0 GA cut. */
export type AuthFailureInfo = AuthFailureResult;
