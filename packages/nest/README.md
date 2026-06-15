# @stitchapi/nest

First-class [NestJS](https://nestjs.com) integration for
[StitchAPI](https://stitchapi.dev) — design captured in
[ADR 0006](../../docs/adr/0006-nestjs-integration.md).

It is a **thin** package: `StitchModule` wires StitchAPI's `seam` into Nest's DI
graph, plus two bridge helpers and a `Logger` sink. It adds **no capability** — every
piece sits on an existing core extension point, so `stitchapi` stays a peer dependency
and core is untouched (contract-not-dependency).

```sh
pnpm add @stitchapi/nest stitchapi
# peers you already have in a Nest app: @nestjs/common, reflect-metadata
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
import { StitchModule, fromConfig } from '@stitchapi/nest';
import { bearer } from 'stitchapi';

@Module({
    imports: [
        StitchModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                baseUrl: config.getOrThrow('API_BASE_URL'),
                store: new RedisStore(config.getOrThrow('REDIS_URL')), // any StitchStore
                auth: bearer(fromConfig(config)('API_TOKEN')),
                trace: 'logger', // → loggerSink(new Logger('Stitch'))
            }),
        }),
    ],
})
export class AppModule {}
```

## Injectable stitches — `forFeature` + `defineStitch`

Declare stitches with `defineStitch(token, build)`; register them per feature module.
A feature module may also own its **own upstream seam** (its `baseUrl`/`auth`), built
over the shared store + trace — omit `seam` to attach the stitches to the default seam.

```ts
// users.stitches.ts
export const GetUser = defineStitch('GET_USER', (s) =>
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

## Multi-tenant — `seam.as(principal)` in request scope

Multi-tenancy is **principal-scoped over the shared store** (separate sessions/tokens
per tenant, one connection pool) — never a per-request store. Bind the principal from
the request:

```ts
{
    provide: TENANT_SEAM,
    scope: Scope.REQUEST,
    useFactory: (root: Seam, req) => root.as(req.user?.tenantId ?? 'anonymous'),
    inject: [STITCH_SEAM, REQUEST],
}
```

Outside HTTP (BullMQ, `@Cron`, microservices) there is no `REQUEST`: inject the seam and
bind explicitly — `seam.as(job.data.tenantId)`.

## Bridges

-   **`loggerSink(logger?)`** — a `TraceSink` that forwards the event stream to a Nest
    `Logger`. It logs only name/method/url/status and strips the URL query: a custom sink
    receives **un-redacted** events, so never log `event.input`/headers raw.
-   **`fromConfig(config)(key)`** — a `ConfigService`-backed secret thunk (core's `env()`
    twin). Synchronous, so it cannot fetch a rotating secret per call — use
    `oauth2`/`cookieSession` for that.

## Testing

Swap the transport globally with the seam's `adapter`, or override a stitch provider:

```ts
StitchModule.forRoot({ adapter: mockAdapter }); // every stitch hits the mock
// or: Test.createTestingModule(...).overrideProvider(GetUser.token).useValue(fakeStitch)
```
