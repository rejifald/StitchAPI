# ADR 0006 — NestJS integration (`@stitchapi/nest`)

- **Status:** Accepted (Q1–Q2 resolved 2026-06-15; `@stitchapi/nest` implemented in PR [#103](https://github.com/rejifald/StitchAPI/pull/103) — see _Resolved questions_). Net-new: not in [`GAP-AUDIT.md`](../GAP-AUDIT.md). Builds only on existing core extension points.
- **Date:** 2026-06-15
- **Tags:** integration, nestjs, adapter, packaging, dependency-injection, multi-tenant, peer-dependency, contract-not-dependency

> [!NOTE]
>
> The integration is a thin **adapter package**, exactly the class [ADR 0001](./0001-package-naming-and-distribution.md) Decision 2 already anticipated ("framework adapters (e.g. React)… `@stitchapi/<name>`"). It contributes _DI wiring + two bridge helpers + a Logger sink_ over primitives core already exposes — no new capability, so it cannot regress the **contract-not-dependency** gate ([`two-gates`](../DESIGN.md)).

> **Amendment — the store contract's counter verb is `increment`.** The `StitchStore` shape quoted below as `get`/`set`/`incr`/`close?` (and the `nestBorrowStore` sample that delegates it) now spells the atomic counter **`increment`**, per [CONTRACT.md P18](../CONTRACT.md#p18--adapter-mirrors-keep-upstream-spelling-house-contracts-use-house-vocabulary). Read `incr` as `increment` throughout; the bridge's behaviour (delegate `get`/`set`/`increment`, never `close`) is unchanged.

## Context

A stitch is a plain function: `stitch(config)` returns a callable that runs an HTTP/GraphQL/streaming call ([`stitch.ts`](../../packages/core/src/stitch.ts)). That works in any runtime, but it is **unwired** in a NestJS backend — there is no module to import, no provider to inject, no lifecycle hook, and no idiomatic path from Nest's `ConfigService`/`Logger`/request scope into a stitch. Today a Nest user hand-rolls all of that, and gets three things subtly wrong:

1.  **Core identity.** [ADR 0001](./0001-package-naming-and-distribution.md) Decision 4 makes `stitchapi` a **mandatory `peerDependency`** for any plugin host: two physical copies of core split the cache/throttle registries and break seam identity. A hand-rolled integration can silently double-install.
2.  **Lifecycle.** A long-lived server must `flush()` the trace sink and `close()` the store/vault on shutdown ([`seam.ts:165`](../../packages/core/src/seam.ts)). This is easy to forget.
3.  **The principal boundary.** Multi-tenant auth rides `seam.as(req.user.tenantId)` ([ADR 0002](./0002-seam-primitive-and-principal-scoped-auth.md) §2) — the closure that makes impersonation impossible. Wiring it to Nest's request scope by hand is the fiddliest and highest-stakes part.

The decisive enabling fact: **every bridge already exists in the core contract**, so the integration is pure wiring.

| Nest need                 | Existing core extension point                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared client + defaults  | `seam(SeamOptions)` — one store + vault + trace + throttle + principal boundary + lifecycle ([`seam.ts:188`](../../packages/core/src/seam.ts)) |
| Pluggable `store`         | `StitchStore` (`get`/`set`/`incr`/`close?`) ([`types.ts:508`](../../packages/core/src/types.ts))                                               |
| `trace` → Nest `Logger`   | `TraceSink { handle(ev, {name}); flush?() }` ([`types.ts:500`](../../packages/core/src/types.ts))                                              |
| secrets → `ConfigService` | `Secret = string \| (() => string)`, resolved at call time ([`auth.ts:15`](../../packages/core/src/auth.ts))                                   |
| multi-tenant              | `seam.as(principal)` → `PrincipalSeam` ([`types.ts:555`](../../packages/core/src/types.ts))                                                    |
| test transport            | `SeamConfig.adapter` (the seam's `adapter` slot is not omitted — [`types.ts:529`](../../packages/core/src/types.ts))                           |
| shutdown                  | `seam.close()` (flush trace, close store/vault) ([`seam.ts:169`](../../packages/core/src/seam.ts))                                             |

There is precedent for "host integration as a thin, framework-free adapter over the registry/stream" in core itself: [`serve.ts`](../../packages/core/src/serve.ts) (the HTTP front door) reuses `stitch.stream()` with no new dependency. `@stitchapi/nest` is the same philosophy, expressed in Nest's DI vocabulary.

## Decision

1.  **Ship `@stitchapi/nest` (a package), not a recipe-only doc.** Recipe-only would be ~10 lines of provider factory, but it leaves the three correctness items above to the user. The package owns them once. It is a first-party scoped package per [ADR 0001](./0001-package-naming-and-distribution.md) Decisions 2 & 4, mirroring the [`@stitchapi/fingerprint-*`](../../packages/fingerprint-zod/package.json) shape: `peerDependencies` on `stitchapi >=0.7.0` plus `@nestjs/common` and `@nestjs/config`; zero runtime deps of its own; dual CJS/ESM via `tsup`. **The README publishes the recipe as "what the module does under the hood"** — the package _is_ the recipe, frozen and verified. Keep it tiny (~150 LOC): a `DynamicModule`, a stitch-provider helper, two bridge helpers, the Logger sink, and a seam registry for lifecycle.

2.  **Separate app-global _infrastructure_ from per-upstream _surface_.** A real backend integrates several upstreams (Stripe + GitHub + an internal service), each with its own `baseUrl`/`auth`/`throttle`/`retry` — but it wants **one** Redis and **one** Logger. So:

    - **`forRoot({ store?, trace?, ...defaultSeam? })`** configures shared infrastructure once and exposes it as injectable tokens — `STITCH_STORE` (borrowed if you pass one, else an owned `memoryStore()`) and `STITCH_TRACE` — plus (for the single-upstream common case) an optional **default seam** (`STITCH_SEAM`) carrying app-wide `SeamConfig` defaults.
    - **Each additional upstream is its own seam**, created by a feature module via `forFeature({ stitches, seam })` (Decision 4, **Q1**), which builds the seam from the shared `STITCH_STORE`/`STITCH_TRACE` but layers its own surface config. "Which seam does a stitch belong to?" is answered by **which module registered it** — the natural Nest grain (one feature module ≈ one bounded context ≈ one upstream).
    - A small **`SeamRegistry`** singleton (provided by `forRoot`) collects every seam created in the app so a single lifecycle guardian can flush their traces and close package-created stores (Decision 8).

3.  **`forRoot` / `forRootAsync` provide the seam(s).** The seam is exposed under a symbol token (`STITCH_SEAM` for the default seam); `forRootAsync` is the path that lets `ConfigService` reach the store, secrets, and `baseUrl`.

    ```ts
    export const STITCH_SEAM = Symbol('STITCH_SEAM'); // the default seam
    export const STITCH_STORE = Symbol('STITCH_STORE'); // shared store (borrowed if app-provided)
    export const STITCH_TRACE = Symbol('STITCH_TRACE'); // shared trace sink (false when off)

    export interface StitchModuleOptions extends Omit<SeamOptions, 'trace'> {
        trace?: SeamOptions['trace'] | 'logger'; // 'logger' → loggerSink(new Logger('Stitch'))
        isGlobal?: boolean; // default true — like ConfigModule.forRoot({ isGlobal })
    }

    @Module({})
    export class StitchModule {
        static forRoot(options: StitchModuleOptions = {}): DynamicModule {
            const { isGlobal, store, trace, ...defaults } = options;
            const sharedStore = store ? borrowStore(store) : memoryStore(); // app owns a store it passes
            const sharedTrace =
                trace === 'logger' ? loggerSink(new Logger('Stitch')) : trace; // off (Q2)
            return {
                module: StitchModule,
                global: isGlobal ?? true,
                providers: [
                    SeamRegistry,
                    { provide: STITCH_STORE, useValue: sharedStore },
                    { provide: STITCH_TRACE, useValue: sharedTrace ?? false },
                    {
                        provide: STITCH_SEAM,
                        useFactory: (reg: SeamRegistry): Seam =>
                            reg.track(
                                seam({
                                    ...defaults,
                                    store: sharedStore,
                                    ...(sharedTrace
                                        ? { trace: sharedTrace }
                                        : {}),
                                }),
                            ),
                        inject: [SeamRegistry],
                    },
                    StitchLifecycle,
                ],
                exports: [
                    STITCH_SEAM,
                    STITCH_STORE,
                    STITCH_TRACE,
                    SeamRegistry,
                ],
            };
        }

        // forRootAsync mirrors forRoot but resolves StitchModuleOptions from an async factory (so
        // ConfigService et al. are injectable), then applies the same borrow + 'logger' normalization
        // before providing STITCH_STORE / STITCH_TRACE / STITCH_SEAM.
        static forRootAsync(options: StitchModuleAsyncOptions): DynamicModule {
            /* … */
        }
    }
    ```

    Usage with `ConfigService` (the secrets + store bridge, Decisions 6–7):

    ```ts
    StitchModule.forRootAsync({
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
            baseUrl: config.getOrThrow('API_BASE_URL'),
            store: new RedisStore(config.getOrThrow('REDIS_URL')), // any StitchStore
            auth: bearer(fromConfig(config)('API_TOKEN')),
            retry: { attempts: 3 },
            trace: 'logger', // sentinel → loggerSink(new Logger('Stitch')) (Q2)
        }),
    });
    ```

4.  **`forFeature` registers injectable stitches via `defineStitch`.** A stitch definition builds against the **common subset of `Seam` and `PrincipalSeam`** (`Pick<Seam, 'stitch' | 'graphql'>`, which both satisfy), so the _same_ definition resolves against the app-wide singleton **or** a request-scoped tenant handle — only the provider's `inject` differs (Decision 5).

    ```ts
    export type StitchHost = Pick<Seam, 'stitch' | 'graphql'>; // Seam AND PrincipalSeam both satisfy this

    export interface StitchDef<T = unknown, In = StitchInput> {
        token: InjectionToken;
        build: (host: StitchHost) => Stitch<T, In>;
    }
    export function defineStitch<T, In>(
        token: InjectionToken,
        build: (host: StitchHost) => Stitch<T, In>,
    ): StitchDef<T, In> {
        return { token, build };
    }

    export interface StitchFeatureOptions {
        stitches: StitchDef[];
        // This feature's own upstream seam (its baseUrl/auth/throttle), built over the shared
        // STITCH_STORE + STITCH_TRACE. Omit to attach the stitches to the root/default seam.
        seam?: SeamConfig;
        // Token to expose the feature seam under, for `.as(principal)` multi-tenant (Decision 5).
        seamToken?: InjectionToken;
    }

    // A feature module owns its stitches and, optionally, its own upstream seam (Q1). A bare
    // StitchDef[] is shorthand for { stitches } on the root/default seam.
    static forFeature(opts: StitchFeatureOptions | StitchDef[]): DynamicModule {
        const { stitches, seam: cfg, seamToken } = Array.isArray(opts) ? { stitches: opts } : opts;
        const token = seamToken ?? STITCH_SEAM;
        const providers: Provider[] = [];
        if (cfg) {
            providers.push({
                provide: token,
                useFactory: (store: StitchStore, trace: TraceSink | false, reg: SeamRegistry): Seam =>
                    reg.track(seam({ ...cfg, store, ...(trace ? { trace } : {}) })),
                inject: [STITCH_STORE, STITCH_TRACE, SeamRegistry],
            });
        }
        providers.push(
            ...stitches.map((d) => ({ provide: d.token, useFactory: (s: Seam) => d.build(s), inject: [token] })),
        );
        return { module: StitchModule, providers, exports: providers.map((p) => p.provide) };
    }
    ```

    Authoring and injection:

    ```ts
    // users.stitches.ts
    export const GetUser = defineStitch('GET_USER', (s) =>
        s.stitch({ name: 'getUser', path: '/users/{id}', output: UserSchema }),
    );

    @Module({ imports: [StitchModule.forFeature({ stitches: [GetUser] })] }) // bare [GetUser] also works
    export class UsersModule {}

    @Injectable()
    export class UsersService {
        constructor(
            @InjectStitch(GetUser)
            private readonly getUser: Injected<typeof GetUser>,
        ) {}
        find(id: string) {
            return this.getUser({ params: { id } }); // PromiseLike<User>; .stream() for events
        }
    }
    ```

    A feature module with its **own upstream** (its `baseUrl`/`auth`, sharing the app's store + trace via `STITCH_STORE`/`STITCH_TRACE`):

    ```ts
    @Module({
        imports: [
            StitchModule.forFeature({
                seam: {
                    baseUrl: 'https://api.stripe.com',
                    auth: bearer(env('STRIPE_KEY')),
                },
                stitches: [CreateCharge, GetCustomer],
            }),
        ],
    })
    export class StripeModule {} // a ConfigService-backed seam uses the async factory variant, as in forRootAsync
    ```

    On **types — the honest story.** A param decorator cannot _synthesize_ the parameter's type; `@InjectStitch(GetUser)` is `@Inject(GetUser.token)` and the developer still annotates the field. To keep that annotation linked to the definition (no hand-retyped `Stitch<User>`), the package exports `Injected<D>`:

    ```ts
    export type Injected<D> =
        D extends StitchDef<infer T, infer In> ? Stitch<T, In> : never;
    // → `@InjectStitch(GetUser) getUser: Injected<typeof GetUser>` tracks GetUser's inferred type.
    ```

    Building stitches eagerly at DI resolution is cheap: `makeStitch` does no I/O — it composes config and attaches a (lazy) cache surface ([`stitch.ts:312`](../../packages/core/src/stitch.ts)).

5.  **Multi-tenancy is principal-scoped over a _shared_ store, never a per-request store.** `seam.as(tenantId)` keys sessions/tokens/cache by principal in the shared vault ([`auth.ts:256`](../../packages/core/src/auth.ts)), so one OAuth token and one connection pool serve all tenants while cross-tenant bleed is impossible. Swapping the store per request would throw that away and is **rejected**. At the HTTP edge, bind the principal in `REQUEST` scope:

    ```ts
    export const TENANT_SEAM = Symbol('TENANT_SEAM');

    {
        provide: TENANT_SEAM,
        scope: Scope.REQUEST,
        useFactory: (root: Seam, req: { user?: { tenantId?: string } }) =>
            root.as(req.user?.tenantId ?? 'anonymous'), // PrincipalSeam — lifecycle-free by design
        inject: [STITCH_SEAM, REQUEST],
    }
    // request-scoped stitches reuse the SAME StitchDef, built from the tenant handle:
    { provide: GetUser.token, scope: Scope.REQUEST, useFactory: (h: StitchHost) => GetUser.build(h), inject: [TENANT_SEAM] }
    ```

    Two caveats, both documented:

    - **Scope bubbling.** A request-scoped provider makes its consumers request-scoped too — a real per-request instantiation cost. Teams that want singleton services can instead keep everything singleton and bind at the edge: `this.api.as(req.user.tenantId).stitch(...)`. The package offers both; the request-scoped wiring is the default convenience.
    - **Non-HTTP contexts.** `REQUEST` does not exist in BullMQ processors, `@Cron` jobs, or microservice consumers. There, the principal is **bound explicitly** from job/message metadata: inject the singleton seam and call `seam.as(job.data.tenantId)`. `seam.as` is the primitive; request scope is only an HTTP-edge convenience over it.

6.  **`trace` → Nest `Logger` via `loggerSink()`.** A `TraceSink` whose `handle` forwards the event stream to a framework `Logger`:

    ```ts
    import { Logger } from '@nestjs/common';
    import type { StitchEvent, TraceSink } from 'stitchapi';

    export function loggerSink(logger = new Logger('Stitch')): TraceSink {
        return {
            handle(ev: StitchEvent, { name }) {
                switch (ev.type) {
                    case 'start':
                        return logger.log(
                            `→ ${name} ${ev.method} ${redactUrl(ev.url)}`,
                        );
                    case 'result':
                        return logger.log(
                            `← ${name} ${ev.status} (${ev.attempts} attempt(s))`,
                        );
                    case 'error':
                        return logger.error(
                            `✗ ${name} ${ev.message}${ev.status ? ` ${ev.status}` : ''}`,
                        );
                    case 'drift':
                        return logger.warn(
                            `drift ${name} ${ev.finding.path} ${ev.finding.change}`,
                        );
                    case 'progress':
                        return logger.debug?.(
                            `· ${name} ${ev.phase}#${ev.attempt}`,
                        );
                    // 'delta'/'done' → debug or drop
                }
            },
            flush() {}, // Logger writes synchronously
        };
    }
    ```

    > [!WARNING]
    >
    > **Redaction is the custom sink's responsibility.** Core's built-in JSONL/console sink redacts secret headers _inside_ `createTrace` ([`trace.ts:26`](../../packages/core/src/trace.ts)); a custom `TraceSink` receives the **raw** event, so `ev.input.headers` on a `start` event still contains `authorization`/`cookie`, and `ev.url` may carry a secret query string. `loggerSink` therefore logs only `name`/`method`/`url`/`status` (never `JSON.stringify(ev)`) and ships a `redactUrl()` that strips the query string. This is the one place a naive Nest recipe leaks credentials — another reason the package owns it.

7.  **secrets → `ConfigService` via `fromConfig()`.** Because `Secret = string | (() => string)` is already a call-time thunk and `env(name)` ([`auth.ts:19`](../../packages/core/src/auth.ts)) is exactly this shape, the bridge is a one-liner — `fromConfig` is `env`'s `ConfigService` twin:

    ```ts
    export const fromConfig =
        (config: ConfigService) =>
        (key: string): (() => string) =>
        () =>
            config.getOrThrow<string>(key); // resolved per call; never lands on __config or in traces
    // usage: auth: bearer(fromConfig(config)('API_TOKEN'))
    ```

    > [!IMPORTANT]
    >
    > **Secrets resolve _synchronously_.** `resolve(s)` calls `s()` expecting a `string`, not a `Promise` ([`auth.ts:16`](../../packages/core/src/auth.ts)). `fromConfig` is sound because `ConfigService` loads config asynchronously at bootstrap and then serves it synchronously. **Per-call async secret fetch** (e.g. pulling a rotating short-lived credential from Vault on every request) is _not_ expressible through `Secret`. The supported async-credential path is `oauth2` / `cookieSession`, which refresh **asynchronously** through the vault/store on a `401` wall ([`auth.ts:135`](../../packages/core/src/auth.ts)). This is a core constraint, not a Nest one; calling it out here corrects an earlier overstatement that "Vault/SSM async work unchanged."

8.  **Lifecycle: `StitchLifecycle` + the app owns the shared store.** A guardian provider closes every tracked seam on shutdown:

    ```ts
    @Injectable()
    class StitchLifecycle implements OnApplicationShutdown {
        constructor(private readonly registry: SeamRegistry) {}
        async onApplicationShutdown() {
            await this.registry.closeAll(); // flush each trace, then close the (single) real store once
        }
    }
    ```

    Two correctness points:

    - **`seam.close()` always closes its store** ([`seam.ts:171`](../../packages/core/src/seam.ts)). With many seams sharing one store, that would close it N times (the second close disconnects a pool the others still need). So the package wraps any **app-provided** store in a **borrowed view** (below) before handing it to each seam: a seam never tears down a store it did not create, and an app-provided store stays the **app's** to dispose. `SeamRegistry.closeAll()` flushes every seam's trace and closes only the stores the package itself created.

        ```ts
        // `close` intentionally omitted → a seam's `store.close?.()` becomes a no-op.
        function borrowStore(store: StitchStore): StitchStore {
            return {
                get: (k) => store.get(k),
                set: (k, v, t) => store.set(k, v, t),
                incr: (k, t) => store.incr(k, t),
            };
        }
        ```

        When `forRoot` is given no `store`, the package creates and **owns** one `memoryStore()` (shared via `STITCH_STORE`), and `closeAll()` closes it — the simple case stays simple. Borrowing applies only to a store the app passed in.

    - **`enableShutdownHooks()` is required.** Nest does not invoke `OnApplicationShutdown` unless the app calls `app.enableShutdownHooks()`. Without it, `seam.close()` never runs (trace unflushed, store unclosed). A library cannot force this; the README's first setup step states it prominently.

9.  **Testing: swap the transport, or override the provider.** Two clean paths, both first-class:

    - **Globally** — `forRoot({ adapter: mockAdapter })` (or a `forRootAsync` test factory) routes every stitch through a mock transport; the seam's `adapter` slot is part of `SeamConfig` for exactly this.
    - **Per stitch** — `Test.createTestingModule(...).overrideProvider(GetUser.token).useValue(fakeStitch)`.

    Pair with `stitchapi/testing` (the conformance kit) for adapter-level assertions.

10. **Non-goals for this version (anticipated, not built).** Kept out to stay thin; each is a clean follow-up:

    - **Exception mapping** — a `StitchExceptionFilter` mapping `StitchError.status` ([`stitch.ts:209`](../../packages/core/src/stitch.ts)) → Nest `HttpException`. Opt-in; today the app writes its own filter.
    - **SSE controller bridge** — `stitch.stream()` is an `AsyncGenerator`; Nest's `@Sse()` wants an RxJS `Observable`. A `from()` interop is ~3 lines but pulls `rxjs` (an optional peer); documented as a snippet for now.
    - **Terminus health indicator** — a `StitchHealthIndicator` that pings a stitch.
    - **Nest GraphQL (server) disambiguation** — StitchAPI's `graphql()` is a _client_ surface (calling an upstream GraphQL API); it does not interact with `@nestjs/graphql` (a server). A one-paragraph README note prevents the confusion.

## Resolved questions

Both resolved 2026-06-15 (the recommended option chosen for each); folded into the Decisions above.

- **Q1 — Feature-seam ergonomics → `forFeature({ stitches, seam? })` (Decision 4).** The feature module owns one seam, the most idiomatic Nest grain; lifecycle stays in `SeamRegistry`. The feature seam is built over the shared `STITCH_STORE`/`STITCH_TRACE` tokens `forRoot` exposes (Decision 3). A bare `StitchDef[]` is shorthand for `{ stitches }` on the default seam. Rejected: a dedicated `forSeam(token, opts)` (a non-standard fourth static) and a `forRoot({ seams })` map (couples every upstream to root config, scales poorly).

- **Q2 — `trace` default → OFF (Decisions 3 & 6).** Honors **"no side effects by default"** ([`no-side-effects-default`](../OVERVIEW.md)): a stitch's only effect is its call. The friendly opt-in is the string sentinel **`trace: 'logger'`**, which `forRoot`/`forRootAsync` expand to `loggerSink(new Logger('Stitch'))` — one word, no import. Any `TraceSink` / `'console'` / `false` still passes straight through to core. (My first sketch defaulted it on; this corrected it.)

## Consequences

**Positive**

- **No core change.** Every bridge rides an existing extension point; core stays at its current surface, and the contract-not-dependency gate is green by construction (the package adds no capability, declares `stitchapi` as a peer).
- **One mental model:** the root/feature seam is a provider; a stitch is a provider built from it; a tenant is `seam.as()` in request scope. Nothing new to learn beyond core + Nest DI.
- **Correctness the recipe can't guarantee:** single core instance (peer dep), lifecycle (`SeamRegistry.closeAll`), the principal boundary, and credential-safe logging are owned once.
- **Idiomatic Nest:** `forRoot`/`forRootAsync`/`forFeature`, `ConfigService` and `Logger` bridges, request-scoped multi-tenant, and a clean testing override story.

**Accepted trade-offs**

- **Request-scoped multi-tenant bubbles scope** to consumers (per-request instantiation). Mitigated by offering the singleton + edge-binding alternative.
- **Synchronous secrets** (Decision 7): per-call async secret fetch is unsupported; rotating credentials go through `oauth2`/`cookieSession`.
- **In-process concurrency is per-instance.** Horizontally scaled (multi-pod) deployments share _rate_ limits only through a shared store; concurrency caps stay per-pod ([`store.ts:96`](../../packages/core/src/store.ts)). Documented, not solved here (a distributed semaphore is out of scope, same as core).

**Required follow-ups**

- Resolve Q1 + Q2, then scaffold `packages/nest` (package.json mirroring `fingerprint-*`; `DynamicModule`, `defineStitch`/`forFeature`, `loggerSink`, `fromConfig`, `borrowStore`, `SeamRegistry`, `StitchLifecycle`).
- Confirm npm scope ownership before publishing the first `@stitchapi/*` package ([ADR 0001](./0001-package-naming-and-distribution.md) follow-up — still open).
- A docs guide under `apps/docs` (the recipe + the bridges), and an end-to-end vitest against a real Nest test module + the mock server.

## Alternatives considered

- **A. Recipe-only, no package.** A documented `useFactory: () => seam({...})` provider. Cheapest, and stays valid as the package's own internals doc. Rejected as the _primary_ answer because it cannot enforce the three correctness items (peer-dep single instance, lifecycle, credential-safe logging) and re-litigates the principal wiring in every app. **Kept as the package README's "under the hood."**
- **B. Single global seam only** (the brief's literal `forRoot({ store, trace, preset })`). Simplest, but a real backend integrates multiple upstreams with different `baseUrl`/`auth`; one seam cannot model that. Rejected in favour of the infra-vs-surface split (Decision 2), which keeps the single-upstream case a one-liner (the default seam) while supporting many.
- **C. Per-stitch, no seam** (plain `stitch()` + a shared config fragment via `extends`). Avoids the seam abstraction, but each stitch then builds its _own_ store/throttle/trace runtime — losing the shared throttle bucket, the shared vault, the principal boundary, and a single lifecycle. The seam exists precisely for a long-lived shared surface; a server is the canonical case. Rejected.
- **D. Fold Nest support into core** (a `stitchapi/nest` subpath). Violates [ADR 0001](./0001-package-naming-and-distribution.md) Decisions 4 & 6 (a framework peer dep does not belong in lean core; subpaths are for dependency-free in-package code) and would put `@nestjs/*` in core's dependency graph. Rejected.

## Addendum (2026-06-16) — boilerplate-reduction follow-ups delivered

Layered on the original decisions to cut per-consumer boilerplate. All additive, **no core change**:

- **`defineStitch` token is now optional** — `defineStitch(build)` generates a unique `Symbol`; the `(token, build)` form still works. You reference the def object everywhere anyway (`forFeature({ stitches: [GetUser] })`, `@InjectStitch(GetUser)`, `overrideProvider(GetUser.token)`), so the hand-picked token was ceremony.
- **`loggerSink` mapping refined** — lifecycle events (`start`/`result`/`done`) moved off the happy-path info level to `debug`/`verbose` (opt out with `{ lifecycle: false }`), `drift` routed by `finding.level`, and `retry`/`circuit` progress surfaced at `warn`. Still payload-free (metadata only), so it stays safe on a secret-bearing seam.
- **Exception mapping delivered** (was Decision 10 non-goal) — `StitchExceptionFilter` plus `toHttpException()` / `isStitchError()` map a `StitchError` to an `HttpException`. Status is **`502 Bad Gateway` by default** (never leaks an upstream's status to the client); configurable via `status: number | (err) => number` (propagate, fix, or remap).
- **SSE bridge delivered** (was Decision 10 non-goal) — `stitchSse()` adapts `stitch.stream()` to an `Observable<MessageEvent>` for `@Sse()`. Adds `rxjs` as a peer (always present in a Nest app).
- **Multi-tenant wiring packaged** — `StitchModule.forFeatureScoped({ stitches, principal })` replaces the hand-rolled request-scoped `TENANT_SEAM` recipe (Decision 5). Adds `@nestjs/core` as a peer (for `REQUEST`; always present in a Nest app).

Peer-dependency policy unchanged in spirit: peer-depend on what a Nest app **always** has (`@nestjs/common`, now `@nestjs/core` + `rxjs`); keep **optional** deps structural (`@nestjs/config` → `ConfigServiceLike`). Still non-goals: the Terminus health indicator and the Nest-GraphQL disambiguation note.

## Addendum (2026-06-16) — bridges delegate to core's `secretFrom` / `loggerSink` (the one sanctioned core change)

Core has since grown two generic primitives that the original ADRs hand-rolled inside this package: `secretFrom(source, name)` — a `SecretSource`-backed secret thunk ([`auth.ts`](../../packages/core/src/auth.ts)) — and a logger-agnostic `loggerSink(logger, opts)` ([`trace.ts`](../../packages/core/src/trace.ts)). The two bridge helpers now **delegate** to them instead of reimplementing the logic, killing the duplication:

- **`fromConfig` → `secretFrom`.** `fromConfig(config)(key)` is now `secretFrom((name) => String(config.getOrThrow(name)), key)`. A missing key still throws (`ConfigService.getOrThrow`'s own error propagates); empty values are now rejected too — matching `env()` / `secretFrom()`, so a blank credential never silently rides along. That empty-string rejection is the **one** behavior the delegation tightens (previously a present-but-empty config value returned `''`); it is strictly safer and untested before. Public type (`ConfigServiceLike`) and signature unchanged.
- **`loggerSink` → core `loggerSink`.** Nest's sink is _richer_ than core's twin — Nest's `Logger` has `verbose` (core's `LoggerLike` has only `info`/`debug`), it has a `{ lifecycle }` toggle, it routes `retry`/`circuit` progress to `warn` (a per-_instance_ rule core's per-_type_ `levels` map can't express), it pins info-`drift` to `debug`, and its one-liners carry glyphs + attempt counts. To let it delegate **without changing a single logged byte**, core's `loggerSink` gained two **generic** optional hooks (no NestJS concept leaks in):

    - `level?: (event, ctx) => LogLevel | null` — resolve the level per event instance (`null` drops it, `undefined` defers); a strict superset of `levels`.
    - `format?: (event, ctx) => string | null` — supply the metadata-only line (the host then owns the payload-free guarantee; the default formatter stays payload-free for everyone else).

    Nest passes a verbose-routing `LoggerLike` adapter (core `info` → Nest `verbose`), its level rules, and its glyph formatter. Levels, messages, and the payload-free / never-log-`delta` guarantees stay byte-identical to the hand-rolled switch this replaced.

This is the **deliberate exception** to the original "no core change" / "this ADR modifies no core code" stance (Context line, Decision _No core change_, and the boilerplate addendum above): the core additions are generic, additive, off-by-default, and covered by core tests, so the **contract-not-dependency** gate stays green — `@stitchapi/nest` still adds no capability, forks nothing, and peer-depends on `stitchapi`. The trade taken: a small, generic widening of core's `loggerSink` surface in exchange for deleting the duplicated dispatch / formatting / secret-resolution logic from the bridge package.

## Addendum (2026-06-20) — bridge exports renamed to ecosystem-qualified names

[ADR 0012](./0012-integration-symbol-naming.md) makes integration-package adapter symbols ecosystem-qualified, so **all four** of this package's generically-named bridge exports are renamed:

- **`loggerSink` → `nestLoggerSink`** and **`LoggerLike` → `NestLoggerLike`** — these collided with core's _generic_ `loggerSink` / `LoggerLike` outright (`bridges.ts` already had to import core's as `coreLoggerSink` / `CoreLoggerLike` to disambiguate).
- **`fromConfig` → `fromNestConfig`**, **`borrowStore` → `nestBorrowStore`**, **`ConfigServiceLike` → `NestConfigServiceLike`** — no collision _yet_, but the bare names would clash the moment another adapter ships a config-secret bridge or a store wrapper, so they are qualified proactively (ADR 0012 rule 6). `NestLoggerSinkOptions` was already on-pattern and is unchanged.

The old names all remain as `@deprecated` aliases through the `1.0.0-rc` line and are removed at the 1.0 GA cut. The delegation described above is unchanged; only the public symbol names move.
