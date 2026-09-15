// `stitchapi/auth` — the auth strategies + secret resolvers (ADR 0021). The key idea: the stitch
// holds the credential, resolved at call time — the caller (an agent) never sees it.
// `cookieSession` performs a login (another stitch) and manages the cookie jar, refreshing on a
// 401 wall.
//
// This is a SUBPATH entry, not part of the root barrel: `auth` is the one config slot whose values
// cost real bytes to construct (oauth2 + cookieSession carry a token cache and a login state
// machine), and nothing on the core path imports this module. Behind its own entry, "you only pay
// for the strategy you import" stops being a tree-shaking outcome and becomes a module-graph fact —
// it holds for CJS, for a naive bundler, and for anyone reading the import list. Same rule as
// `cache` (ADR 0003 §11) and the non-http surfaces (ADR 0005 Decision 10).
import { compact } from './compact';
import { fetchAdapter } from './http-adapter';
import { acceptsStatus, parseRetryAfter } from './resilience';
import type {
    Adapter,
    AdapterResult,
    AtLeastOne,
    AuthContext,
    AuthStrategy,
    RunContext,
    StatusMatch,
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

// The auth types a caller needs are DECLARED on the root (they are part of the `StitchConfig`
// contract — a BYO strategy is a value you hand to `stitch()`), and re-exported here so authoring
// auth takes one import, not two. Type-only, so this costs zero bytes in either entry.
export type { AuthContext, AuthStrategy, SecurityScheme } from './types';

/**
 * A credential: a literal string, or a getter resolved at CALL time (what {@link env},
 * `credential.file` and `credential.from` return) so the declaration carries a capability
 * rather than a value. Public so a peer package that accepts a consumer-authored credential —
 * `@stitchapi/aws-sigv4`'s `accessKeyId`, say — names core's type instead of mirroring it.
 */
export type Secret = string | (() => string);
const resolve = (s: Secret): string => (typeof s === 'function' ? s() : s);

/**
 * A resolver that may yield no value: `bearer` attaches the header only when it resolves to a
 * value, and otherwise skips it (announcing the miss) instead of failing. Produced by
 * `env.optional`, and branded so `bearer` can tell it apart from a required {@link Secret} —
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
 * The shape of {@link env} — callable for the required case, with `optional` hanging off it.
 * Declared explicitly rather than left to `Object.assign` inference so BOTH halves keep their own
 * documentation in the emitted `.d.ts`: an inferred intersection types the call correctly but
 * drops the prose, and the caveats below are the whole reason these two are one name.
 */
export interface EnvResolver {
    /**
     * Resolve a REQUIRED secret from an environment variable at call time. An exported-but-empty
     * var (`MY_TOKEN=`) counts as missing and throws — mirroring `env.optional`, which treats `''`
     * as absent — so a blank credential can never silently ride along. For the
     * may-or-may-not-be-set case, use `env.optional`.
     */
    (name: string): () => string;
    /**
     * Like {@link env}, but OPTIONAL: resolves the variable's value, or *absent* (`undefined`) when
     * it is unset or empty — it never throws. An exported-but-empty var (`MY_TOKEN=`) counts as
     * absent, so `bearer` never sends `Bearer ` with no token. Pass it to {@link bearer} to attach
     * the credential only when present, otherwise send the request unauthenticated (announced in
     * the trace): `bearer(env.optional('GITHUB_TOKEN'))`. For local/dev runs, notebooks, and agent
     * loops where a token may or may not be exported; when the call must be authenticated, use the
     * throwing `bearer(env('GITHUB_TOKEN'))`. In a browser bundle (no process environment) it
     * resolves absent, so `bearer` simply attaches nothing.
     */
    optional(name: string): OptionalSecret;
}

function envRequired(name: string): () => string {
    return () => {
        const v = readEnv(name);
        if (v == null || v === '')
            throw new Error(
                `missing env var ${name}. Fix: set it in the environment, use env.optional() if it's optional, or credential.from() to read it from injected config.`,
            );
        return v;
    };
}

function envOptional(name: string): OptionalSecret {
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
 * The environment-variable secret resolver. One SOURCE, so one name — and because requiredness is
 * a modifier on that source rather than a second source, `env` is itself the required resolver and
 * `optional` hangs off it: `env('NAME')` throws when the variable is unset, `env.optional('NAME')`
 * resolves to *absent* instead. The same shape as the token grammars and `secrets` (one name per
 * dimension, the distinction named at the call site) applied to a dimension that happens to have a
 * dominant case, which is why this one stays callable instead of growing an `env.required`.
 *
 * Both halves treat an exported-but-empty var (`MY_TOKEN=`) as ABSENT, so a blank credential can
 * never silently ride along — `env` throws on it, `env.optional` reports it missing and `bearer`
 * sends the request unauthenticated.
 *
 * **Only the process environment.** For a secret that comes from anywhere else — the on-disk
 * secrets file, or a config object a DI container injected — see {@link credential}.
 */
// A NOTE ON COST, since the house rule is that a facade must not weld anything onto a consumer's
// path. `credential` below honours that literally: it is a bare object literal, so a bundler drops
// it whole and a `bearer`-only import pulls neither resolver. `env` CANNOT: making one name both
// callable and property-bearing requires mutating a function at module scope, and no bundler will
// elide that — `Object.assign` is an opaque call, and a plain `env.optional = …` assignment is a
// side effect neither esbuild nor rollup will prove away. A `/* @__PURE__ */` annotation does not
// rescue it either: tsup minifies this module on the way to `lib/`, and the annotation is stripped
// from the published artifact, so it would be decoration that reads as a guarantee.
//
// Measured: an import of `bearer` ALONE grows 434 -> 871 B raw, 267 -> 472 B gzip (+205 B), and
// because the call is top-level that ~205 B is paid by EVERY importer of this module, not just one
// that touches `env`. That is the price of `env` staying callable — the dominant case by far —
// instead of becoming an `env.required`/`env.optional` pair, and it is paid only on the
// `stitchapi/auth` subpath, which a consumer has already opted into by importing a strategy. The
// three budgeted scenarios do not move. Revisit if `bearer`-only imports turn out to dominate.
export const env: EnvResolver = Object.assign(envRequired, {
    optional: envOptional,
});

/** A source `credential.from` pulls a named value from: an object with a `get(name)` method
 *  (e.g. a NestJS ConfigService or a secrets-manager client) or a plain `(name) => value` fn. */
export type SecretSource =
    | { get(name: string): string | undefined }
    | ((name: string) => string | undefined);

function credentialFrom(source: SecretSource, name: string): () => string {
    return () => {
        const v =
            typeof source === 'function' ? source(name) : source.get(name);
        if (v == null || v === '')
            throw new Error(
                `missing secret ${name}. Fix: make the source yield a non-empty value, or use env.optional() if it's optional.`,
            );
        return v;
    };
}

function credentialFile(name: string): () => string {
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
 * Secret resolvers for credentials that do NOT come from the process environment — one name per
 * SOURCE, with the source named at the call site rather than prefixed onto two barrel exports.
 * Both members are REQUIRED resolvers: they throw rather than yield a blank credential, mirroring
 * {@link env}, and both return the same `() => string` thunk every strategy accepts, so they
 * compose with `bearer`/`apiKey`/`basic`/`oauth2` exactly like `env()` does.
 *
 * - `credential.file(name)` reads the named key from `~/.stitch/secrets.json`, falling back to the
 *   env var of the same name when the file is absent or lacks the key, and throwing when neither
 *   is available. **WARNING: that file is unencrypted plaintext JSON.** Restrict its permissions
 *   (`chmod 600 ~/.stitch/secrets.json`) and never commit it. In a browser bundle there is no
 *   `node:fs`, so it skips the file and resolves from the environment alone.
 * - `credential.from(source, name)` resolves from an arbitrary injected `source` — for DI'd apps
 *   that supply config WITHOUT touching `process.env` (a ConfigService, a secrets-manager client,
 *   a validated config object). The source is an object with `get(name)` or a `(name) => value`
 *   function; it throws if the source yields no value (unset or empty), mirroring `env()`.
 *   `bearer(credential.from(configService, 'GITHUB_TOKEN'))`.
 *
 * **The environment variable case is not here.** It is the dominant source and has its own
 * callable namespace, {@link env}; `credential.file` falls back to an env var, but reading one
 * directly is `env(name)`.
 *
 * The noun is the one {@link Secret} already describes. It is deliberately NOT `secrets` — that
 * word is the ROOT barrel's trace-redaction namespace (`secrets.register`/`has`/`redact`), and two
 * different objects behind one name on two entry points is the P1 "one word, one concept"
 * violation that no amount of subpath separation makes readable.
 */
export const credential = {
    file: credentialFile,
    from: credentialFrom,
} as const;

export function bearer(token: Secret | OptionalSecret): AuthStrategy {
    return {
        name: 'bearer',
        scheme: { type: 'http', scheme: 'bearer' },
        apply(req, ctx) {
            // An optional secret (e.g. env.optional): attach the header only when it resolves to a
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
 * Options for {@link apiKey}. `in` selects where the key goes and `name` labels it there — the same
 * two fields for every location (they no longer diverge by arm), so the shape maps 1:1 onto
 * OpenAPI's `apiKey` security scheme (`{ name, in }`, CONTRACT.md P22). The key itself is `secret`
 * — NOT `value`, which P5 reserves surface-wide for the Standard-Schema success payload (the same
 * overload that renamed `SchemaFingerprint.value` to `token`); OpenAPI's scheme carries no
 * credential material, so there is no upstream spelling to mirror for it.
 *
 * Exported, like every sibling auth builder's option type ({@link BasicOptions},
 * {@link OAuth2Options}, {@link CookieSessionOptions}) — CONTRACT.md P14/P16: a multi-field
 * envelope is a named, exported interface, and the parity argument runs that way, not the other.
 * Left un-exported it inlined into `apiKey`'s emitted `.d.ts` as an anonymous shape, so a consumer
 * could neither import nor extend it while its three siblings imported fine.
 */
export interface ApiKeyOptions {
    /** Where the key is sent. Default `'header'`. */
    in?: 'header' | 'query' | 'cookie';
    /**
     * Name of the header, query parameter, or cookie the key is sent as. Default `'X-API-Key'` for
     * a header (sent lower-cased), `'api_key'` for a query parameter or cookie.
     */
    name?: string;
    /** The key itself — a {@link Secret} resolved at call time; the caller never sees it. */
    secret: Secret;
}

/**
 * Set `name=value` on a request `Cookie` header, REPLACING any existing pair with the same name
 * (a duplicate cookie name is ambiguous — RFC 6265 §5.4 — and re-applying the strategy on a retry
 * must stay idempotent) while keeping the other pairs in place. Cookie names are case-sensitive, so
 * the match is exact.
 */
function setCookiePair(
    existing: string | undefined,
    name: string,
    value: string,
): string {
    const parts = (existing ?? '')
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean);
    const idx = parts.findIndex((p) => {
        const eq = p.indexOf('=');
        return (eq < 0 ? p : p.slice(0, eq)).trim() === name;
    });
    const pair = `${name}=${value}`;
    if (idx >= 0) parts[idx] = pair;
    else parts.push(pair);
    return parts.join('; ');
}

/**
 * API-key auth, sent in a request **header** (the default), a **query param**, or a **cookie**.
 * `in` selects the location and `name` labels it in every arm (matching OpenAPI's `{ name, in }`).
 * The key is a {@link Secret} resolved at call time — the caller (an agent) never sees it.
 *
 * - `in: 'header'` (default): writes the `name` header (default `'X-API-Key'`, lower-cased on the wire).
 * - `in: 'query'`: appends `name=<resolved>` (default `'api_key'`) to the request URL, URL-encoded.
 *   The strategy runs in the attempt loop on the fully-built `req` (after templating/query-building),
 *   so it safely appends onto whatever query the URL already carries.
 * - `in: 'cookie'`: appends `name=<resolved>` (default `'api_key'`) to the `Cookie` header, merging
 *   with any cookie the request already carries.
 *
 * SECURITY: a key in the URL leaks wherever URLs go — server access logs, proxies, the browser
 * history, a `Referer` header. Prefer `in: 'header'` (or `'cookie'`) when the API accepts it. The
 * key stays out of StitchAPI's own traces: the strategy mutates only the request the transport
 * sends (the `start` event carries the pre-auth request, so the key never lands there); the `header`
 * and `cookie` arms write header names already on the trace denylist (`cookie` / `x-api-key`); and
 * the `query` arm registers its `name` with the URL-credential scrubber, so if the key surfaces in a
 * sink (an OTLP `url.full`, the structured `input.query`) it is REDACTED, like `api_key`/… are.
 *
 * `secret` is the envelope's one required field, so it names its own scalar shorthand
 * (CONTRACT.md P15), matching {@link bearer}'s positional secret:
 * `apiKey(env('API_KEY'))` ≡ `apiKey({ secret: env('API_KEY') })`.
 */
export function apiKey(optsOrSecret: ApiKeyOptions | Secret): AuthStrategy {
    // A `Secret` is a string or a thunk; the envelope is the one non-callable object form.
    const opts: ApiKeyOptions =
        typeof optsOrSecret === 'string' || typeof optsOrSecret === 'function'
            ? { secret: optsOrSecret }
            : optsOrSecret;
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
                    buildQuery({ [name]: resolve(opts.secret) }),
                );
            },
        };
    }
    if (opts.in === 'cookie') {
        const name = opts.name ?? 'api_key';
        return {
            name: 'apiKey',
            scheme: { type: 'apiKey', in: 'cookie', name },
            apply(req) {
                // Send the key as a cookie: set `name=value` on the Cookie header, replacing any
                // same-named cookie the request already carries (never a duplicate; idempotent on
                // retry) and keeping the rest. The value is sent verbatim — a cookie is read
                // byte-for-byte, unlike a percent-decoded query param. The `cookie` header is on
                // the trace denylist, so the key is redacted from sinks like the header arm.
                req.headers['cookie'] = setCookiePair(
                    req.headers['cookie'],
                    name,
                    resolve(opts.secret),
                );
            },
        };
    }
    const headerName = opts.name ?? 'X-API-Key';
    const header = headerName.toLowerCase();
    return {
        name: 'apiKey',
        scheme: { type: 'apiKey', in: 'header', name: headerName },
        apply(req) {
            req.headers[header] = resolve(opts.secret);
        },
    };
}

export interface BasicOptions {
    user: Secret;
    pass: Secret;
}

/** HTTP Basic auth. Positional `basic(user, pass)` ≡ `basic({ user, pass })` (CONTRACT.md P15). */
export function basic(user: Secret, pass: Secret): AuthStrategy;
export function basic(opts: BasicOptions): AuthStrategy;
export function basic(
    userOrOpts: Secret | BasicOptions,
    pass?: Secret,
): AuthStrategy {
    // A Secret is a string or a thunk, never a plain object — so an object IS the options form.
    const opts: BasicOptions =
        typeof userOrOpts === 'string' || typeof userOrOpts === 'function'
            ? { user: userOrOpts, pass: pass as Secret }
            : userOrOpts;
    return {
        name: 'basic',
        scheme: { type: 'http', scheme: 'basic' },
        apply(req) {
            const token = base64(`${resolve(opts.user)}:${resolve(opts.pass)}`);
            req.headers['authorization'] = `Basic ${token}`;
        },
    };
}

/**
 * Envelope for {@link OAuth2Options.refresh} (CONTRACT.md P24: `refreshOn` + `refreshSkew` shared
 * the `refresh` prefix, so they fold into one envelope; a bare {@link StatusMatch} is the P12
 * dominant-field shorthand for `{ on }`).
 */
export interface OAuth2RefreshOptions {
    /**
     * Status(es) — or a predicate — that mean the token was rejected and should force a refresh
     * (CONTRACT.md P7: `401` ≡ `[401]`). Default `[401]`.
     */
    on?: StatusMatch;
    /** Refresh this long BEFORE the token's expiry, so it is never used mid-flight — `30_000`, `'30s'`. Default 30s. */
    skew?: number | string;
}

/**
 * Envelope for {@link OAuth2Options.client} — WHO the client is at the token endpoint, and how it
 * proves it (CONTRACT.md P24: `clientId`/`clientSecret`/`clientAuth` shared the `client` prefix,
 * so they fold into one envelope). Named and exported per P14.
 *
 * No scalar shorthand: P12/P14 offer one only for an **unambiguously dominant** field, and `id`
 * and `secret` are co-equal — both required, neither usable without the other — so no single
 * scalar could name the pair. A positional `[id, secret]` tuple (the `circuit` form) is rejected
 * for the same reason it would be unsafe: both members are {@link Secret}, so a transposed tuple
 * type-checks and fails at the provider. `tokenUrl` stays FLAT beside this envelope — the endpoint
 * is the address, a different subject from the identity calling it (P1).
 *
 * Not `AtLeastOne<OAuth2ClientOptions>`: that wrapper exists to make `{}` a compile error on an
 * ALL-OPTIONAL bag (P20), and here `id`/`secret` are already required, so `client: {}` is a type
 * error without it — the `CacheOptions.ttl` reading of P15. Applied to this envelope
 * `AtLeastOne` would be actively wrong: each of its arms re-optionalises the members it did not
 * pick, so `client: { id }` — a client with no secret — would start type-checking.
 */
export interface OAuth2ClientOptions {
    /**
     * OAuth2 client id (`client_id` on the wire); resolved at call time (env/credential.file), never
     * committed.
     */
    id: Secret;
    /** OAuth2 client secret (`client_secret` on the wire); resolved at call time. */
    secret: Secret;
    /**
     * How the client authenticates to the token endpoint (RFC 6749 §2.3.1). Default `'post'`
     * (`client_secret_post`) puts `client_id`/`client_secret` in the form body. `'basic'`
     * (`client_secret_basic`) sends them as an HTTP Basic `Authorization` header and keeps only
     * `grant_type` (plus `scope`/`audience`/`params`) in the body — what providers like Kyivstar
     * SMS require. The header is Base64 of `id:secret`, encoded browser-safe (no `Buffer`).
     *
     * Spelled `via` — "the client authenticates VIA basic" — and NOT `auth`, because that token is
     * already spent: `StitchConfig.auth` holds an {@link AuthStrategy}, a behaviour object with a
     * required `apply` closure. One token would then denote two concepts over two value-spaces (an
     * object vs a closed string union), which CONTRACT.md P2 forbids outright — two fields that
     * legitimately mean different things MUST NOT share a name even if each is individually
     * defensible; rename one. Locality is not a defence: P2 is what forecloses it, and here the two
     * would nest visibly inside ONE call expression —
     * `auth: oauth2({ client: { auth: 'basic' } })`.
     *
     * Not RFC 7591's `tokenEndpointAuthMethod` either: this envelope is house vocabulary, not a
     * mirror (see {@link OAuth2Options}). RFC 6749 §2.3.1 names the METHODS, not a request
     * parameter, so there is no wire spelling to keep faith with here — the two VALUES are the
     * house short forms of `client_secret_post` / `client_secret_basic`, and they are unchanged by
     * this spelling.
     */
    via?: 'post' | 'basic';
}

/**
 * Options for {@link oauth2}. House vocabulary, NOT an RFC 6749 mirror: the client credentials
 * are translated, not exported — re-cased into `client_id`/`client_secret` where the token-request
 * form body is built, and moved out of that body into a Basic `Authorization` header under
 * `client.via: 'basic'` — so there is no identity mapping to protect where RFC 6749's names were
 * being claimed. (`scope`/`audience` do go out under their own names, and most of this interface
 * never reaches the body at all; neither was ever the field group under discussion.)
 * `OAuth2ClientCredentialsFlow` states the test the contracts that ARE mirrors have to meet —
 * "spelled exactly as the spec spells it … so
 * `stitch export --openapi` emits it as an identity mapping" — and this one does not meet it, so
 * CONTRACT.md P18's second half governs: a house contract uses house vocabulary. That is why the
 * client credentials fold into {@link OAuth2ClientOptions} (P24) instead of staying flat.
 */
export interface OAuth2Options {
    /** The `client_credentials` token endpoint (POST, form-encoded). */
    tokenUrl: string;
    /**
     * The client's identity at that endpoint — `{ id, secret }`, plus `via` to pick
     * `client_secret_post` (default) or `client_secret_basic` (CONTRACT.md P24 envelope).
     */
    client: OAuth2ClientOptions;
    /** Optional space-delimited scopes. */
    scope?: string;
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
     * cannot override the `Authorization` header that `client.via: 'basic'` sets.
     */
    headers?: Record<string, string>;
    /**
     * When to force a fresh token (CONTRACT.md P24 envelope). A bare {@link StatusMatch} — a
     * number, a list, or a predicate — is shorthand for `{ on }` (P12): the status(es) that mean
     * the token was rejected (CONTRACT.md P7: `401` ≡ `[401]`). Default `[401]`. Reach `skew` —
     * how long BEFORE the token's expiry to refresh it, so it is never used mid-flight (`30_000`,
     * `'30s'`; default 30s) — through the envelope form: `refresh: { skew: '1m' }`.
     */
    refresh?: StatusMatch | AtLeastOne<OAuth2RefreshOptions>;
    /** Store namespace — give two stitches the same `key` + a shared `store` to share one token. Default: `tokenUrl`. */
    key?: string;
    /**
     * Token tenancy (ADR 0002 §3). Default **`'app'`**: one token serves every caller — the right
     * model for `client_credentials`, which authenticates the *application*, not a user. Set
     * `'principal'` to fold the seam-bound principal into the token's cache key (and **throw if no
     * principal is bound**, mirroring {@link CookieSessionOptions.tenancy}); each tenant then caches its
     * own token and one tenant's 401/refresh never disturbs another's in-flight calls. Pair it with
     * per-tenant `client.id`/`client.secret`/`scope` for full multi-tenant separation.
     */
    tenancy?: 'principal' | 'app';
    /** Test seam / custom transport for the token request (default `fetchAdapter()`). */
    adapter?: Adapter;
}

interface CachedToken {
    token: string;
    expiresAt: number; // epoch ms; 0 = no known expiry (never proactively refreshed)
}

// Read time off the engine-threaded Clock (ADR 0010), falling back to the wall clock when the
// context carries none (a hand-built AuthContext in a strategy's own unit test). Token freshness
// is CONTROL-FLOW time — it decides whether the next call fetches — so it belongs on the same
// seam that already drives retry/throttle/timeout/circuit, which is what lets a `manualClock()`
// advance a test past `expires_in` without real waiting.
const clockNow = (ctx: AuthContext): number => ctx.clock?.now() ?? now();

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
 * Normalize a `refresh` slot (CONTRACT.md P24) to its envelope form, ONCE, at strategy
 * construction — every internal read then goes through the normalized object, never the raw
 * union. A bare {@link StatusMatch} (number, list, or predicate) is the P12 dominant-field
 * shorthand for `{ on: <value> }`; an object is already the envelope (possibly `undefined`,
 * meaning "use the caller's defaults").
 */
function normalizeRefresh<T extends { on?: StatusMatch }>(
    refresh: StatusMatch | AtLeastOne<T> | undefined,
): Partial<T> {
    if (refresh === undefined) return {};
    if (
        typeof refresh === 'number' ||
        typeof refresh === 'function' ||
        Array.isArray(refresh)
    )
        return { on: refresh } as Partial<T>;
    return refresh;
}

/**
 * OAuth2 `client_credentials`: POST the token endpoint, cache the access token in the
 * StitchStore (TTL from `expires_in`), refresh it `refresh.skew` before expiry, and attach
 * it as `Authorization: Bearer …`. A SHARED store makes one token serve many stitches/workers
 * and survive restarts; a rejected token (status matched by `refresh`/`refresh.on`) forces a
 * fresh fetch + retry.
 */
export function oauth2(opts: OAuth2Options): AuthStrategy {
    const refreshOpts = normalizeRefresh<OAuth2RefreshOptions>(opts.refresh);
    const refreshMatch = acceptsStatus(refreshOpts.on ?? [401]);
    const skew = parseDuration(refreshOpts.skew) ?? 30_000;
    const baseKey = 'oauth2:' + (opts.key ?? opts.tokenUrl);
    const tenancy = opts.tenancy ?? 'app';
    const adapter = opts.adapter ?? fetchAdapter();
    const authMethod = opts.client.via ?? 'post';
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

    const isFresh = (t: CachedToken | undefined, at: number): boolean =>
        !!t && (t.expiresAt === 0 || at < t.expiresAt - skew);

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

        if (authMethod === 'basic') {
            // client_secret_basic: credentials ride in an HTTP Basic header (set last, so a
            // caller-supplied header can't clobber it) and stay OUT of the body.
            const creds = base64(
                `${resolve(opts.client.id)}:${resolve(opts.client.secret)}`,
            );
            headers['authorization'] = `Basic ${creds}`;
        } else {
            // client_secret_post: credentials in the form body, applied last so `params` can't shadow them.
            body['client_id'] = resolve(opts.client.id);
            body['client_secret'] = resolve(opts.client.secret);
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
                `oauth2 token request failed: HTTP ${res.status}. Fix: check tokenUrl, client.id/client.secret, and scope.`,
            );

        const payload = (res.body ?? {}) as {
            access_token?: string;
            expires_in?: number;
        };
        if (!payload.access_token)
            throw new Error(
                'oauth2 token response missing access_token. Fix: check tokenUrl, client.id/client.secret, and scope.',
            );

        const ttlMs =
            typeof payload.expires_in === 'number'
                ? payload.expires_in * 1000
                : undefined;
        const cached: CachedToken = {
            token: payload.access_token,
            expiresAt: ttlMs ? clockNow(ctx) + ttlMs : 0,
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
        return isFresh(cached, clockNow(ctx))
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
            return refreshMatch(res.status);
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
 * hands the host a categorised outcome instead. Surfaced via {@link CookieSessionOptions.onFailure}.
 */
export interface AuthFailureResult {
    /** Which half of the auth attempt failed: `'apply'` = cold session had no stored cookie;
     *  `'refresh'` = a 401-style wall was hit. Spelled `step`, not `phase`, because `phase` is
     *  the request-lifecycle enum on `StitchEvent` (`ProgressPhase`) — one word may not carry two
     *  value-spaces (CONTRACT.md P1). Transfer direction is the third, and is now `direction`. */
    step: 'apply' | 'refresh';
    /** The login response status when the login responded at all (absent when it threw). */
    status?: number;
    /** `Retry-After` parsed to ms when the login was rate-limited (status 429). */
    retryAfter?: number;
    /** The thrown value when the login stitch itself threw (network/transport failure). */
    error?: unknown;
    /**
     * - `'unauthenticated'` — login responded with a status matched by `refresh` (e.g. 401) and set no cookie (bad/expired creds);
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

/**
 * Envelope for {@link CookieSessionOptions.refresh} (CONTRACT.md P24: `refreshOn` + `refreshWhen`
 * shared the `refresh` prefix, so they fold into one envelope; a bare {@link StatusMatch} — incl.
 * a bare function, which is the STATUS predicate — is the P12 dominant-field shorthand for
 * `{ on }`; reaching `when` requires the envelope form).
 */
export interface CookieSessionRefreshOptions {
    /**
     * Status(es) — or a predicate — that mean "the wall" and should trigger a re-login
     * (CONTRACT.md P7: `401` ≡ `[401]`). Default `[401]`.
     */
    on?: StatusMatch;
    /** Inspect the response (status + body) for a soft wall — e.g. a 200 that is actually a login page. */
    when?: (res: AdapterResult) => boolean;
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
     * Derives the credentials for the login call, resolved at call time. Receives the bound
     * `principal` (from `seam.as(id)`, `undefined` when none) so trusted code can map the
     * identity to that user's credentials — credentials still never originate from the caller.
     * The returned {@link StitchInput} is what the `login` stitch is called with.
     *
     * Named `credentialsOf`, not `loginInput`, on CONTRACT.md P6's derivation-function convention
     * (`key` is a value, `keyOf` is a function that produces one): the `Of` suffix says this is a
     * function and the stem says what it returns. It also dissolves the `login`-prefix P24 group —
     * `login` (the required Stitch) and `loginInput` (a callback) shared a leading word while
     * being different value-kinds, which needed a lint carve-out to stay flat.
     */
    credentialsOf?: (principal?: string) => StitchInput;
    /**
     * When to trigger a re-login (CONTRACT.md P24 envelope). A bare function is the P12
     * dominant-field shorthand for `{ on: <fn> }` — a {@link StatusMatch} predicate over the
     * response STATUS; likewise a bare number/list is `{ on: <value> }`: status(es) that mean
     * "the wall" (CONTRACT.md P7: `401` ≡ `[401]`). Default `[401]`. Reach `when` — inspecting the
     * full response (status + body) for a SOFT wall, e.g. a 200 that is actually a login page —
     * only through the envelope form: `refresh: { when: (res) => … }`.
     */
    refresh?: StatusMatch | AtLeastOne<CookieSessionRefreshOptions>;
    /** Vault namespace — give two stitches the same `key` + a shared seam/store to share one session. */
    key?: string;
    /** Optional TTL for the stored session — `60_000`, `'1m'`. With `tenancy: 'principal'`, set this — per-user sessions multiply. */
    ttl?: number | string;
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
    onFailure?: (info: AuthFailureResult) => void | Promise<void>;
    /**
     * Host-owned hook fired once after EVERY (re)login attempt — success or failure — with its
     * {@link RefreshResult}, so the host can persist durable session state and clear/extend its
     * cooldown. Like {@link onFailure}, it runs once per actual attempt (inside the
     * single-flight-guarded `doRefresh`), and a throw is caught so it can't crash the call.
     */
    onRefresh?: (result: RefreshResult) => void | Promise<void>;
}

export function cookieSession(opts: CookieSessionOptions): AuthStrategy {
    const refreshOpts = normalizeRefresh<CookieSessionRefreshOptions>(
        opts.refresh,
    );
    const refreshMatch = acceptsStatus(refreshOpts.on ?? [401]);
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
        name: 'onFailure' | 'onRefresh',
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
    // rate-limited (back off per `Retry-After`); a status matched by `refresh` (e.g. 401) means the
    // creds were rejected; anything else — including a soft 200 wall that set no cookie — is `unknown`.
    const classify = (
        step: 'apply' | 'refresh',
        status: number,
        headers: Record<string, string>,
    ): AuthFailureResult => {
        if (status === 429) {
            // Omit `retryAfter` entirely when the header is absent/unparseable —
            // `exactOptionalPropertyTypes` forbids setting an optional prop to `undefined`.
            return compact({
                step,
                status,
                category: 'rate-limited',
                retryAfter: parseRetryAfter(headers['retry-after']),
            });
        }
        if (refreshMatch(status))
            return { step, status, category: 'unauthenticated' };
        return { step, status, category: 'unknown' };
    };

    // Announce one login attempt's outcome to the host. `onRefresh` fires for EVERY attempt; on a
    // failure (no cookie captured) `onFailure` fires too with the categorised `info`.
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
        const onFailure = opts.onFailure;
        if (!ok && failure && onFailure)
            await runHook(ctx, 'onFailure', () => onFailure(failure));
    };

    // ONE actual login attempt (single-flight-guarded by the callers below, so the hooks fire once
    // per real attempt, never per coalesced waiter). `__raw` RESOLVES only for a 2xx login and
    // THROWS otherwise — an error with a numeric `status` (+ a `response` for its headers) is a
    // response-derived failure (401/429/…); an error without a `status` is a transport failure. Each
    // path fires `onRefresh` always and `onFailure` on failure, then re-throws so callers see the
    // original error exactly as before these hooks existed.
    const doRefresh = async (
        ctx: AuthContext,
        key: string,
        principal: string | undefined,
        step: 'apply' | 'refresh',
    ) => {
        ctx.emit('auth', 'login');
        // `__raw` runs the login once and returns its raw AdapterResult (headers and all);
        // `__rawTraced` does the same but TEES the login's events as a CHILD run (ADR 0007) of the
        // call that triggered it. Neither is on the public Stitch type, so reach them through a cast.
        const login = opts.login as unknown as {
            __raw: (input?: StitchInput) => Promise<AdapterResult>;
            __rawTraced?: (
                input: StitchInput | undefined,
                parent: RunContext,
            ) => Promise<AdapterResult>;
        };
        const credentials = opts.credentialsOf?.(principal);
        let res: AdapterResult;
        try {
            // Trace the login as a child of the caller's run when one is bound and the login
            // supports it; otherwise the original silent raw call (back-compat / standalone).
            res =
                ctx.run && login.__rawTraced
                    ? await login.__rawTraced(credentials, ctx.run)
                    : await login.__raw(credentials);
        } catch (error) {
            // A failed login: an HTTP error carries a numeric `status` (+ the `response` for its
            // headers); a transport error carries neither → `network`.
            const e = error as {
                status?: number;
                response?: AdapterResult;
            };
            const status = typeof e.status === 'number' ? e.status : undefined;
            const failure: AuthFailureResult =
                status === undefined
                    ? { step, category: 'network', error }
                    : classify(step, status, e.response?.headers ?? {});
            await report(ctx, false, status, failure);
            // Re-throw so the caller sees the original error exactly as before these hooks existed.
            throw error;
        }

        const status = res.status;
        const setCookie =
            res.headers['set-cookie'] ?? res.headers['Set-Cookie'];
        let captured = false;
        const sessionTtl = parseDuration(opts.ttl);
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
            captured ? undefined : classify(step, status, res.headers),
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
            return refreshMatch(res.status) || !!refreshOpts.when?.(res);
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
