// `stitch()` middleware: put a seam on the Hono request context (mirrors @stitchapi/nest's seam
// wiring, ADR 0002). One prebuilt seam is shared by every request; per request the middleware binds
// the caller's principal — `seam.as(principalId)` — into a request-scoped handle, so a handler reads
// an already-principal-bound seam off the context and can never name another identity.
//
// Borrow, don't own: the app builds and `seam.close()`s the seam — this package never tears it down
// (the seam outlives any one request). Edge-safe: imports only Hono's factory (Fetch-based), no
// `node:*`, so it runs on Node, Cloudflare Workers, Deno, Bun and Vercel Edge alike.
import type { Context, Env, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { PrincipalSeam, Seam } from 'stitchapi';

/**
 * The context variable the middleware sets and handlers read: the request's seam. It is a
 * {@link PrincipalSeam} when `principal` resolved an id (lifecycle-free, identity-bound), else the
 * root {@link Seam}. The lifecycle levers (`close`/`flush`/`invalidate`) live on the root seam the
 * app owns — never on the per-request handle.
 */
export type HonoRequestSeam = PrincipalSeam | Seam;

/** The key the seam is stored under on `c.var` / via `c.set` / `c.get`. */
export const STITCH_VAR = 'stitch' as const;

/**
 * A Hono `Env` whose `Variables` carry the request seam under `stitch`. Parametrise your `Hono`
 * app with it so `c.get('stitch')` is typed:
 *
 * ```ts
 * import { Hono } from 'hono';
 * import type { StitchEnv } from '@stitchapi/hono';
 *
 * const app = new Hono<StitchEnv>();
 * ```
 *
 * Intersect it with your own env when you have other variables: `new Hono<StitchEnv & MyEnv>()`.
 */
export interface StitchEnv extends Env {
    Variables: {
        [STITCH_VAR]: HonoRequestSeam;
    };
}

export interface StitchMiddlewareOptions {
    /**
     * The seam this middleware shares across requests. **Borrowed, not owned** — build it once at
     * startup and `seam.close()` it on shutdown yourself; the middleware never closes it (the seam
     * outlives any single request, mirroring StitchAPI's borrow-don't-own rule).
     */
    seam: Seam;
    /**
     * Resolve the request's principal id from the context (e.g. `c.get('user')?.id`). When it
     * returns a string, the context seam is `seam.as(id)` — a principal-bound handle with separate
     * auth sessions per principal and one shared throttle bucket. When it returns `undefined` (or is
     * omitted), the root seam is used unbound. The principal lives in the closure, never in a call
     * argument, so a handler can never impersonate another identity (ADR 0002 §2).
     */
    principal?: (c: Context) => string | undefined;
}

/**
 * Build the `stitch()` middleware. On every request it sets `c.set('stitch', …)` to the
 * principal-bound seam (when `principal` resolves an id) or the shared root seam, so handlers call
 * `c.get('stitch').stitch('/path')()`.
 *
 * ```ts
 * import { Hono } from 'hono';
 * import { seam } from 'stitchapi';
 * import { stitch, type StitchEnv } from '@stitchapi/hono';
 *
 * const api = seam({ baseUrl: 'https://api.example.com' });
 * const app = new Hono<StitchEnv>();
 *
 * app.use(stitch({ seam: api, principal: (c) => c.get('user')?.id }));
 * app.get('/me', (c) => c.json(c.get('stitch').stitch('/me')()));
 * ```
 */
export function stitch(options: StitchMiddlewareOptions): MiddlewareHandler {
    const { seam, principal } = options;
    return createMiddleware<StitchEnv>(async (c, next) => {
        const id = principal?.(c);
        c.set(STITCH_VAR, id !== undefined ? seam.as(id) : seam);
        await next();
    });
}
