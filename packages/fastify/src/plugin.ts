// `stitchPlugin` — the Fastify integration. It wraps the seam lifecycle (build-or-borrow,
// decorate, request-scoped principal, teardown) the way `@stitchapi/nest`'s `StitchModule`
// does, but in Fastify's idiom: a `fastify-plugin`-wrapped `FastifyPluginAsync` that decorates
// the app and request, binds a per-request principal via `seam.as(principal)`, and — the
// genuine Node value-add over the browser-first core — makes that principal handle **ambient**
// through `AsyncLocalStorage`, so handlers/services read it with `currentStitch()` instead of
// threading `request.stitch` everywhere.
import {
    type StitchErrorHandlerOptions,
    stitchErrorHandler,
} from './error-handler';
import { type FastifyLoggerSinkOptions, fastifyLoggerSink } from './logger';

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
    type PrincipalSeam,
    type Seam,
    type SeamConfig,
    seam,
} from 'stitchapi';

// The host a route reads off `request.stitch` / `currentStitch()`: a principal-bound handle
// when a `principal` resolver is set, else the root seam (both create member stitches).
export type FastifyRequestSeam = Seam | PrincipalSeam;

/** Common options shared by both `StitchPluginOptions` variants. */
interface StitchPluginCommon {
    /**
     * Derive the request's principal id (e.g. a tenant or user id) from the incoming request.
     * When set, each request gets a `seam.as(principal)` handle (a separate session/token over
     * the *shared* store + throttle) on `request.stitch` and via `currentStitch()`. Return
     * `undefined` to fall back to the unbound root seam for that request (e.g. anonymous).
     */
    principal?: (req: FastifyRequest) => string | undefined;
    /**
     * Bridge `fastify.log` (Fastify's built-in Pino logger) into the seam as its `TraceSink`,
     * so stitch events flow through Fastify's logger. Default `true`. Ignored when a prebuilt
     * `seam` is passed *and* it already has its own `trace` — a borrowed seam keeps its sink.
     * Set `false` to leave tracing as the seam configured it (off by default in core).
     */
    logger?: boolean | FastifyLoggerSinkOptions;
    /**
     * Options for the error handler the plugin registers (see {@link stitchErrorHandler}).
     * Set to `false` to register **no** error handler (you wire your own). Default: register
     * with the `502`-by-default mapping.
     */
    errorHandler?: StitchErrorHandlerOptions | false;
    /**
     * Close the seam on `onClose`. Defaults to `true` **only when the plugin built the seam**
     * (from `seamConfig`); a borrowed seam (passed via `seam`) is never closed by the plugin —
     * the app owns its lifecycle. Set `true` to force-close a borrowed seam, or `false` to keep
     * a built one alive past the Fastify instance (rare).
     */
    closeSeam?: boolean;
}

/** Pass a prebuilt seam the app owns — the plugin borrows it and never closes it by default. */
export interface StitchPluginSeamOptions extends StitchPluginCommon {
    seam: Seam;
    seamConfig?: never;
}

/** Let the plugin build (and, by default, own + close) the seam from a {@link SeamConfig}. */
export interface StitchPluginConfigOptions extends StitchPluginCommon {
    seamConfig: SeamConfig;
    seam?: never;
}

export type StitchPluginOptions =
    | StitchPluginSeamOptions
    | StitchPluginConfigOptions;

// The ambient request-scoped host. `currentStitch()` reads it; the `onRequest` hook runs each
// request inside `als.run(host, …)` so the value is the per-request principal handle.
const als = new AsyncLocalStorage<FastifyRequestSeam>();

/**
 * The ambient request-scoped {@link FastifyRequestSeam} for the in-flight request — the principal-bound
 * `seam.as(principal)` handle (or the root seam when no principal resolver is set). Returns
 * `undefined` outside a request (no ambient context), so a caller can fall back to an explicit
 * seam. Backed by Node's {@link AsyncLocalStorage}: a value-add a Node integration offers that
 * the browser-first core cannot.
 *
 * ```ts
 * import { currentStitch } from '@stitchapi/fastify';
 * async function loadUser() {
 *   const api = currentStitch(); // the caller's principal-bound seam, no threading
 *   return api?.stitch({ path: '/me' })();
 * }
 * ```
 */
export function currentStitch(): FastifyRequestSeam | undefined {
    return als.getStore();
}

const pluginImpl: FastifyPluginAsync<StitchPluginOptions> = async (
    fastify,
    options,
) => {
    const built = options.seamConfig !== undefined;

    // Build-or-borrow the seam. When we build it, default the Pino logger bridge ON (unless
    // `logger: false`) by injecting a `fastifyLoggerSink(fastify.log)` as the seam's TraceSink.
    let instance: Seam;
    if (built) {
        const cfg = options.seamConfig as SeamConfig;
        const wantLogger = options.logger !== false;
        const loggerOpts: FastifyLoggerSinkOptions =
            typeof options.logger === 'object' ? options.logger : {};
        instance = seam({
            ...cfg,
            // A `trace` already on the config wins; otherwise bridge fastify.log when wanted.
            ...(cfg.trace === undefined && wantLogger
                ? { trace: fastifyLoggerSink(fastify.log, loggerOpts) }
                : {}),
        });
    } else {
        instance = options.seam as Seam;
    }

    // Ownership (mirrors the Nest `borrowStore` rule): close only a seam we built, unless the
    // app overrides `closeSeam` explicitly. Never close a borrowed seam by default.
    const ownsSeam = options.closeSeam ?? built;

    // Decorate the app with the root seam, and reserve `request.stitch` (set in onRequest, which
    // runs before any handler, so the declared non-null `FastifyRequestSeam` type is always satisfied).
    fastify.decorate('stitch', instance);
    fastify.decorateRequest('stitch');

    // Per-request: compute the principal, bind `seam.as(principal)`, stash it on the request,
    // and run the rest of the request inside the ALS context so `currentStitch()` is ambient.
    fastify.addHook('onRequest', (request, _reply, done) => {
        const principal = options.principal?.(request);
        const host: FastifyRequestSeam =
            principal !== undefined ? instance.as(principal) : instance;
        // `seam.as()` is lifecycle-free (it shares the root runtime), so the per-request handle
        // needs no teardown — it is dropped when the request ends.
        (request as { stitch: FastifyRequestSeam }).stitch = host;
        // Enter the ALS context for the whole request lifecycle. `done` is called *inside*
        // `run`, so every subsequent hook/handler on this request sees the ambient host.
        als.run(host, done);
    });

    // Map StitchErrors to HTTP responses (unless the app opted out).
    if (options.errorHandler !== false) {
        fastify.setErrorHandler(stitchErrorHandler(options.errorHandler ?? {}));
    }

    // Tear down a seam we own when the Fastify instance closes.
    fastify.addHook('onClose', async () => {
        if (ownsSeam) await instance.close();
    });
};

/**
 * The StitchAPI Fastify plugin. Register it to decorate the app with a {@link Seam} and each
 * request with a principal-bound {@link FastifyRequestSeam}, bridge Fastify's Pino logger as the seam's
 * trace sink, map stitch failures to HTTP responses, and tear the seam down on close.
 *
 * Wrapped with `fastify-plugin` so the `fastify.stitch` / `request.stitch` decorators and the
 * `currentStitch()` ambient escape the plugin's encapsulation and are visible app-wide.
 *
 * ```ts
 * import Fastify from 'fastify';
 * import { stitchPlugin } from '@stitchapi/fastify';
 *
 * const app = Fastify({ logger: true });
 * await app.register(stitchPlugin, {
 *   seamConfig: { baseUrl: 'https://api.example.com' },
 *   principal: (req) => req.headers['x-tenant'] as string | undefined,
 * });
 * ```
 */
export const stitchPlugin = fp(pluginImpl, {
    fastify: '4.x || 5.x',
    name: '@stitchapi/fastify',
});

// Augment Fastify's types so `fastify.stitch` and `request.stitch` are typed app-wide.
declare module 'fastify' {
    interface FastifyInstance {
        /** The root {@link Seam} this plugin decorates the app with. */
        stitch: Seam;
    }
    interface FastifyRequest {
        /**
         * The request-scoped {@link FastifyRequestSeam}: a `seam.as(principal)` handle when a
         * `principal` resolver is set, else the root seam. The same value `currentStitch()`
         * returns inside the request.
         */
        stitch: FastifyRequestSeam;
    }
}
