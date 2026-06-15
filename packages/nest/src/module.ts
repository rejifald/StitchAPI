// `StitchModule` — the DynamicModule (ADR 0006 Decisions 2-4 & 8). forRoot/forRootAsync
// configure shared infrastructure (store + trace) and a default seam; forFeature
// registers injectable stitches and, optionally, a per-upstream feature seam built over
// that shared infrastructure. `SeamRegistry` owns the shutdown lifecycle.
import { borrowStore, loggerSink } from './bridges';
import type { StitchDef, StitchHost } from './define-stitch';
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
} from '@nestjs/common';
import {
    type Seam,
    type SeamConfig,
    type SeamOptions,
    type StitchStore,
    type TraceSink,
    memoryStore,
    seam,
} from 'stitchapi';

/** forRoot options: the shared `SeamConfig` defaults + infra, plus the `'logger'` trace sentinel. */
export interface StitchModuleOptions extends Omit<SeamOptions, 'trace'> {
    /** A `TraceSink`, `'console'`, `false`, or the `'logger'` sentinel (→ Nest Logger). Default: off. */
    trace?: SeamOptions['trace'] | 'logger';
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

/** forFeature options — a feature's injectable stitches and, optionally, its own upstream seam. */
export interface StitchFeatureOptions {
    stitches: StitchDef[];
    /** This feature's own seam (its `baseUrl`/`auth`/…), built over the shared store + trace.
     *  Omit to attach the stitches to the root/default seam. */
    seam?: SeamConfig;
    /** Token to expose the feature seam under, for `.as(principal)` multi-tenant. */
    seamToken?: InjectionToken;
}

interface Infra {
    store: StitchStore;
    trace: TraceSink | 'console' | false;
    defaults: Omit<SeamOptions, 'store' | 'trace'>;
}

// Normalise module options into shared infra: borrow an app-provided store (else own a
// memoryStore), expand the `'logger'` trace sentinel, default tracing OFF.
function resolveInfra(options: StitchModuleOptions): Infra {
    const { store, trace } = options;
    const defaults: Record<string, unknown> = { ...options };
    delete defaults['store'];
    delete defaults['trace'];
    delete defaults['isGlobal'];
    return {
        store: store ? borrowStore(store) : memoryStore(),
        trace:
            trace === 'logger'
                ? loggerSink(new Logger('Stitch'))
                : (trace ?? false),
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

    static forFeature(opts: StitchFeatureOptions | StitchDef[]): DynamicModule {
        const norm: StitchFeatureOptions = Array.isArray(opts)
            ? { stitches: opts }
            : opts;
        const cfg = norm.seam;
        // A feature seam gets its own token (or the caller's, for multi-tenant `.as()`);
        // with no feature seam, stitches bind to the root/default seam.
        const token: InjectionToken =
            norm.seamToken ??
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
                useFactory: (host: StitchHost) => d.build(host),
                inject: [token],
            });
            exported.push(d.token);
        }
        return { module: StitchModule, providers, exports: exported };
    }
}
