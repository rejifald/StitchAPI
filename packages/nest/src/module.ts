// `StitchModule` — the DynamicModule (ADR 0006 Decisions 2-4 & 8). forRoot/forRootAsync
// configure shared infrastructure (store + trace) and a default seam; forFeature
// registers injectable stitches and, optionally, a per-upstream feature seam built over
// that shared infrastructure. `SeamRegistry` owns the shutdown lifecycle.
import {
    type NestLoggerSinkOptions,
    nestBorrowStore,
    nestLoggerSink,
} from './bridges';
import type { AnyStitchDef, NestRequestSeam } from './define-stitch';
import { STITCH_SEAM, STITCH_STORE, STITCH_TRACE } from './tokens';

import {
    type DynamicModule,
    type FactoryProvider,
    Injectable,
    type InjectionToken,
    Logger,
    Module,
    type OnApplicationShutdown,
    type Provider,
    Scope,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    type AtLeastOne,
    type Seam,
    type SeamConfig,
    type SeamOptions,
    type StitchStore,
    type TraceSink,
    memoryStore,
    seam,
} from 'stitchapi';

/** forRoot options: the shared `SeamConfig` defaults + infra, plus the Nest `logger` bridge. */
export interface StitchModuleOptions extends SeamOptions {
    /**
     * Bridge stitch events into a Nest `Logger` (via {@link nestLoggerSink}) as the seam's
     * `TraceSink`. **Default `true`** — aligned with `@stitchapi/fastify`'s plugin `logger`
     * default, so every host integration traces through its framework logger out of the box.
     * Pass sink options to customise (`{ lifecycle: false }`), or `false` to leave tracing as
     * core configures it (off). Ignored when `trace` is set — an explicit trace sink wins,
     * exactly as a `trace` on a Fastify `seamConfig` wins over its `logger` bridge.
     */
    logger?: boolean | AtLeastOne<NestLoggerSinkOptions>;
    /** Register as a global module (default `true`). */
    isGlobal?: boolean;
}

/** forRootAsync options — resolve {@link StitchModuleOptions} from an injected factory. */
export interface StitchModuleAsyncOptions {
    imports?: DynamicModule['imports'];
    inject?: FactoryProvider['inject'];
    // Matches Nest's own factory typing so any typed factory (e.g. `(c: ConfigService) => …`) fits.
    useFactory: (
        ...args: any[]
    ) => StitchModuleOptions | Promise<StitchModuleOptions>;
    isGlobal?: boolean;
}

/**
 * The feature seam's build config and its DI exposure token — two facets of one capability
 * folded into a single envelope (CONTRACT.md P24; `seamConfig`/`seamToken` shared the "seam"
 * prefix, R8). Naming the envelope `seam` while it carries a `config` member is intentional:
 * `config` is what carries the P1 clarity the original `seamConfig` rename was for, so nesting
 * it here loses nothing.
 */
export interface NestFeatureSeamOptions {
    /** The `SeamConfig` for this feature's own seam (its `baseUrl`/`auth`/…), built over the
     *  shared store + trace. Omit to attach the stitches to the root/default seam. At least one
     *  member is required — an empty `{}` is indistinguishable from omitting it (P20). */
    config?: AtLeastOne<SeamConfig>;
    /** Token to expose the feature seam under, for `.as(principal)` multi-tenant. */
    token?: InjectionToken;
}

/** forFeature options — a feature's injectable stitches and, optionally, its own upstream seam. */
export interface StitchFeatureOptions {
    // Any-input element: a feature registry is heterogeneous, so it must admit templated-path defs
    // whose call argument *requires* `params` (see `AnyStitchDef`). Per-def inference is unaffected.
    stitches: AnyStitchDef[];
    /** The feature's own seam config and/or its DI exposure token. At least one member is
     *  required — an empty `{}` is indistinguishable from omitting it (P20). */
    seam?: AtLeastOne<NestFeatureSeamOptions>;
}

/** forFeatureScoped options — {@link StitchFeatureOptions} plus a `principal` derived
 *  from the request, so each tenant gets its own session/token over the shared store. */
export interface StitchScopedFeatureOptions extends StitchFeatureOptions {
    // Derive the principal id (e.g. a tenant) from the incoming request. `any` because the
    // request type is platform-specific (express/fastify) — the caller narrows it.
    principal: (req: any) => string;
}

interface Infra {
    store: StitchStore;
    trace: TraceSink | 'console' | false;
    defaults: Omit<SeamOptions, 'store' | 'trace'>;
}

// Normalise module options into shared infra: borrow an app-provided store (else own a
// memoryStore), resolve the `logger` bridge (default ON, matching @stitchapi/fastify) —
// an explicit `trace` wins over it.
function resolveInfra(options: StitchModuleOptions): Infra {
    const { store, trace, logger } = options;
    const defaults: Record<string, unknown> = { ...options };
    delete defaults['store'];
    delete defaults['trace'];
    delete defaults['logger'];
    delete defaults['isGlobal'];
    const sinkOptions: NestLoggerSinkOptions =
        typeof logger === 'object' ? logger : {};
    return {
        store: store ? nestBorrowStore(store) : memoryStore(),
        // An explicit `trace` wins; otherwise bridge the Nest Logger unless `logger: false`
        // (the same precedence as the Fastify plugin's `seamConfig.trace` vs `logger`).
        trace:
            trace !== undefined
                ? trace
                : logger !== false
                  ? nestLoggerSink(new Logger('Stitch'), sinkOptions)
                  : false,
        defaults: defaults as Omit<SeamOptions, 'store' | 'trace'>,
    };
}

function buildSeam(infra: Infra): Seam {
    return seam({ ...infra.defaults, store: infra.store, trace: infra.trace });
}

/**
 * Tracks every seam the module creates so a single shutdown hook can flush each trace
 * and close each seam. A borrowed (app-provided) store no-ops on close; an owned
 * `memoryStore` clears. Implements the lifecycle directly (no separate provider) so the
 * package never relies on `emitDecoratorMetadata` for constructor injection.
 */
@Injectable()
export class SeamRegistry implements OnApplicationShutdown {
    private readonly seams: Seam[] = [];

    track(s: Seam): Seam {
        this.seams.push(s);
        return s;
    }

    async closeAll(): Promise<void> {
        for (const s of this.seams) await s.close();
        this.seams.length = 0;
    }

    onApplicationShutdown(): Promise<void> {
        return this.closeAll();
    }
}

@Module({})
export class StitchModule {
    static forRoot(options: StitchModuleOptions = {}): DynamicModule {
        const infra = resolveInfra(options);
        return {
            module: StitchModule,
            global: options.isGlobal ?? true,
            providers: [
                SeamRegistry,
                { provide: STITCH_STORE, useValue: infra.store },
                { provide: STITCH_TRACE, useValue: infra.trace },
                {
                    provide: STITCH_SEAM,
                    useFactory: (reg: SeamRegistry): Seam =>
                        reg.track(buildSeam(infra)),
                    inject: [SeamRegistry],
                },
            ],
            exports: [STITCH_SEAM, STITCH_STORE, STITCH_TRACE, SeamRegistry],
        };
    }

    static forRootAsync(options: StitchModuleAsyncOptions): DynamicModule {
        const RESOLVED: InjectionToken = Symbol('stitch-resolved-infra');
        return {
            module: StitchModule,
            global: options.isGlobal ?? true,
            imports: options.imports ?? [],
            providers: [
                SeamRegistry,
                {
                    provide: RESOLVED,
                    useFactory: async (...deps: any[]): Promise<Infra> =>
                        resolveInfra(await options.useFactory(...deps)),
                    inject: options.inject ?? [],
                },
                {
                    provide: STITCH_STORE,
                    useFactory: (i: Infra) => i.store,
                    inject: [RESOLVED],
                },
                {
                    provide: STITCH_TRACE,
                    useFactory: (i: Infra) => i.trace,
                    inject: [RESOLVED],
                },
                {
                    provide: STITCH_SEAM,
                    useFactory: (i: Infra, reg: SeamRegistry): Seam =>
                        reg.track(buildSeam(i)),
                    inject: [RESOLVED, SeamRegistry],
                },
            ],
            exports: [STITCH_SEAM, STITCH_STORE, STITCH_TRACE, SeamRegistry],
        };
    }

    static forFeature(
        opts: StitchFeatureOptions | AnyStitchDef[],
    ): DynamicModule {
        const norm: StitchFeatureOptions = Array.isArray(opts)
            ? { stitches: opts }
            : opts;
        const cfg = norm.seam?.config;
        // A feature seam gets its own token (or the caller's, for multi-tenant `.as()`);
        // with no feature seam, stitches bind to the root/default seam.
        const token: InjectionToken =
            norm.seam?.token ??
            (cfg ? Symbol('stitch-feature-seam') : STITCH_SEAM);
        const providers: Provider[] = [];
        const exported: InjectionToken[] = [];
        if (cfg) {
            providers.push({
                provide: token,
                useFactory: (
                    store: StitchStore,
                    trace: TraceSink | 'console' | false,
                    reg: SeamRegistry,
                ): Seam => reg.track(seam({ ...cfg, store, trace })),
                inject: [STITCH_STORE, STITCH_TRACE, SeamRegistry],
            });
            exported.push(token);
        }
        for (const d of norm.stitches) {
            providers.push({
                provide: d.token,
                useFactory: (host: NestRequestSeam) => d.build(host),
                inject: [token],
            });
            exported.push(d.token);
        }
        return { module: StitchModule, providers, exports: exported };
    }

    /**
     * Like {@link forFeature}, but **request-scoped per principal**: each request gets a
     * `seam.as(principal(req))` handle — a separate session/token over the *shared* store
     * and throttle (never a per-request store; ADR 0006 Decision 5) — and the stitches are
     * built from it. Packages the request-scoped wiring the README otherwise hand-rolls.
     *
     * Caveats inherent to request scope (not this helper): a request-scoped provider makes
     * its consumers request-scoped too (per-request instantiation cost); and `REQUEST` only
     * exists at the HTTP edge — in a BullMQ processor / `@Cron` / microservice, inject the
     * singleton seam and bind explicitly instead: `seam.as(job.data.tenantId)`.
     */
    static forFeatureScoped(opts: StitchScopedFeatureOptions): DynamicModule {
        const cfg = opts.seam?.config;
        // The singleton base seam each per-request handle derives from: a feature seam over
        // shared infra (if `seam.config` given) or the root/default seam.
        const baseToken: InjectionToken = cfg
            ? Symbol('stitch-scoped-base-seam')
            : STITCH_SEAM;
        const principalToken: InjectionToken =
            opts.seam?.token ?? Symbol('stitch-principal-seam');
        const providers: Provider[] = [];
        const exported: InjectionToken[] = [principalToken];

        if (cfg) {
            providers.push({
                provide: baseToken,
                useFactory: (
                    store: StitchStore,
                    trace: TraceSink | 'console' | false,
                    reg: SeamRegistry,
                ): Seam => reg.track(seam({ ...cfg, store, trace })),
                inject: [STITCH_STORE, STITCH_TRACE, SeamRegistry],
            });
        }

        // The per-request principal handle. `seam.as()` is lifecycle-free (it shares the
        // base seam's runtime), so it is intentionally NOT tracked in SeamRegistry.
        providers.push({
            provide: principalToken,
            scope: Scope.REQUEST,
            useFactory: (base: Seam, req: any): NestRequestSeam =>
                base.as(opts.principal(req)),
            inject: [baseToken, REQUEST],
        });

        for (const d of opts.stitches) {
            providers.push({
                provide: d.token,
                scope: Scope.REQUEST,
                useFactory: (host: NestRequestSeam) => d.build(host),
                inject: [principalToken],
            });
            exported.push(d.token);
        }
        return { module: StitchModule, providers, exports: exported };
    }
}
