// `stitch()` — the Elysia integration. It returns an Elysia instance (a plugin you `.use()`) that
// wires the seam into Elysia's request lifecycle the way @stitchapi/fastify's `stitchPlugin` does,
// but in Elysia's Web-standard idiom: `.derive` puts a request-scoped seam on the context, and
// `.onError` maps a thrown StitchError to an HTTP response.
//
// Borrow, don't own: the app builds and `seam.close()`s the seam — this plugin never tears it down
// (the seam outlives any one request). Web-standard by construction: every import is from `elysia`
// or `stitchapi`, never `node:*`, so it runs on Bun, Node, Deno and the edge alike.
import type { PrincipalContext, StitchContext } from './context';
import { type StitchErrorOptions, stitchOnError } from './error';

import { Elysia } from 'elysia';
import type { AtLeastOne, PrincipalSeam, Seam } from 'stitchapi';

/**
 * The context value `.derive` adds and handlers read: the request's seam. It is a
 * {@link PrincipalSeam} when `principal` resolved an id (lifecycle-free, identity-bound), else the
 * root {@link Seam}. The lifecycle levers (`close`/`flush`/`invalidate`) live on the root seam the
 * app owns — never on the per-request handle.
 */
export type ElysiaRequestSeam = PrincipalSeam | Seam;

/**
 * The Elysia instance {@link stitch} returns — a plugin you `.use()`. Its only public contract is
 * the global `derive` adding {@link StitchContext} (`{ stitch }`) to the context of the app that
 * mounts it; the other Singleton slots are empty. Narrowed to this so the published `.d.ts` stays a
 * stable one-liner instead of Elysia's deep per-call generic soup.
 */
export type StitchPlugin = Elysia<
    '',
    {
        decorator: Record<string, never>;
        store: Record<string, never>;
        derive: StitchContext;
        resolve: Record<string, never>;
    }
>;

export interface ElysiaStitchPluginOptions {
    /**
     * The seam this plugin shares across requests. **Borrowed, not owned** — build it once at
     * startup and `seam.close()` it on shutdown yourself; the plugin never closes it (the seam
     * outlives any single request, mirroring StitchAPI's borrow-don't-own rule).
     */
    seam: Seam;
    /**
     * Resolve the request's principal id from the context (e.g. a header/cookie/token on
     * `ctx.request`). When it returns a string, the context seam is `seam.as(id)` — a
     * principal-bound handle with separate auth sessions per principal and one shared throttle
     * bucket. When it returns `undefined` (or is omitted), the root seam is used unbound. The
     * principal lives in the closure, never in a call argument, so a handler can never impersonate
     * another identity (ADR 0002 §2).
     */
    principal?: (ctx: PrincipalContext) => string | undefined;
    /**
     * Options for the StitchError → HTTP mapping the plugin's `.onError` applies (see
     * {@link stitchOnError}). `false` registers **no** handler (you wire your own); `true`
     * (the default) registers the `502`-by-default mapping. The object form must set at least one
     * field — enable-with-defaults is spelled `true`, never `{}` (CONTRACT.md P13/P20).
     *
     * Named for **Elysia's own hook**, per CONTRACT.md P18: a host adapter's slot for a framework
     * hook takes that framework's word for it. Elysia registers via `.onError`, so the option is
     * `onError`; fastify registers via `setErrorHandler`, so its option is `errorHandler`. The two
     * differ on purpose — each reads as the framework its user already knows.
     */
    onError?: boolean | AtLeastOne<StitchErrorOptions>;
}

/**
 * Build the StitchAPI Elysia plugin. `.use()` the returned instance to give every request a
 * `stitch` on its context — the principal-bound `seam.as(principal)` handle when `principal`
 * resolves an id, else the shared root seam — and a `.onError` that maps a thrown StitchError to an
 * HTTP response (`502` by default, so an upstream's status is never leaked).
 *
 * ```ts
 * import { Elysia } from 'elysia';
 * import { seam } from 'stitchapi';
 * import { stitch } from '@stitchapi/elysia';
 *
 * const api = seam({ baseUrl: 'https://api.example.com' });
 *
 * const app = new Elysia()
 *   .use(stitch({ seam: api, principal: ({ request }) => userOf(request) }))
 *   .get('/me', ({ stitch }) => stitch.stitch('/me')());
 * ```
 *
 * The `stitch` context property is typed: a handler reads it off the destructured context.
 */
export function stitch(options: ElysiaStitchPluginOptions): StitchPlugin {
    const { seam, principal, onError } = options;

    // `.derive` runs per request and merges its return into the context. The principal lives in this
    // closure (resolved from the request), never in a call argument, so a handler can never name
    // another identity. `seam.as()` is lifecycle-free (shares the root runtime), so the per-request
    // handle needs no teardown — it is dropped when the request ends. `as: 'global'` so the derived
    // `stitch` (and the error handler below) escape this plugin's scope into the app that `.use()`s it.
    const base = new Elysia({
        name: '@stitchapi/elysia',
        seed: options,
    }).derive({ as: 'global' }, ({ request }): StitchContext => {
        const id = principal?.({ request });
        return { stitch: id !== undefined ? seam.as(id) : seam };
    });

    // Map StitchErrors to HTTP responses (unless the app opted out). `.onError` returning `undefined`
    // for a non-Stitch error leaves Elysia's default handling in charge. Both branches expose the
    // same `stitch` context, so the public {@link StitchPlugin} return type is stable either way.
    const app =
        onError === false
            ? base
            : base.onError(
                  { as: 'global' },
                  stitchOnError(typeof onError === 'object' ? onError : {}),
              );

    return app as unknown as StitchPlugin;
}
