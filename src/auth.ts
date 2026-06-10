// Auth strategies + secret resolvers. The key idea: the stitch holds the credential,
// resolved at call time — the caller (an agent) never sees it. `cookieSession` performs
// a login (another stitch) and manages the cookie jar, refreshing on a 401 wall.
import type {
    AdapterResponse,
    AuthContext,
    AuthStrategy,
    StitchInput,
} from './types';

import { existsSync, readFileSync } from 'node:fs';

export type Secret = string | (() => string);
const resolve = (s: Secret): string => (typeof s === 'function' ? s() : s);

/** Resolve a secret from an environment variable at call time. */
export function env(name: string): () => string {
    return () => {
        const v = process.env[name];
        if (v == null) throw new Error(`missing env var ${name}`);
        return v;
    };
}

/** Spike keychain: reads ~/.stitch/secrets.json, falls back to env. */
export function keychain(name: string): () => string {
    return () => {
        try {
            const file = `${process.env.HOME}/.stitch/secrets.json`;
            if (existsSync(file)) {
                const obj = JSON.parse(readFileSync(file, 'utf8')) as Record<
                    string,
                    unknown
                >;
                if (obj[name] != null) return String(obj[name]);
            }
        } catch {
            /* fall through */
        }
        const v = process.env[name];
        if (v == null) throw new Error(`missing keychain secret ${name}`);
        return v;
    };
}

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

export interface CookieSessionOpts {
    /** The login stitch (exposes __raw to read response headers). */
    login: { __raw: (input?: StitchInput) => Promise<AdapterResponse> };
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

    const doRefresh = async (ctx: AuthContext) => {
        ctx.emit('auth', 'login');
        const res = await opts.login.__raw(opts.loginInput?.());
        const setCookie = (res.headers['set-cookie'] ??
            res.headers['Set-Cookie']) as string | undefined;
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
                await doRefresh(ctx);
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
            await doRefresh(ctx);
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
        const seg = part.trim().split(';')[0];
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
