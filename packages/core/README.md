<img src="https://github.com/rejifald/StitchAPI/blob/9c65d767e6e2ecff7e0a7a2922843a7cdc38a0b5/docs/media/logo_baner_light.png?raw=true" alt="StitchAPI Logo Banner"/>

---

> [!NOTE]
>
> **StitchAPI is at `1.0.0-rc.6`.** The core runtime is feature-complete, zero-dependency, covered by a green test gate, and already running in production in two projects. We're validating in the wild before stamping a stable `1.0.0` — pin an exact version and expect only small, documented changes. Feedback is welcome.

**Turn any REST, GraphQL, SSE, or LLM API into a typed, resilient function.** Its one primitive — a **stitch** — takes a single endpoint and hands you back a callable: declare the endpoint's contract once (input, output, auth, resilience) and call it like a local function. No server, no codegen, no config files — only explicit composition. The same definition your code calls, the CLI runs and an AI agent can invoke without ever touching a credential.

**Full documentation, guides, and a live playground live at [stitchapi.dev](https://stitchapi.dev).**

## Table of Contents

- [Motivation](#motivation)
- [Why StitchAPI](#why-stitchapi)
- [What StitchAPI is not](#what-stitchapi-is-not)
- [Features](#features)
- [Documentation](#documentation)
- [Installing](#installing)
- [Quick start](#quick-start)
- [The event stream](#the-event-stream)
- [Composition & reuse](#composition--reuse)
- [Validation & leveled drift](#validation--leveled-drift)
- [Resilience: retry, throttle, timeout](#resilience-retry-throttle-timeout)
- [Caching](#caching)
- [Auth as a boundary](#auth-as-a-boundary)
- [Pluggable state store](#pluggable-state-store)
- [Request body encoding](#request-body-encoding)
- [HTTP transport (adapters)](#http-transport-adapters)
- [Surfaces: any request style](#surfaces-any-request-style)
- [Pagination](#pagination)
- [Transform](#transform)
- [Zero-infra observability](#zero-infra-observability)
- [The stitch CLI](#the-stitch-cli)
- [Agent-native](#agent-native)
- [Errors & pitfalls](#errors--pitfalls)
- [Ecosystem](#ecosystem)
- [Scope & roadmap](#scope--roadmap)
- [License](#license)

## Motivation

In almost every project involving HTTP calls, there’s usually a src/api directory filled with simple functions that make HTTP requests using a chosen HTTP library. These functions often do the bare minimum: send an HTTP request and “unwrap” the response.

Everything that actually makes an integration reliable — auth lifecycle, retries, rate limits, timeouts, response validation, drift detection, observability — is left to be re-implemented at every call site, and each wrapper rots independently. `fetch` hands back opaque bytes — and raw bytes are not what application code, or an AI agent, actually needs; both want structured, validated, observable results.

A stitch folds all of that back into the call:

| Around raw `fetch`, you hand-roll…                  | …a stitch declares it once                                    |
| --------------------------------------------------- | ------------------------------------------------------------- |
| Opaque bytes you parse and hope are the right shape | Schema-validated, typed results — drift caught on every call  |
| A throw on the first failure, then it's on you      | Retries with backoff + jitter, honoring `Retry-After`         |
| One coarse timeout, if you remember it              | Layered total / per-attempt timeouts with real aborts         |
| No rate control — you meet the 429s in production   | Proactive throttle: rate + concurrency caps, shared per host  |
| A raw byte stream you frame and paginate yourself   | SSE framing, delta concatenation, auto-pagination             |
| Zero visibility into what the call did              | A typed event stream + opt-in traces: latency, retries, drift |

This project replaces that folder with a single primitive. You declare an endpoint (or “stitch”) and receive a ready-to-use function in return — with resilience, auth, validation, and observability folded into the call itself, for human and agent callers alike.

## Why StitchAPI

There are plenty of ways to get a typed API client — spec-based generators, hand-authored contract clients, workflow platforms, or a folder of hand-rolled fetch wrappers. StitchAPI sits in a spot none of them cover: it turns **one endpoint at a time** into a resilient, validated, observable function — no spec, no codegen, no config files, no server; only explicit composition.

- **Atomic, not spec-first.** Spec-based generators (openapi-generator, Orval, Kubb, …) need a complete, accurate OpenAPI document before they can emit anything — and most real-world APIs (internal services, undocumented vendors, the long tail) never get one. A stitch needs a URL and an example response. Got a spec anyway? It stays useful — spec ingestion is on the roadmap as a shortcut, never a requirement — and since every stitch carries its own schema, a spec can eventually be _emitted_ from your stitches instead.

- **A runtime, not a code generator.** There is no generated SDK to commit, diff, and regenerate when the API changes. The declaration _is_ the client, and validation runs on every live call — so when a vendor silently renames a field, you get a loud, leveled **drift** signal (error / warn / info) instead of a `200 OK` and an `undefined` three layers downstream. Compile-time types can't catch that, and a generated client is only as fresh as its last regeneration.

- **Resilience is declared, not hand-rolled.** Retries with backoff and `Retry-After`, proactive throttling (rate and concurrency caps), timeouts, pagination — the things every `src/api/` folder reinvents per project — are configuration on the stitch, uniform across every integration.

- **Auth is a boundary, not a header you remember to set.** A stitch owns its credential and its lifecycle — bearer, API keys, cookie sessions with automatic login and re-login on expiry, OAuth2 client credentials. Callers get a **capability, not the credential**: they invoke the stitch and receive data without ever touching the secret. That matters double when the caller is an AI agent.

- **Agents are first-class callers.** Typed clients were designed for humans writing app code. A stitch is also designed to be invoked by an agent: one definition is callable as an in-process function, a CLI command (`stitch run`), an HTTP endpoint (`stitch serve`), and an MCP tool server (`stitch mcp`) — returning structured, schema-validated, traceable results instead of opaque bytes.

- **Observability with zero infrastructure.** Every call emits a typed event stream, but tracing is **off by default** — a stitch's only effect is its call, writing and printing nothing until you opt in (per stitch with `trace: 'console'` / `fileSink(path)` / a `TraceSink`, or globally with `STITCH_TRACE_CONSOLE=1` / `STITCH_TRACE_FILE=<path>` / `STITCH_EXPORT=otlp`). Then it's the console and a local JSONL log (`stitch trace` to inspect) — no collector, no dashboard, nothing to deploy.

- **A library, not a platform.** Zero runtime dependencies, embeds in your project, nothing to operate. Workflow platforms (Windmill, n8n, …) solve integration with a server and a visual builder; StitchAPI keeps it a code primitive — stitches compose in plain TypeScript.

- **Composes with your data layer.** Already using TanStack Query, SWR, or RTK Query? A stitch _is_ the `queryFn` — it owns the call's resilience (retries, throttle, validation, drift); your query layer owns view state (subscriptions, cache, invalidation). They stack; they do not compete. See the [TanStack Query guide](https://stitchapi.dev/docs/integrations/tanstack-query).

- **First-party framework integrations.** Thin peer-dependency packages wire a stitch into the framework you already run — server frameworks, client/UI bindings, state stores, observability sinks, and more — each adding no capability of its own (core stays untouched). See the full [Ecosystem](#ecosystem) below.

At a glance:

| Alternative                                            | Needs                    | You maintain                                          | StitchAPI instead                                                        |
| ------------------------------------------------------ | ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Spec-based codegen (openapi-generator, Orval, Kubb, …) | a complete OpenAPI spec  | a generated SDK, regenerated on every API change      | one endpoint at a time, validated live at runtime                        |
| Typed runtime clients (Zodios, ts-rest, …)             | a hand-authored contract | your own retry / auth / rate-limit code around it     | resilience, auth lifecycle, and drift detection built into the primitive |
| Workflow platforms (Windmill, n8n, …)                  | a server to deploy       | flows inside someone else's runtime                   | a zero-dependency library; composition is just code                      |
| Hand-rolled `fetch` wrappers                           | nothing                  | bespoke auth, retries, limits — re-solved per project | the same concerns, declared once per stitch                              |

For the full competitive landscape and positioning, see the [Overview](docs/OVERVIEW.md).

## What StitchAPI is not

Knowing what a tool refuses to be is how you trust what it is. StitchAPI holds a hard line on scope:

- **Not an HTTP client or `fetch` replacement.** `fetch` and axios are the substrate underneath — bring your own adapter. A stitch sits _above_ the transport and turns an endpoint into a function; it never reimplements the call.
- **Not a code generator.** There's no SDK to commit, diff, and regenerate. The declaration is the runtime, validated live on every call — so it can't fall out of date with the API.
- **Not spec-first.** No OpenAPI document required. A URL and one example response is enough — so it reaches the internal and undocumented long tail codegen never covers.
- **Not a server to deploy.** Nothing to run or operate, and you don't own both ends. It's a zero-dependency library you import — for the APIs you don't control.
- **Not a workflow engine or iPaaS.** No orchestration, queues, or visual builder. Composition is plain TypeScript; the stitch is the boundary and nothing more.
- **No config files or hidden inheritance.** Nothing ambient or global a stitch silently reads — everything that shapes a call is composed in explicitly. Read one stitch and you know exactly what it does.

No server, no codegen, no config files, no implicit inheritance — **only explicit composition.**

## Features

- **One primitive, scoped to a surface** - `stitch(url | config)` returns a typed, callable function. One endpoint is a bare `stitch`; **a service with more than one endpoint is a `seam`** — declare the shared base, auth, and throttle budget once, add each endpoint with `.stitch()`, and members share config _and_ runtime (one store, throttle bucket, sink) behind a trusted principal boundary. Lighter, runtime-free sharing — a config fragment, or deriving one stitch from another — is `extends`, with `.with()` partial application on top.
- **Event-stream core** - every call yields a typed stream (`start → progress → drift → result → done`); `await` is sugar that consumes it and returns the final validated value.
- **Bring-your-own validation** - validate `params` / `query` / `body` / `headers` and the response with [Zod](https://zod.dev) or any [Standard Schema](https://standardschema.dev) library (Valibot, ArkType, …); TypeScript types are inferred from the schemas.
- **Leveled drift detection** - live responses are validated against the declared schema (the contract); a required field missing/incompatible **throws**, while soft drift (a coercion, an undeclared or defaulted field) surfaces as a non-fatal `warn` / `info` / `verbose` finding instead of a silent `undefined`.
- **Declared resilience** - retry with backoff and `Retry-After`, proactive throttle (rate + concurrency, per stitch or per host), total / per-attempt timeouts with real aborts, a circuit breaker, and idempotency keys.
- **Read-through caching** - an opt-in response cache with in-process request coalescing, keyed by a derived, principal-scoped key — sound by construction (it refuses to cache a shape it can't fingerprint) and loaded lazily from `stitchapi/cache`.
- **Auth as a boundary** - `bearer`, `apiKey`, `basic`, `cookieSession` (auto-login and re-login), and `oauth2` client credentials; secrets resolve at call time via `env()` / `secretsFile()` and never reach the caller.
- **Data shaping** - `pick` dot-paths, `transform` (e.g. scrape HTML into structure), auto-looping pagination, and `json` / `form` / `multipart` request bodies.
- **Any request style** - `http` is the default; `graphql`, `sse`, `stream`, `download`, `llm`, `shell`, and `postmessage` are peer **surfaces**, each a subpath import (`stitchapi/sse`, …) on the same engine — so `import { stitch }` bundles `http` alone.
- **Pluggable state store** - throttle counters and sessions/tokens live behind a 3-method store; in-memory by default, a shared store makes throttling distributed and sessions shared across workers.
- **Zero-infra observability** - tracing is **off by default** (a stitch's only effect is its call); opt in per stitch with `trace: 'console'` / `fileSink(path)` / a `TraceSink`, or globally with `STITCH_TRACE_CONSOLE=1` / `STITCH_TRACE_FILE=<path>` / `STITCH_EXPORT=otlp`. `stitch trace` then summarizes runs, retries, drift, and latency percentiles.
- **CLI, HTTP & MCP surfaces** - the definition your code imports is also runnable from the shell (`stitch run <name>` streams JSONL events), served over HTTP (`stitch serve`), or exposed to agents over MCP (`stitch mcp`) — the same stitch behind every front door.
- **Typed URLs** - full [RFC 6570](https://datatracker.ietf.org/doc/html/rfc6570) URI templates (`{id}`, `{+path}`, `{?q,sort}`, explode `*`, prefix `:n`), and a `qs`-style query builder that serializes nested objects (`a[b]=c`) and arrays — both dependency-free.
- **Pluggable transport** - `fetch` by default; drop in the shipped `axiosAdapter`, or any `Adapter` function, to route requests through axios or another HTTP client.
- **Zero runtime dependencies** - `"dependencies": {}`; built on the platform's global `fetch`; tree-shakeable. The whole entry is **~23 kB min+gzip**; a typical `import { stitch }` trims to **~20 kB** — and with no transitive tree, that is the entire cost.

## Documentation

The full documentation site lives at **[stitchapi.dev](https://stitchapi.dev)** — start with the [Quickstart](https://stitchapi.dev/docs/getting-started/quickstart), then the per-feature guides, [Concepts](https://stitchapi.dev/docs/concepts/the-stitch), [Surfaces](https://stitchapi.dev/docs/surfaces/function), [For agents](https://stitchapi.dev/docs/agents), and the generated [Reference](https://stitchapi.dev/docs/reference/stitch).

Design notes and positioning live in the repo:

- [**Feature Lenses**](docs/FEATURE-LENSES.md) — the full feature map: every capability grouped by _lens_ (reliability, observability, security, data, …) and family.
- [**Overview**](docs/OVERVIEW.md) — vision, positioning, competitive landscape, and scope.
- [**Design**](docs/DESIGN.md) — the technical design and key decisions.

## Installing

Using npm:

```bash
$ npm install stitchapi@rc
```

Using yarn:

```bash
$ yarn add stitchapi@rc
```

Using pnpm:

```bash
$ pnpm add stitchapi@rc
```

Once the package is installed, you can import the library using `import` or `require` approach:

```js
import { stitch } from "stitchapi";
// either
const { stitch } = require("stitchapi");
```

The runtime ships with zero dependencies. Schema validation is bring-your-own — pass a [Zod](https://zod.dev) schema or any [Standard Schema](https://standardschema.dev) validator ([Valibot](https://valibot.dev), [ArkType](https://arktype.io), …); none of them is bundled. The examples below use Zod for familiarity.

**Bundle size.** The whole `stitchapi` entry is **~23 kB minified + gzipped** (63 kB raw, ~20 kB brotli); because the package is side-effect-free and every surface beyond `http` lives behind its own subpath import, a typical `import { stitch }` tree-shakes to **~20 kB min+gzip**. With zero dependencies, that is the _whole_ cost — there is no transitive tree to install or audit.

## Quick start

The smallest stitch is a URL — declare once, call many times:

```ts
import { stitch } from 'stitchapi';

const getUsers = stitch('https://demo.stitchapi.dev/users');

const users = await getUsers(); // GET, parsed JSON
```

Path params use [RFC 6570](https://datatracker.ietf.org/doc/html/rfc6570) URI templates — simple `{id}` interpolation is the common case, with the full operator set available (`{+reserved}`, `{/segment}`, `{?query,keys}`, explode `{list*}`, prefix `{var:3}`). Template variables are filled from `params`; `params`, `query`, `headers`, and `body` all travel in a single input object:

```ts
const getUser = stitch('https://demo.stitchapi.dev/users/{id}');

await getUser({ params: { id: 1 }, query: { expand: 'roles' } });
// → GET https://demo.stitchapi.dev/users/1?expand=roles
```

The query builder serializes nested objects and arrays `qs`-style — `{ filter: { type: 'admin' }, ids: [1, 2] }` → `filter[type]=admin&ids[0]=1&ids[1]=2`. Query defaults can be baked into the path; call-time query keys merge over them:

```ts
const findUsers = stitch(
    'https://demo.stitchapi.dev/users?sort=name&type=admin',
);

await findUsers({ query: { type: 'user' } });
// → /users?sort=name&type=user
```

Add an `output` schema and you get TypeScript types, runtime validation, and drift detection in one move:

```ts
import { stitch } from 'stitchapi';
import { z } from 'zod';

const User = z.object({
    id: z.number(),
    name: z.string(),
    email: z.string(),
    role: z.enum(['admin', 'member', 'viewer']),
});

const getUser = stitch({
    path: 'https://demo.stitchapi.dev/users/{id}',
    output: User,
    pick: 'data', // the demo sim wraps payloads in a { data } envelope
});

const user = await getUser({ params: { id: 1 } }); // typed User
```

One endpoint is one `stitch`. The moment a service has more than one — sharing a base URL, auth, and a rate budget — model the whole surface as a [seam](#composition--reuse) and add each endpoint as a member; reach for a bare `stitch` only for a genuinely standalone call.

## The event stream

A stitch does not return `Promise<bytes>`. It yields a typed event stream — `await` is sugar that consumes the stream and returns the final, picked, validated `result` (or throws a `StitchError` carrying `.status`, plus `.body` (the parsed error payload) and `.url` (the final request URL) when the failure came from a response):

```ts
const users = await getUsers(); // sugar: consume the stream → the result value
```

Prefer to handle failure inline rather than with `try`/`catch`? `.safe()` never throws — it resolves to a `{ ok, data, error }` result you destructure (discriminate on `error`):

```ts
const { data, error } = await getUsers.safe();
if (error) return; // error: StitchError (.status, .attempts, .body, .url); data is null
use(data); // narrowed: data is the validated result, error is null
```

`.unwrap()` is the explicit throwing twin — it returns the value or throws a `StitchError`, exactly like awaiting the bare call. Both also have a result-object form (`getUsers(input).safe()`).

Consume the stream directly to see progress, throttle waits, retries, and drift as they happen — it is the same spine that powers observability:

```ts
for await (const ev of getUsers.stream()) {
    switch (ev.type) {
        case 'start': // { name, method, url, input }
            break;
        case 'progress': // { phase: 'auth'|'request'|'throttled'|'retry'|'paginate', attempt, waited? }
            break;
        case 'drift': // { finding: { level: 'error'|'warn'|'info', path, change } }
            break;
        case 'result': // { data, status, attempts }
            break;
        case 'error': // { message, status?, attempts }
            break;
        case 'done': // { ok, elapsed, attempts }
            break;
    }
}
```

## Composition & reuse

Everything reusable is a named value, and a stitch composes values — **no global config is ever required**.

**A service with more than one endpoint is a `seam` — this is the default, not the advanced case.** Declare the shared base, auth, retry, and throttle budget once; each endpoint is a member created with `.stitch()`. Members inherit that config _and_ share one runtime — a single throttle bucket, store, and trace sink — behind a trusted principal boundary, so the whole surface obeys one rate budget and one session instead of each endpoint re-solving them:

```ts
import { seam } from 'stitchapi';
import { z } from 'zod';

const User = z.object({
    id: z.number(),
    name: z.string(),
    email: z.string(),
    role: z.enum(['admin', 'member', 'viewer']),
});

const api = seam({
    baseUrl: 'https://demo.stitchapi.dev',
    retry: { attempts: 3, on: [429, 503] },
    timeout: { total: '30s' },
});

const listUsers = api.stitch({
    path: '/users',
    output: User.array(),
    pick: 'data',
});
const getUser = api.stitch({
    path: '/users/{id}',
    output: User,
    pick: 'data',
});
```

Reach for `extends` for the lighter cases — sharing a plain config fragment, or deriving one stitch from another — where you want config reuse without a shared runtime. A fragment is just an object; `extends: [...]` merges left→right, with own fields winning last:

```ts
import { stitch } from 'stitchapi';

// A plain fragment — config to merge, no runtime of its own.
const base = {
    baseUrl: 'https://demo.stitchapi.dev',
    retry: { attempts: 3, on: [429, 503] },
};

const listUsers = stitch({
    extends: [base],
    path: '/users',
    output: User.array(),
    pick: 'data',
});
```

A stitch is itself a composable value — extend one and override only the diff:

```ts
const getOneUser = stitch({
    extends: [listUsers], // inherits baseUrl + retry + pick
    path: '/users/{id}',
    output: User,
});
```

Merge semantics: scalars (`path`, `method`, `baseUrl`, `pick`) replace; objects (`retry`, `throttle`, `timeout`, `input`) deep-merge; `hooks` chain across layers (`onRequest` runs base→child, the rest unwind child→base).

`.with()` pre-binds part of the input and returns a new stitch that reuses the same runtime — so cookies, tokens, and throttle state persist across the bound and unbound forms:

```ts
const adminUsers = listUsers.with({ query: { role: 'admin' } });

await adminUsers({ query: { q: 'ada' } }); // → /users?role=admin&q=ada
```

## Validation & leveled drift

Validation is not binary pass/fail. The declared `output` schema **is** the contract. Wrap it in `drift()` and a response is validated (returning the validated value — coerced, defaulted, unknown keys stripped), and the difference between the raw body and that validated value is reported as a leveled, non-fatal signal:

| Change         | What it means                                                              | Default level |
| -------------- | -------------------------------------------------------------------------- | ------------- |
| **invalid**    | a required field is missing or incompatible — **throws**                   | `error`       |
| **coerced**    | the schema coerced a value (`"42"`→`42`): a wire-type shift validation hid | `warn`        |
| **undeclared** | the response carried a key the schema strips                               | `info`        |
| **defaulted**  | a `.default()` fired because the field was absent                          | `verbose`     |

```ts
import { drift, stitch } from 'stitchapi';
import { z } from 'zod';

const listOrders = stitch({
    path: 'https://demo.stitchapi.dev/users/{id}/orders',
    pick: 'data',
    output: drift(
        z.array(z.object({ id: z.number(), total: z.number().optional() })),
        {
            ignore: ['[].meta'], // acknowledged, unconsumed fields — don't report them
            severity: { coerced: 'info' }, // re-level a kind, or pass a level/list to filter
        },
    ),
});
```

Drift is **schema-anchored** — no snapshot to manage. Severity lives in the schema: a required field that goes missing or turns incompatible is a hard `invalid` that **throws**; everything else is non-fatal drift you read off the event stream. So natural variance is never a false alarm — an optional field absent, a `string | null` that's null, an empty or heterogeneous array all validate clean and report nothing. `ignore` silences fields you know about without bloating the schema; `severity` filters (a level / list) or re-levels (a map) the soft signals. Drift watches the surface you declared; what the provider changes in fields you don't model is, by definition, change you don't consume.

The request side validates too. `input` takes a schema per part, and a mismatch fails fast with a `ValidationError` before any request is sent:

```ts
const createUser = stitch({
    method: 'POST',
    path: 'https://demo.stitchapi.dev/users',
    input: {
        body: z.object({
            name: z.string(),
            email: z.string(),
            role: z.enum(['admin', 'member', 'viewer']),
        }),
    },
    output: User, // { id, name, email, role }
    pick: 'data',
});
```

Schemas can be Zod, any [Standard Schema](https://standardschema.dev) validator (Valibot, ArkType, …), or a custom object implementing the tiny `Validator` interface.

## Resilience: retry, throttle, timeout

The things every `src/api/` folder reinvents are configuration here — uniform across every stitch:

```ts
const listUsers = stitch({
    baseUrl: 'https://demo.stitchapi.dev',
    path: '/users',
    retry: { attempts: 4, on: [429, 502, 503], respectRetryAfter: true },
    throttle: { rate: '1/s', concurrency: 2, pool: 'host' },
    timeout: { total: '30s', perAttempt: '10s' },
});
```

- **`throttle` is proactive** - a rate (`'1/s'`) and a concurrency cap that keep you under a vendor's limit before it bites; `pool: 'host'` shares one limiter across every stitch hitting the same host.
- **`retry` is reactive** - `attempts` is the total including the first; retried statuses default to `[429, 502, 503, 504]`; backoff is `'expo'` / `'expo-jitter'` / `'fixed'`, with `backoff.base` / `backoff.max` bounds; `respectRetryAfter` honors the `Retry-After` header (delta-seconds or HTTP-date).
- **`timeout` aborts** - `total` and/or `perAttempt`, as milliseconds or `'30s'`-style strings, enforced with a real `AbortSignal` instead of a request left hanging.

Throttle waits and retries emit `throttled` / `retry` events on the stream, so the waiting is visible in the trace for free.

### Circuit breaker, idempotency & accepted statuses

Three more knobs round out the resilience set:

- **`circuit`** fast-fails a dependency that is already down — after `failures` consecutive failures the breaker opens for `cooldown`, then allows a half-open trial. A repeatedly-failing dependency stops eating your latency budget (and throws `STITCH_CIRCUIT_OPEN` while open):

    ```ts
    circuit: { failures: 5, cooldown: '30s' } // or the positional [5, '30s']
    ```

- **`idempotency`** injects a stable `Idempotency-Key` header on writes, so a safe retry can't duplicate a side effect:

    ```ts
    idempotency: {
        keyOf: (input) => input.body.requestId;
    }
    ```

- **`acceptStatus`** treats a non-2xx as a _normal_ result rather than a throw — for endpoints where, say, `404` is expected control flow. The body flows through `transform` → `pick` → validate exactly like a `2xx`:

    ```ts
    acceptStatus: [404]; // resource-gone → fall back, no try/catch on the happy path
    ```

When an _outer_ gate owns backoff (its own `Retry-After` budget, a DB-persisted limiter), `throttle: { delegate: true }` surfaces a `RateLimitError` (carrying `retryAfter`) instead of retrying internally — so StitchAPI's retry + throttle don't double-count against it.

## Caching

A read-through response cache with in-process request coalescing — **off by default**, loaded lazily from the `stitchapi/cache` subpath only when a stitch sets `cache` (so `import { stitch }` pulls none of it). The cache key is **derived** from the resolved request — there are no caller-authored keys to drift from what they name — and it is **principal-scoped by default** (fail-closed), so user A can never be served user B's cached response.

A bare duration is the TTL shorthand:

```ts
const getUser = stitch({
    path: 'https://demo.stitchapi.dev/users/{id}',
    output: User,
    pick: 'data',
    cache: '5m', // ≡ { ttl: '5m' }
});
```

Pass a config object for the full control surface:

```ts
const listAnnouncements = stitch({
    path: 'https://demo.stitchapi.dev/announcements',
    output: z.array(z.object({ id: z.number(), title: z.string() })),
    pick: 'data',
    cache: {
        ttl: '1h',
        scope: 'app', // public, unauthenticated data → share one entry across callers
        vary: ['accept-language'], // request headers that vary the response
        entries: 500, // in-process LRU cap (default 1000)
    },
});
```

Concurrent identical in-flight calls in one process **coalesce** onto a single shared run (set `coalesce: false` to opt out). Caching is sound by construction: a stitch with an `output` schema caches only when that schema can be fingerprinted (a registered `@stitchapi/fingerprint-*` strategy) or you pin a `version` — otherwise it **refuses to cache** rather than risk serving a stale shape. Mark one-time tokens or compliance-bound data `sensitive: true` to opt a stitch out of the cache entirely.

## Auth as a boundary

Auth is a field on the stitch (or on a fragment it extends) — never global. Secrets resolve **at call time**: `env()` reads an environment variable, `secretsFile()` reads `~/.stitch/secrets.json` (falling back to env). The stitch declaration is committable, and the caller — your code or an agent — invokes the stitch and gets data without ever seeing the credential.

Header strategies — `bearer`, `apiKey` (default header `x-api-key`), `basic`:

```ts
import { stitch } from 'stitchapi';
import { bearer, env } from 'stitchapi/auth';

const getUser = stitch({
    path: 'https://demo.stitchapi.dev/users/{id}',
    auth: bearer(env('API_TOKEN')), // resolved per call; the caller passes no secret
});
```

**OAuth2 client credentials** — `oauth2()` POSTs the token endpoint (form-encoded `client_credentials` grant), caches the access token in the [store](#pluggable-state-store) with the TTL from `expires_in`, refreshes it `refresh.skew` (default 30s) before expiry, and attaches it as `Authorization: Bearer …`. A rejected token (status matched by `refresh`, default `[401]`) forces a fresh fetch and an uncounted re-run of the attempt:

```ts
import { stitch } from 'stitchapi';
import { env, oauth2 } from 'stitchapi/auth';

const listOrders = stitch({
    path: 'https://demo.stitchapi.dev/users/{id}/orders',
    auth: oauth2({
        tokenUrl: 'https://demo.stitchapi.dev/oauth/token',
        clientId: env('OAUTH_CLIENT_ID'),
        clientSecret: env('OAUTH_CLIENT_SECRET'),
        scope: 'orders:read', // optional, space-delimited
    }),
});
```

Give two stitches the same `key` plus a shared [store](#pluggable-state-store) and they share one token — across stitches, workers, and restarts.

**Cookie sessions** — the marquee case: `cookieSession` runs a login (itself a stitch), captures the cookie from `Set-Cookie`, replays it on every call, and re-logs-in when the wall returns:

```ts
import { stitch } from 'stitchapi';
import { cookieSession, env, secretsFile } from 'stitchapi/auth';

const signIn = stitch({
    method: 'POST',
    baseUrl: 'https://demo.stitchapi.dev',
    path: '/auth/sign-in',
    bodyType: 'form',
});

const listUsers = stitch({
    baseUrl: 'https://demo.stitchapi.dev',
    path: '/users',
    pick: 'data',
    auth: cookieSession({
        login: signIn,
        cookie: 'session_token', // captured from Set-Cookie, replayed each call
        loginInput: () => ({
            body: {
                email: env('APP_USER')(),
                password: secretsFile('APP_PASS')(),
            },
        }),
        refresh: [401], // the wall → re-login, then retry (default)
    }),
});

await listUsers();
// → logs in, replays the cookie, dissolves the 401 wall on expiry.
//   The caller never saw the password and never wrote the cookie dance.
```

A `200` that is really a login page is a soft wall — catch it with a content predicate:

```ts
auth: cookieSession({
    login: signIn,
    cookie: 'session_token',
    refresh: {
        when: (res) => typeof res.body === 'string' && /log in/i.test(res.body),
    },
});
```

## Pluggable state store

Throttle counters and session/token state live behind one small seam — a `store` you compose like any other value. The default is in-memory (zero-config, single process). Implement the 3-method interface over Redis/Postgres and, with no change at the call site:

- **throttle goes distributed** - rate counters are read through the store, so a shared store paces calls across processes;
- **sessions and tokens are shared** - `cookieSession` / `oauth2` state under the same `key` is reused across stitches and workers, surviving restarts.

```ts
export interface StitchStore {
    get(key: string): Promise<unknown | undefined>;
    set(key: string, value: unknown, ttl?: number): Promise<void>;
    increment(key: string, ttl: number): Promise<number>; // atomic — rate windows
}
```

```ts
import { memoryStore, seam } from 'stitchapi';

// memoryStore() is the shipped default; swap in your Redis/Postgres-backed
// implementation of the same interface to go distributed. A seam shares one
// store across every stitch that belongs to it.
const api = seam({ store: memoryStore() });
```

You opt into a real store only when you scale out — progressive disclosure, applied to state.

## Request body encoding

`bodyType` selects the request encoding — `'json'` (default), `'form'`, or `'multipart'`:

```ts
const submit = stitch({
    method: 'POST',
    path: 'https://demo.stitchapi.dev/form',
    bodyType: 'form', // application/x-www-form-urlencoded
});
await submit({ body: { a: 1, b: 'x y' } });

const upload = stitch({
    method: 'POST',
    path: 'https://demo.stitchapi.dev/upload',
    bodyType: 'multipart', // multipart/form-data
});
await upload({
    // a { value, filename } field becomes a named file part
    body: { field: 'v', file: { value: bytes, filename: 'a.bin' } },
});
```

## HTTP transport (adapters)

A stitch talks to the network through an `Adapter` — `(req) => Promise<{ status, headers, body }>`. The default is the global `fetch`; set `adapter` to route a stitch (or a shared fragment) through a different client. The runtime stays zero-dependency, so the shipped `axiosAdapter` takes _your_ axios instance rather than importing one:

```ts
import axios from 'axios';
import { axiosAdapter, stitch } from 'stitchapi';

const getUser = stitch({
    path: 'https://demo.stitchapi.dev/users/{id}',
    adapter: axiosAdapter(axios), // body encoding, headers, and parsing match fetchAdapter
});
```

### Per-stitch dispatcher (proxy, custom CA, interface binding)

`fetchAdapter` takes options so you can thread a per-stitch undici **dispatcher** (an `Agent`) into the request — for a proxy, a custom CA, or binding to a specific network interface — without StitchAPI ever importing undici (the runtime stays zero-dependency, so you bring your own `Agent`). It rides through as Node's non-standard `dispatcher` fetch init option:

```ts
import { fetchAdapter, stitch } from 'stitchapi';
import { Agent } from 'undici';

const getUser = stitch({
    path: 'https://demo.stitchapi.dev/users/{id}',
    adapter: fetchAdapter({ dispatcher: new Agent({ connect: { ca } }) }),
});
```

With no options, `fetchAdapter()` behaves exactly as before (no `dispatcher` key is set). An optional `fetch` override (`fetchAdapter({ fetch })`) swaps the global `fetch` for testing or custom runtimes. The `axiosAdapter` equivalent is axios's own `httpAgent` / `httpsAgent`, passed through its `defaults` — `axiosAdapter(axios, { httpsAgent })`.

Body encoding (`json` / `form` / `multipart`), response parsing, and `set-cookie` handling are shared across transports, so swapping adapters doesn't change behavior. Any function matching the `Adapter` shape works — wrap `got`, a test double, or your own client the same way:

```ts
import type { Adapter } from 'stitchapi';

const echo: Adapter = async (req) => ({
    status: 200,
    headers: {},
    body: { method: req.method, url: req.url },
});
```

## Surfaces: any request style

A **surface** is the request _style_ a stitch speaks. `http` is the default — the plain JSON-over-HTTP call every example above uses. GraphQL, Server-Sent Events, a raw byte stream, a file download, an LLM chat-completion, a local shell command, and a typed `postMessage` channel are **peer surfaces**: each shapes and interprets its own request, but they all ride the same engine — `auth`, `retry`, `throttle`, `timeout`, validation, and the event stream compose with every one.

Every non-`http` surface ships as its own **subpath import**, so `import { stitch }` from the root pulls in only the `http` engine; a surface's code loads only when you import it.

| Surface       | Import                        | Shapes                                    | `await` resolves to            |
| ------------- | ----------------------------- | ----------------------------------------- | ------------------------------ |
| `http`        | `stitch` (default)            | a JSON-over-HTTP call                     | the validated body             |
| `graphql`     | `stitchapi/graphql`           | POST `{ query, variables }`, pick `data`  | the `data` payload             |
| `sse`         | `stitchapi/sse`               | a `text/event-stream` reader (over fetch) | every parsed event, collected  |
| `stream`      | `stitchapi/stream`            | a raw `ReadableStream` reader             | every decoded chunk, collected |
| `download`    | `stitchapi/download`          | a buffered binary GET                     | `{ blob, filename }`           |
| `llm`         | `stitchapi/llm`               | a chat-completion via a provider contract | the normalised `{ text, … }`   |
| `shell`       | `@stitchapi/shell` (peer pkg) | a local command, args + stdin             | the command's stdout           |
| `postmessage` | `stitchapi/postmessage`       | a typed iframe ↔ parent RPC / event call  | the typed RPC response         |

(Distinct from the four _invocation_ surfaces — function, CLI, HTTP, MCP — which are how you _call_ a stitch. A request surface is how a stitch shapes its _request_.)

### GraphQL

`graphql()` POSTs `{ query, variables }` and picks `data`. A `200` carrying `errors[]` is a failure — it will not silently pass:

```ts
import { graphql } from 'stitchapi';

const getUser = graphql({
    baseUrl: 'https://demo.stitchapi.dev',
    document: 'query ($id: ID) { user(id: $id) { name } }',
});

const user = await getUser({ variables: { id: 1 } });
```

### Streaming: `sse` and `stream`

A streaming surface decodes a live response body into `delta` events. `await` collects every chunk into an array; `.stream()` yields them as they arrive and buffers nothing — for an unbounded stream, prefer `.stream()`. `sse` parses the `text/event-stream` wire format over `fetch` + Web Streams (never `EventSource`), yielding one `{ event?, data, id?, retry? }` per event:

```ts
import { sse } from 'stitchapi/sse';

const events = sse({ url: 'https://demo.stitchapi.dev/events' });

for await (const ev of events.stream()) {
    if (ev.type === 'delta') handle(ev.chunk); // a parsed SSE event
}
```

`stream` is the raw sibling — `decode: 'bytes'` (default), `'lines'`, or `'ndjson'`; the bare decoder is shorthand for the object (`stream: 'ndjson'` ≡ `stream: { decode: 'ndjson' }`):

```ts
import { stream } from 'stitchapi/stream';

const logs = stream({
    url: 'https://demo.stitchapi.dev/logs',
    stream: 'ndjson',
});

for await (const ev of logs.stream()) {
    if (ev.type === 'delta') console.log(ev.chunk); // one parsed JSON value per line
}
```

Opening a stream charges the rate limiter once but never holds a concurrency slot, so a long-lived connection can't pin a seam's budget.

### Download

`download` fetches a file: GET + a buffered `Blob`, with byte progress, a `Content-Disposition` filename, and a per-call `AbortSignal`. It never writes to disk — saving the `Blob` is your call:

```ts
import { download } from 'stitchapi/download';

const getReport = download({ url: 'https://demo.stitchapi.dev/report.pdf' });

const { blob, filename } = await getReport({
    onProgress: (p) => console.log(p.loaded, '/', p.total),
});
```

### LLM and shell

Two non-HTTP surfaces speak the same engine. `llm` is a chat-completion over a provider _contract_ — the first-party `anthropic` and `openai` mappings are plain config, no SDK dependency, and the credential is the stitch's own `auth`:

```ts
import { apiKey, env } from 'stitchapi/auth';
import { anthropic, llm } from 'stitchapi/llm';

const chat = llm({
    provider: anthropic,
    model: 'claude-opus-4-8',
    auth: apiKey({ name: 'x-api-key', value: env('ANTHROPIC_API_KEY') }),
});

const { text } = await chat({
    body: { messages: [{ role: 'user', content: 'hi' }] },
});
```

`shell` ships as the separate `@stitchapi/shell` peer package. It runs a _static_ command (bound at construction, never from call input) and resolves to its stdout; the call passes the argument vector as the `body`, and the subprocess env is fail-closed (empty unless you name what's needed):

```ts
import { shell } from '@stitchapi/shell';

const git = shell({ command: 'git', env: { PATH: process.env.PATH! } });

const status = await git({ body: ['status', '--porcelain'] }); // stdout string
```

### postMessage

`postmessage` is a typed iframe ↔ parent RPC + event surface (ADR 0009). Build a channel over a `Window` (or `MessagePort`) — `allowedOrigins` is the security gate, and a wildcard `targetOrigin` is forbidden — then `request()` returns a stitch whose `auth` / `retry` / `timeout` / `output` validation compose like any other surface:

```ts
import { windowChannel } from 'stitchapi/postmessage';

const channel = windowChannel({
    target: iframe.contentWindow!,
    targetOrigin: 'https://app.example.com',
});

const getUser = channel.request({ type: 'getUser' });
const user = await getUser({ body: { id: 7 } });
```

Because every surface is just a stitch underneath, `auth`, `retry`, `throttle`, and `output` / `drift` compose with all of them.

## Pagination

One logical call follows pages until `next` returns `undefined` (or the `pages` safety cap, default 50, is hit), aggregating items into a single result. Each page is a full request — auth, retry, and throttle apply per page — and each page emits a `paginate` progress event:

```ts
const listOrders = stitch({
    path: 'https://demo.stitchapi.dev/users/{id}/orders',
    pick: 'data',
    paginate: {
        // previous page's raw body + pages fetched so far → input for the
        // next page (merged over the original), or undefined to stop
        next: (body, fetched) =>
            body.hasMore ? { query: { page: fetched + 1 } } : undefined,
    },
});

const everything = await listOrders({ params: { id: 1 } }); // [...page1, ...page2, ...] as one array
```

When the picked page is not itself the array, pass `items` to pull the array out of each page.

## Transform

`transform` runs before `pick` and validation — turn an arbitrary payload (HTML, text, a legacy shape) into structured data, then let `pick` + `output` / `drift` treat it like any other contract:

```ts
const listOrders = stitch({
    path: 'https://demo.stitchapi.dev/users/{id}/orders',
    transform: (html) => scrape(html), // your parser: HTML/text → { items: [...] }
    pick: 'items',
    output: z.array(z.object({ id: z.number(), total: z.number() })),
});
```

Pair it with `drift` and a renamed HTML selector that silently drops a field becomes a loud contract error instead of quiet data loss.

## Zero-infra observability

Observability is a consumer of the event stream, not a separate system — and it's **off by default**: a stitch's only effect is its call, writing and printing nothing until you opt in. Turn tracing on per stitch with the `trace` field (`'console'` for a colored stderr stream, `fileSink(path)` for JSONL on disk, or any `TraceSink`), or globally with the `STITCH_TRACE_*` / `STITCH_EXPORT` env vars — no collector, no dashboard, nothing to deploy:

```bash
# append JSONL to a path (off unless set; fileSink() defaults to ~/.stitch/runs/proto.jsonl)
STITCH_TRACE_FILE=./run.jsonl node app.js

# opt into a live, colored, one-line-per-event view on stderr
STITCH_TRACE_CONSOLE=1 node app.js

# ALSO fan the same events to an OTLP collector
STITCH_EXPORT=otlp node app.js

# capture full bodies (the JSONL truncates request/response bodies to 2048 chars by default)
STITCH_TRACE_MAX_BODY=full node app.js
```

That is per-call latency, status, attempts, throttle waits, and drift findings — recorded for free once you opt in, inspectable with [`stitch trace`](#the-stitch-cli) or plain `jq`. Drift rides the same events, so a leveled drift signal shows up in the trace with no extra wiring. The built-in JSONL and console sinks are safe by default — scrubbing happens at the sink boundary, so the live request is never touched, only the trace copy. Header values on a secret denylist (`authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`; widen it with `redactHeaders`) become `[REDACTED]`; credentials in the resolved URL are scrubbed (userinfo removed, secret query values like `api_key`/`access_token` replaced with `REDACTED`); and request bodies and response values are truncated to 2048 characters, with anything larger replaced by a `{ truncated, chars, preview }` marker. Opt into full, untruncated capture with `STITCH_TRACE_MAX_BODY=full` (or `fileSink(path, { maxBodyChars: false })`). Need a custom sink? Consume `.stream()` yourself — the built-in trace is just one consumer of the same events.

## The stitch CLI

One definition, more than one front door: the same stitch your code imports is callable from the shell, no app boot required. Export your stitches from a module (`stitches.ts` by default, `--module <path>` otherwise) and `stitch run` streams every event as one JSON line on stdout — ready for `jq`:

```bash
$ stitch run getUser --id 7 --query.expand roles
{"type":"start","name":"getUser","method":"GET","url":"https://demo.stitchapi.dev/users/7?expand=roles",...}
{"type":"result","data":{"id":7,"name":"Ada"},"status":200,"attempts":1,...}
{"type":"done","ok":true,"elapsed":142,...}
```

Flags map onto the stitch's single input object: a bare `--id 7` routes to `params` when `{id}` appears in the path (otherwise to `query`); `--body '<json>'` or `--body.<k> <v>` set the body; `--headers.<k> <v>` sets a header. The exit code is non-zero when an `error` event was seen. (`.ts` modules need a TypeScript-aware runner such as `tsx`; otherwise point `--module` at compiled JS.)

`stitch trace` summarizes the JSONL run log — per stitch: runs, failures, retries, drift counts, and latency percentiles:

```bash
$ stitch trace --since 1h
stitch   runs  ok  failed  retries  drift e/w/i  p50    p95    p99
getUser  12    11  1       3        0/1/2        140ms  310ms  840ms

total: 12 run(s), 11 ok, 1 failed
```

`--name <stitch>` filters to one stitch, `--file <path>` reads another log, `--json` emits the summary as JSON.

`stitch init` writes the canonical "declare a stitch, don't hand-roll `fetch`" rule into the files an AI coding agent reads — `AGENTS.md`, a Cursor `.cursor/rules/stitchapi.mdc`, a marked section in `CLAUDE.md`, plus `.github/copilot-instructions.md` (Copilot), `.windsurf/rules/stitchapi.md` (Windsurf), `.clinerules/stitchapi.md` (Cline), and `CONVENTIONS.md` (Aider) — so the next agent working in this repo reaches for StitchAPI. Pick conventions with `--format` (a comma list, or `all`, the default); it is idempotent, and `--force` rewrites an existing rule. Add `--project` to also list the stitches your repo already declares (so an agent reuses them), and `--check` to verify in CI that committed rule files have not drifted from the installed version.

## Agent-native

A stitch is built to be invoked by an AI agent, not just by your code. Two properties make it agent-native:

- **Capability, not credential.** Auth lives on the stitch; the caller invokes it and receives validated, traceable data without ever seeing the secret. That holds whether the caller is your code, the CLI, or a model.
- **One context-frugal tool, not one per endpoint.** Rather than generating an MCP tool for every endpoint — which floods the model's context window — an agent drives a single **code-mode** tool, `run_stitch`: it writes a small TypeScript snippet that imports `stitchapi` and calls the stitch. `list_stitches` enumerates what's callable and `describe_stitch` returns one stitch's shape and schema before it runs, so the context budget stays flat as the catalog grows.

Authoring is agent-friendly too. Hand an agent one example — a `curl` command, a HAR entry, a doc snippet — and it emits a stitch declaration. For the `curl`/HAR case there's a deterministic, model-free shortcut:

```bash
$ stitch from-curl 'curl https://demo.stitchapi.dev/users/7 -H "authorization: Bearer …"'
# prints a ready-to-commit stitch: id-like path segments lifted to {params},
# credentials replaced with env()
```

For reasoning over docs, the docs build emits an auto-generated [`llms.txt`](https://stitchapi.dev/llms.txt) and a per-page `llms.mdx`, so an agent pulls just the page it needs into context. Full guide: [Use from an agent](https://stitchapi.dev/docs/agents).

## Errors & pitfalls

When a stitch can't produce a result it throws a `StitchError` — an `Error` subclass carrying a human-readable `message`, an optional `.status` (the upstream HTTP status), and `.attempts` (how many tries the runtime made). When the failure came from a response it also carries `.body` (the parsed error payload) and `.url` (the final request URL). `.body` rides a non-enumerable channel and is **never** written to a trace sink, so an `{ error: "…" }` payload can't leak into a log:

```ts
import { StitchError, stitch } from 'stitchapi';

const getUser = stitch({ path: 'https://demo.stitchapi.dev/users/{id}' });

try {
    await getUser({ params: { id: 1 } });
} catch (e) {
    if (e instanceof StitchError) {
        console.error(e.message, e.status, e.attempts, e.body, e.url);
    }
}
```

Prefer to branch rather than wrap in `try`/`catch`? `.safe()` never throws — it resolves to `{ ok, data, error }`. Each failure mode has a stable code and a docs page (the slug _is_ the URL the runtime deep-links to):

| Code                  | When                                                                |
| --------------------- | ------------------------------------------------------------------- |
| `STITCH_VALIDATION`   | a response failed its output schema — the shape you got isn't asked |
| `STITCH_DRIFT`        | a response drifted past the level you allowed, so it was refused    |
| `STITCH_AUTH_WALL`    | auth failed, or a soft `200` login wall couldn't be refreshed       |
| `STITCH_TIMEOUT`      | a call exceeded its timeout budget before a response arrived        |
| `STITCH_CIRCUIT_OPEN` | the circuit breaker is open after repeated failures                 |
| `STITCH_GRAPHQL`      | a GraphQL response came back `200` but carried an `errors` array    |
| `RateLimitError`      | a delegate-backoff stitch surfaced a rate-limit for an outer gate   |

Full catalog with one page per code: [Errors & pitfalls](https://stitchapi.dev/docs/errors).

## Ecosystem

StitchAPI ships thin, peer-dependency integration packages — server frameworks, client/UI bindings, state stores, observability sinks, and more. Each adds no capability of its own; core stays untouched. The table below is **generated from each package's `package.json`** (by `pnpm gen:readme`, verified in CI by `pnpm check:readme`), so it never drifts as packages are added.

<!-- yakir:core-integrations -->

<table>
<thead><tr><th>Package</th><th>Description</th></tr></thead>
<tbody>
<tr><th colspan="2">Server frameworks</th></tr>
<tr><td><a href="packages/elysia"><code>@stitchapi/elysia</code></a></td><td>Web-standard seam on the context; SSE and error mapping</td></tr>
<tr><td><a href="packages/express"><code>@stitchapi/express</code></a></td><td>Request-scoped seam on req, with SSE and error mapping</td></tr>
<tr><td><a href="packages/fastify"><code>@stitchapi/fastify</code></a></td><td>App/request seam with SSE, error and Pino-logger bridges</td></tr>
<tr><td><a href="packages/hono"><code>@stitchapi/hono</code></a></td><td>Edge-ready seam on the request context; SSE and errors</td></tr>
<tr><td><a href="packages/nest"><code>@stitchapi/nest</code></a></td><td>Injectable stitches wired into the Nest DI graph</td></tr>
<tr><td><a href="packages/next"><code>@stitchapi/next</code></a></td><td>Stream a stitch as an SSE Response in the App Router</td></tr>
<tr><th colspan="2">Client &amp; UI bindings</th></tr>
<tr><td><a href="packages/angular"><code>@stitchapi/angular</code></a></td><td>Stitch lifecycle as Angular signals and an RxJS observable</td></tr>
<tr><td><a href="packages/expo"><code>@stitchapi/expo</code></a></td><td>Streaming over expo/fetch with a secure-store token store</td></tr>
<tr><td><a href="packages/query-core"><code>@stitchapi/query-core</code></a></td><td>Framework-agnostic reactive store behind the UI bindings</td></tr>
<tr><td><a href="packages/react"><code>@stitchapi/react</code></a></td><td>Tearing-free useStitch / useStitchStream hooks</td></tr>
<tr><td><a href="packages/react-native"><code>@stitchapi/react-native</code></a></td><td>Streaming XHR adapter and AsyncStorage-backed store</td></tr>
<tr><td><a href="packages/solid"><code>@stitchapi/solid</code></a></td><td>createStitch primitives reconciled into a Solid store</td></tr>
<tr><td><a href="packages/svelte"><code>@stitchapi/svelte</code></a></td><td>Stitch stores for Svelte 4 and 5 (unary + streaming)</td></tr>
<tr><td><a href="packages/vue"><code>@stitchapi/vue</code></a></td><td>Reactive useStitch / useStitchStream composables</td></tr>
<tr><th colspan="2">Data-fetching libraries</th></tr>
<tr><td><a href="packages/rtk-query"><code>@stitchapi/rtk-query</code></a></td><td>Run a stitch as an RTK Query endpoint, with stream updates</td></tr>
<tr><td><a href="packages/swr"><code>@stitchapi/swr</code></a></td><td>Run a stitch as an SWR fetcher; SWR owns caching</td></tr>
<tr><th colspan="2">State stores</th></tr>
<tr><td><a href="packages/cloudflare-kv"><code>@stitchapi/cloudflare-kv</code></a></td><td>Edge cache and shared sessions on Workers KV</td></tr>
<tr><td><a href="packages/deno-kv"><code>@stitchapi/deno-kv</code></a></td><td>Distributed throttle and sessions on Deno KV</td></tr>
<tr><td><a href="packages/redis"><code>@stitchapi/redis</code></a></td><td>Distributed throttle and shared sessions via Redis</td></tr>
<tr><th colspan="2">Auth</th></tr>
<tr><td><a href="packages/aws-sigv4"><code>@stitchapi/aws-sigv4</code></a></td><td>Sign requests with AWS SigV4 (edge-safe Web Crypto)</td></tr>
<tr><th colspan="2">AI</th></tr>
<tr><td><a href="packages/vercel-ai"><code>@stitchapi/vercel-ai</code></a></td><td>Expose a stitch as a model-callable tool, credential-safe</td></tr>
<tr><th colspan="2">Observability</th></tr>
<tr><td><a href="packages/pino"><code>@stitchapi/pino</code></a></td><td>The stitch event stream as structured Pino logs</td></tr>
<tr><td><a href="packages/sentry"><code>@stitchapi/sentry</code></a></td><td>Stitch events as Sentry breadcrumbs, with error capture</td></tr>
<tr><th colspan="2">Surfaces</th></tr>
<tr><td><a href="packages/shell"><code>@stitchapi/shell</code></a></td><td>Run a static local command as a stitch (injection-proof)</td></tr>
<tr><th colspan="2">Cache fingerprint adapters</th></tr>
<tr><td><a href="packages/fingerprint-arktype"><code>@stitchapi/fingerprint-arktype</code></a></td><td>Cache-fingerprint strategy for ArkType schemas</td></tr>
<tr><td><a href="packages/fingerprint-effect"><code>@stitchapi/fingerprint-effect</code></a></td><td>Cache-fingerprint strategy for Effect Schema</td></tr>
<tr><td><a href="packages/fingerprint-typebox"><code>@stitchapi/fingerprint-typebox</code></a></td><td>Cache-fingerprint strategy for TypeBox schemas</td></tr>
<tr><td><a href="packages/fingerprint-valibot"><code>@stitchapi/fingerprint-valibot</code></a></td><td>Cache-fingerprint strategy for Valibot schemas</td></tr>
<tr><td><a href="packages/fingerprint-zod"><code>@stitchapi/fingerprint-zod</code></a></td><td>Cache-fingerprint strategy for Zod schemas</td></tr>
<tr><th colspan="2">Other</th></tr>
<tr><td><a href="packages/docs-mcp"><code>@stitchapi/docs-mcp</code></a></td><td>StitchAPI documentation search, running locally over MCP stdio</td></tr>
<tr><td><a href="packages/json-schema"><code>@stitchapi/json-schema</code></a></td><td>Turn a runtime-discovered JSON Schema into a Standard Schema validator StitchAPI accepts</td></tr>
<tr><td><a href="packages/openapi"><code>@stitchapi/openapi</code></a></td><td>Eject selected operations from an OpenAPI document into ready-to-own StitchAPI source</td></tr>
</tbody>
</table>

<!-- /yakir:core-integrations -->

## Scope & roadmap

A stitch is a **per-call primitive**, not a workflow or iPaaS engine. Job queues, inbound webhooks, multi-step orchestration and rollback, business/DB idempotency, and app-level cache policy stay your app's job — absorbing them is exactly how a small library becomes the heavy platform it is positioned against.

The features once staged here have all shipped — the multi-cookie jar, circuit breaker, idempotency keys, the response cache, and binary/blob responses; OTLP export; the HTTP (`stitch serve`) and MCP (`stitch mcp`) surfaces of the same definition; and the non-HTTP `shell` and `llm` kinds with `pipe()` composition (ADR 0008), so a stitch's output can feed a model or shell call in the same declarative chain, traced end to end. The full roadmap and scope rationale live in the [Overview](docs/OVERVIEW.md).

## License

[Apache-2.0](LICENSE)

## Contributing

Issues and pull requests are welcome — see the [contributing guide](../../CONTRIBUTING.md) for local setup, the verify gate, and how to open a PR against `main`.
