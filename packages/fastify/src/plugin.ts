// `stitchPlugin` — the Fastify integration. It wraps the seam lifecycle (build-or-borrow,
// decorate, request-scoped principal, teardown) the way `@stitchapi/nest`'s `StitchModule`
// does, but in Fastify's idiom: a `fastify-plugin`-wrapped `FastifyPluginAsync` that decorates
// the app and request, binds a per-request principal via `seam.as(principal)`, and — the
// genuine Node value-add over the browser-first core — makes that principal handle **ambient**
// through `AsyncLocalStorage`, so handlers/services read it with `currentStitch()` instead of
// threading `request.stitch` everywhere.
import { type StitchErrorOptions, stitchErrorHandler } from './error-handler';
import { type FastifyLoggerSinkOptions, fastifyLoggerSink } from './logger';

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
    type AtLeastOne,
    type PrincipalSeam,
    type Seam,
    type SeamConfig,
    isSeam,
    seam,
} from 'stitchapi';

// The host a route reads off `request.stitch` / `currentStitch()`: a principal-bound handle
// when a `principal` resolver is set, else the root seam (both create member stitches).
export type FastifyRequestSeam = Seam | PrincipalSeam;

/** Options shared by both arms of {@link FastifyStitchPluginOptions}. */
interface FastifyStitchPluginCommon {
    /**
     * Derive the request's principal id (e.g. a tenant or user id) from the incoming request.
     * When set, each request gets a `seam.as(principal)` handle (a separate session/token over
     * the *shared* store + throttle) on `request.stitch` and via `currentStitch()`. Return
     * `undefined` to fall back to the unbound root seam for that request (e.g. anonymous).
     */
    principal?: (req: FastifyRequest) => string | undefined;
    /**
     * Options for the error handler the plugin registers (see `stitchError.handler`).
     * `false` registers **no** error handler (you wire your own); `true` (the default) registers
     * the `502`-by-default mapping. The object form must set at least one field — enable-with-
     * defaults is spelled `true`, never `{}` (CONTRACT.md P13/P20).
     *
     * Named for **Fastify's own hook**, per CONTRACT.md P18: a host adapter's slot for a framework
     * hook takes that framework's word for it. Fastify registers via `setErrorHandler`, so the
     * option is `errorHandler`; `@stitchapi/elysia` registers via `.onError`, so its option is
     * `onError`. The two differ on purpose — each reads as the framework its user already knows.
     */
    errorHandler?: boolean | AtLeastOne<StitchErrorOptions>;
    /**
     * Close the seam on `onClose`. Defaults to `true` **only when the plugin built the seam**
     * (i.e. `seam` was given a {@link SeamConfig}); a seam borrowed via `seam: <prebuilt>` is
     * never closed by the plugin — the app owns its lifecycle. Set `true` to force-close a
     * borrowed seam, or `false` to keep a built one alive past the Fastify instance (rare).
     */
    closeSeam?: boolean;
}

/**
 * The **borrow** arm: `seam` is a prebuilt {@link Seam} the app owns. The plugin uses it as-is
 * and never closes it by default.
 */
export interface FastifyStitchPluginBorrowOptions extends FastifyStitchPluginCommon {
    /** A seam the app built and owns. Its runtime (store, vault, trace sink) is used verbatim. */
    seam: Seam;
    /**
     * **Not available on a borrowed seam.** The Pino bridge is injected as the seam's `trace` at
     * BUILD time, and a prebuilt seam's runtime is already fixed — so there is nothing here to
     * switch on. `logger: true` would be a silent no-op, so it is a compile error instead
     * (CONTRACT.md P13: a toggle must actually enable something). To trace a seam you build
     * yourself, pass `trace: fastifyLoggerSink(app.log)` to `seam()`.
     */
    logger?: never;
}

/**
 * The **build** arm: `seam` is a {@link SeamConfig}, so the plugin builds the seam and — by
 * default — owns and closes it.
 */
export interface FastifyStitchPluginBuildOptions extends FastifyStitchPluginCommon {
    /**
     * The shared config fragment to build the seam from. At least one field is required: the
     * opaque `{}` is a compile error (CONTRACT.md P20), because it is indistinguishable from
     * "I forgot to configure this". For an all-defaults seam, build it yourself
     * (`seam: seam()`, plus `closeSeam: true` to keep the plugin owning its teardown).
     */
    seam: AtLeastOne<SeamConfig>;
    /**
     * Bridge `fastify.log` (Fastify's built-in Pino logger) into the seam as its `TraceSink`,
     * so stitch events flow through Fastify's logger. Default `true` (the bridge is on) — the
     * cross-host canonical default. An explicit `seam.trace` wins: the bridge is only injected
     * when the config leaves `trace` unset. Set `false` to leave tracing as the config asked for
     * (off by default in core).
     *
     * Honoured **only here**, on the build arm — see
     * {@link FastifyStitchPluginBorrowOptions.logger}.
     */
    logger?: boolean | AtLeastOne<FastifyLoggerSinkOptions>;
}

/**
 * The plugin's options. One field carries the seam — `seam` takes either a prebuilt {@link Seam}
 * (borrowed) or a {@link SeamConfig} to build one from; `isSeam()` tells the two apart at
 * runtime. The two arms exist only so `logger`, which is honoured only when the plugin builds
 * the seam, is unrepresentable when it borrows one.
 */
export type FastifyStitchPluginOptions =
    FastifyStitchPluginBorrowOptions | FastifyStitchPluginBuildOptions;

// The ambient request-scoped host. `currentStitch()` reads it; the `onRequest` hook runs each
// request inside `als.run(host, …)` so the value is the per-request principal handle.
const als = new AsyncLocalStorage<FastifyRequestSeam>();

/**
 * The ambient request-scoped {@link FastifyRequestSeam} for the in-flight request — the principal-bound
 * `seam.as(principal)` handle (or the root seam when no principal resolver is set). Returns
 * `undefined` outside a request (no ambient context), so a caller can fall back to an explicit
 * seam. Never throws on a miss — `undefined` is the whole miss contract. Backed by Node's
 * {@link AsyncLocalStorage}: a value-add a Node integration offers that the browser-first core
 * cannot.
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

const pluginImpl: FastifyPluginAsync<FastifyStitchPluginOptions> = async (
    fastify,
    options,
) => {
    // Build-or-borrow the seam, discriminated at RUNTIME by `isSeam` — the one `seam` field
    // carries either a prebuilt seam or the config to build one from. When we build it, default
    // the Pino logger bridge ON (unless `logger: false`) by injecting a
    // `fastifyLoggerSink(fastify.log)` as the seam's TraceSink.
    const source = options.seam;
    const built = !isSeam(source);
    let instance: Seam;
    if (isSeam(source)) {
        instance = source;
    } else {
        const cfg: SeamConfig = source;
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
        fastify.setErrorHandler(
            stitchErrorHandler(
                typeof options.errorHandler === 'object'
                    ? options.errorHandler
                    : {},
            ),
        );
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
 *   seam: { baseUrl: 'https://api.example.com' },
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
