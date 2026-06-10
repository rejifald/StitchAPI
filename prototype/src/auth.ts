// Auth strategies + secret resolvers. The key idea: the stitch holds the credential,
// resolved at call time — the caller (an agent) never sees it. `cookieSession` performs
// a login (another stitch) and manages the cookie jar, refreshing on a 401 wall.
import type { AdapterResponse, AuthContext, AuthStrategy, StitchInput } from './types';

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
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const fs = require('node:fs');
            const file = `${process.env.HOME}/.stitch/secrets.json`;
            if (fs.existsSync(file)) {
                const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
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
            const token = Buffer.from(`${resolve(opts.user)}:${resolve(opts.pass)}`).toString('base64');
            req.headers['authorization'] = `Basic ${token}`;
        },
    };
}

export interface CookieSessionOpts {
    /** The login stitch (exposes __raw to read response headers). */
    login: { __raw: (input?: StitchInput) => Promise<AdapterResponse> };
    /** Cookie name to capture from Set-Cookie and replay on each request. */
    cookie: string;
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
    const nsKey = 'cookie:' + (opts.key ?? opts.cookie);

    const doRefresh = async (ctx: AuthContext) => {
        ctx.emit('auth', 'login');
        const res = await opts.login.__raw(opts.loginInput?.());
        const setCookie = (res.headers['set-cookie'] ?? res.headers['Set-Cookie']) as string | undefined;
        const value = parseCookie(setCookie, opts.cookie);
        if (value != null) await ctx.store.set(nsKey, `${opts.cookie}=${value}`, opts.ttlMs);
    };

    return {
        name: 'cookieSession',
        async apply(req, ctx) {
            let cookie = (await ctx.store.get(nsKey)) as string | undefined;
            if (!cookie) {
                await doRefresh(ctx);
                cookie = (await ctx.store.get(nsKey)) as string | undefined;
            }
            if (cookie) {
                req.headers['cookie'] = [req.headers['cookie'], cookie].filter(Boolean).join('; ');
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

function parseCookie(setCookie: string | undefined, name: string): string | undefined {
    if (!setCookie) return undefined;
    for (const part of setCookie.split(/,(?=[^;]+=)/)) {
        const seg = part.trim().split(';')[0];
        const eq = seg.indexOf('=');
        if (eq > 0 && seg.slice(0, eq).trim() === name) return seg.slice(eq + 1).trim();
    }
    return undefined;
}
