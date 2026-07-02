# @stitchapi/nest

[![npm](https://img.shields.io/npm/v/@stitchapi/nest?color=2563EB&label=npm)](https://www.npmjs.com/package/@stitchapi/nest)

First-class [NestJS](https://nestjs.com) integration for
[StitchAPI](https://stitchapi.dev) — design captured in
[ADR 0006](../../docs/adr/0006-nestjs-integration.md).

It is a **thin** package: `StitchModule` wires StitchAPI's `seam` into Nest's DI
graph, plus bridge helpers (a `Logger` sink, `ConfigService` secrets), an exception
filter, and an SSE bridge. It adds **no capability** — every piece sits on a core
extension point, and the `Logger` sink and `ConfigService` bridge **delegate** to core's
`loggerSink` / `secretFrom` rather than reimplement them. So `stitchapi` stays a peer
dependency and the package forks nothing (contract-not-dependency).

```sh
pnpm add @stitchapi/nest@rc stitchapi@rc
# peers you already have in a Nest app: @nestjs/common, @nestjs/core, rxjs, reflect-metadata
```

> [!IMPORTANT]
>
> Call `app.enableShutdownHooks()` in `main.ts`. Without it Nest never fires
> `OnApplicationShutdown`, so the seam's trace is not flushed and its store not closed.

## Configure the shared client — `forRoot` / `forRootAsync`

`forRoot` configures the app-wide shared infrastructure (one `store`, one `trace`
sink) and a default seam carrying your `SeamConfig` defaults (`baseUrl`, `headers`,
`auth`, `retry`, `throttle`, `cache`, …). Tracing is **off by default**; opt in with the
`'logger'` sentinel.

```ts
import { StitchModule, fromNestConfig } from '@stitchapi/nest';
import { bearer } from 'stitchapi';

@Module({
    imports: [
        StitchModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                baseUrl: config.getOrThrow('API_BASE_URL'),
                store: new RedisStore(config.getOrThrow('REDIS_URL')), // any StitchStore
                auth: bearer(fromNestConfig(config)('API_TOKEN')),
                trace: 'logger', // → nestLoggerSink(new Logger('Stitch'))
            }),
        }),
    ],
})
export class AppModule {}
```

## Injectable stitches — `forFeature` + `defineStitch`

Declare stitches with `defineStitch(build)` — the injection **token is optional** (a
unique `Symbol` is generated; pass `defineStitch(token, build)` only when you need a
stable, well-known token). Register them per feature module, which may also own its
**own upstream seam** (its `baseUrl`/`auth`), built over the shared store + trace — omit
`seam` to attach the stitches to the default seam.

```ts
// users.stitches.ts
export const GetUser = defineStitch((s) =>
    s.stitch({ name: 'getUser', path: '/users/{id}', output: UserSchema }),
);

@Module({
    imports: [
        StitchModule.forFeature({
            seam: {
                baseUrl: 'https://api.example.com',
                auth: bearer(env('TOKEN')),
            },
            stitches: [GetUser],
        }),
    ],
})
export class UsersModule {}

@Injectable()
export class UsersService {
    // Injected<typeof GetUser> keeps the type linked to the definition.
    constructor(
        @InjectStitch(GetUser)
        private readonly getUser: Injected<typeof GetUser>,
    ) {}
    find(id: string) {
        return this.getUser({ params: { id } }); // PromiseLike<User>; .stream() for events
    }
}
```

## Multi-tenant — `forFeatureScoped` (principal in request scope)

Multi-tenancy is **principal-scoped over the shared store** (separate sessions/tokens
per tenant, one connection pool) — never a per-request store. `forFeatureScoped` wires
the request-scoped `seam.as(principal)` handle and the request-scoped stitches for you:

```ts
@Module({
    imports: [
        StitchModule.forFeatureScoped({
            seam: {
                baseUrl: 'https://api.example.com',
                auth: bearer(env('TOKEN')),
            },
            stitches: [GetUser],
            principal: (req) => req.user?.tenantId ?? 'anonymous',
        }),
    ],
})
export class UsersModule {}
```

Each request resolves `GetUser` from `seam.as(tenantId)`. Note a request-scoped provider
makes its consumers request-scoped too (a per-request instantiation cost).

Outside HTTP (BullMQ, `@Cron`, microservices) there is no `REQUEST`: inject the singleton
seam and bind explicitly — `seam.as(job.data.tenantId)`.

## Bridges

-   **`nestLoggerSink(logger?, { lifecycle? })`** — a `TraceSink` that forwards the event
    stream to a Nest `Logger`, by level: `error` → `error`; `drift` → `error`/`warn`/`debug`
    by the finding's level; a `retry`/`circuit` `progress` → `warn`; `start`/`result`/`done`
    → `debug`/`verbose` (the happy path, hidden at Nest's default level — `lifecycle: false`
    drops them). It logs **only metadata** and strips the URL query, so it is safe on a
    secret-bearing seam: a custom sink receives **un-redacted** events, so never log
    `event.input`/headers or a `delta` chunk raw.
-   **`fromNestConfig(config)(key)`** — a `ConfigService`-backed secret thunk (core's `env()`
    twin). Synchronous, so it cannot fetch a rotating secret per call — use
    `oauth2`/`cookieSession` for that.
-   **`nestBorrowStore(store)`** — wraps an app-owned `StitchStore` so the seam never
    `close()`s it (the app owns disposal). `NestConfigServiceLike` is the structural type
    `fromNestConfig` accepts.

> [!NOTE]
>
> `nestLoggerSink` / `fromNestConfig` / `nestBorrowStore` / `NestConfigServiceLike` are
> the ecosystem-qualified names introduced by
> [ADR 0012](../../docs/adr/0012-integration-symbol-naming.md). The former bare names
> (`loggerSink`, `fromConfig`, `borrowStore`, `ConfigServiceLike`) remain as
> `@deprecated` aliases through the `1.0.0-rc` line and are removed at the 1.0 GA cut.

## Errors → HTTP — `StitchExceptionFilter`

A failed stitch throws a `StitchError` (a branded `Error` carrying the upstream `status`).
Register `StitchExceptionFilter` globally to turn it into an `HttpException` — **`502 Bad
Gateway` by default** (every upstream failure is a gateway error; it never leaks an
upstream's `401`/`404` to your client), so controllers calling stitches need no try/catch:

```ts
// main.ts — needs the HTTP adapter, like any BaseExceptionFilter subclass:
app.useGlobalFilters(new StitchExceptionFilter(app.getHttpAdapter()));
// configure the status (e.g. propagate the upstream status instead of 502):
//   new StitchExceptionFilter(app.getHttpAdapter(), { status: (e) => e.status ?? 502 })
// …or as a provider: { provide: APP_FILTER, useClass: StitchExceptionFilter }
```

`status` takes a fixed number or a `(err) => number` function. Outside a filter, use
`toHttpException(err, { status })` / `isStitchError(err)` directly.

The client-facing **message** is a fixed `'Upstream request failed'` by default — the raw
`err.message` is withheld, because it can disclose an internal hostname (a transport
failure reads like `getaddrinfo ENOTFOUND payments.internal.corp`) or the upstream's status
(`HTTP 401`). The original error is always attached as the exception's `cause` for
server-side logging. Opt in to a message when you need one: `{ exposeMessage: true }` for
the raw message, or `{ message: 'Payment provider unavailable' }` / `{ message: (e) => … }`
for a curated one.

## Streaming → SSE — `stitchSse`

Return a stitch's `stream()` from a Nest `@Sse()` endpoint: `delta` chunks become messages,
an `error` event errors the stream (a fixed, safe message by default — see below), and a
client disconnect aborts the upstream generator.

```ts
@Sse('chat')
chat(@Query('q') q: string) {
    return stitchSse(this.complete.stream({ body: { prompt: q } }), {
        data: (c: any) => c.text, // map a delta chunk → message data
    });
}
```

Nest renders an errored `@Sse()` observable's message to the client as the final `event: error`
frame, so the client-facing **message** defaults to a fixed `'Upstream request failed'` — the raw
`event.message` is withheld, since it can disclose an internal hostname (a transport failure reads
like `getaddrinfo ENOTFOUND payments.internal.corp`) or the upstream's status (`HTTP 401`). The
original error is always attached as the errored observable's `cause` for server-side logging. Opt
in when you need a message: `{ exposeMessage: true }` for the raw message, or
`{ message: 'Stream unavailable' }` / `{ message: (e) => … }` for a curated one.

## Testing

Swap the transport globally with the seam's `adapter`, or override a stitch provider:

```ts
StitchModule.forRoot({ adapter: mockAdapter }); // every stitch hits the mock
// or: Test.createTestingModule(...).overrideProvider(GetUser.token).useValue(fakeStitch)
```

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
