// `stitch()` middleware: put a seam on the Express request (mirrors @stitchapi/hono's `stitch()` and
// @stitchapi/fastify's `onRequest` wiring, ADR 0002). One prebuilt seam is shared by every request;
// per request the middleware binds the caller's principal — `seam.as(principal)` — into a
// request-scoped handle, so a handler reads an already-principal-bound seam off `req.stitch` and can
// never name another identity.
//
// Borrow, don't own: the app builds and `seam.close()`s the seam — this package never tears it down
// (the seam outlives any one request). Express has no plugin/lifecycle/logger structure to bridge, so
// this is the whole binding: a single `RequestHandler` plus a `req.stitch` type augmentation.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { PrincipalSeam, Seam } from 'stitchapi';

/**
 * The seam the middleware sets and handlers read off `req.stitch`: the request's seam. It is a
 * {@link PrincipalSeam} when `principal` resolved an id (lifecycle-free, identity-bound), else the
 * root {@link Seam}. The lifecycle levers (`close`/`flush`/`invalidate`) live on the root seam the
 * app owns — never on the per-request handle.
 */
export type ExpressRequestSeam = PrincipalSeam | Seam;

/**
 * @deprecated Renamed to {@link ExpressRequestSeam} so the public type is ecosystem-qualified (a bare
 * `RequestSeam` would collide with any other host adapter's per-request seam type) — see
 * [ADR 0012](../../../docs/adr/0012-integration-symbol-naming.md). Kept through the `1.0.0-rc`
 * line and removed at the 1.0 GA cut.
 */
export type RequestSeam = ExpressRequestSeam;

export interface StitchMiddlewareOptions {
    /**
     * The seam this middleware shares across requests. **Borrowed, not owned** — build it once at
     * startup and `seam.close()` it on shutdown yourself; the middleware never closes it (the seam
     * outlives any single request, mirroring StitchAPI's borrow-don't-own rule).
     */
    seam: Seam;
    /**
     * Resolve the request's principal id from the request (e.g. `req.user?.id`, a header, a tenant
     * claim). When it returns a string, `req.stitch` is `seam.as(id)` — a principal-bound handle with
     * separate auth sessions per principal and one shared throttle bucket. When it returns
     * `undefined` (or is omitted), the root seam is used unbound. The principal lives in the closure,
     * never in a call argument, so a handler can never impersonate another identity (ADR 0002 §2).
     */
    principal?: (req: Request) => string | undefined;
}

/**
 * Build the `stitch()` middleware. On every request it sets `req.stitch` (and mirrors it on
 * `res.locals.stitch`) to the principal-bound seam (when `principal` resolves an id) or the shared
 * root seam, then calls `next()`, so handlers call `req.stitch.stitch('/path')()`.
 *
 * ```ts
 * import express from 'express';
 * import { seam } from 'stitchapi';
 * import { stitch, currentStitch } from '@stitchapi/express';
 *
 * const api = seam({ baseUrl: 'https://api.example.com' });
 * const app = express();
 *
 * app.use(stitch({ seam: api, principal: (req) => req.user?.id }));
 * app.get('/me', async (req, res) => res.json(await req.stitch.stitch('/me')()));
 * ```
 */
export function stitch(options: StitchMiddlewareOptions): RequestHandler {
    const { seam, principal } = options;
    return (req: Request, res: Response, next: NextFunction): void => {
        const id = principal?.(req);
        const host: ExpressRequestSeam = id !== undefined ? seam.as(id) : seam;
        req.stitch = host;
        // Mirror onto res.locals so view layers / downstream middleware that only carry `res` reach
        // the same per-request handle.
        res.locals['stitch'] = host;
        next();
    };
}

/**
 * Read the request-scoped {@link ExpressRequestSeam} off a request as a typed value — the same handle
 * `stitch()` set on `req.stitch`. A convenience for code paths that hold a loosely-typed `Request`
 * (e.g. a generic helper) and want the seam without re-declaring the augmentation. Throws if the
 * middleware did not run for this request (so a missing `app.use(stitch(...))` fails loudly).
 *
 * ```ts
 * import { currentStitch } from '@stitchapi/express';
 * const api = currentStitch(req); // the caller's principal-bound seam
 * ```
 */
export function currentStitch(req: Request): ExpressRequestSeam {
    const host = req.stitch as ExpressRequestSeam | undefined;
    if (host === undefined) {
        throw new Error(
            'req.stitch is not set — register `app.use(stitch({ seam }))` before this handler',
        );
    }
    return host;
}

// Augment Express's `Request` so `req.stitch` is typed app-wide once this package is imported.
declare global {
    namespace Express {
        interface Request {
            /**
             * The request-scoped {@link ExpressRequestSeam}: a `seam.as(principal)` handle when a
             * `principal` resolver is set, else the root seam. Set by the {@link stitch} middleware.
             */
            stitch: ExpressRequestSeam;
        }
    }
}
