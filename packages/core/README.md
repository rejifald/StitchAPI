<img src="https://github.com/rejifald/StitchAPI/blob/9c65d767e6e2ecff7e0a7a2922843a7cdc38a0b5/docs/media/logo_baner_light.png?raw=true" alt="StitchAPI Logo Banner"/>

---

> [!NOTE]
>
> **StitchAPI is at `1.0.0-rc.1`.** The core runtime is feature-complete, zero-dependency, covered by a green test gate, and already running in production in two projects. We're validating in the wild before stamping a stable `1.0.0` — pin an exact version and expect only small, documented changes. Feedback is very welcome.

StitchAPI is an agent-native integration runtime built around one primitive: a **stitch** — a typed, declarative, composable unit that turns a single endpoint into a resilient, validated, observable function. You declare it once; your code calls it, the CLI runs it, and an AI agent can invoke it without ever touching a credential.

The name StitchAPI combines the words “stitch” and “API,” reflecting its core purpose: to “stitch” or seamlessly connect any JSON-based API into your project. The term “stitch” conveys the idea of binding or linking various APIs into a unified system within your project.

<div align="center">

[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=rejifald_StitchAPI&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=rejifald_StitchAPI)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=rejifald_StitchAPI&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=rejifald_StitchAPI)
[![Reliability Rating](https://sonarcloud.io/api/project_badges/measure?project=rejifald_StitchAPI&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=rejifald_StitchAPI)
[![Bugs](https://sonarcloud.io/api/project_badges/measure?project=rejifald_StitchAPI&metric=bugs)](https://sonarcloud.io/summary/new_code?id=rejifald_StitchAPI)
[![Vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=rejifald_StitchAPI&metric=vulnerabilities)](https://sonarcloud.io/summary/new_code?id=rejifald_StitchAPI)
[![Code Smells](https://sonarcloud.io/api/project_badges/measure?project=rejifald_StitchAPI&metric=code_smells)](https://sonarcloud.io/summary/new_code?id=rejifald_StitchAPI)

[![Discord](https://img.shields.io/discord/1277332872814137505)](https://discord.gg/mAx9RQWN)
[![npm version](https://img.shields.io/npm/v/stitchapi.svg)](https://www.npmjs.org/package/stitchapi)
[![npm downloads](https://img.shields.io/npm/dm/stitchapi.svg)](https://npm-stat.com/charts.html?package=stitchapi)
[![NPM Type Definitions](https://img.shields.io/npm/types/stitchapi)](https://www.npmjs.org/package/stitchapi)

[![Codecov](https://img.shields.io/codecov/c/github/rejifald/stitchapi)](https://codecov.io/github/rejifald/StitchAPI)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/stitchapi?activeTab=dependencies)
![npm bundle size](https://img.shields.io/bundlephobia/minzip/stitchapi)
![Tree Shaking](https://badgen.net/bundlephobia/tree-shaking/stitchapi)

</div>

## Table of Contents

-   [Motivation](#motivation)
-   [Why StitchAPI](#why-stitchapi)
-   [Features](#features)
-   [Documentation](#documentation)
-   [Installing](#installing)
-   [Quick start](#quick-start)
-   [The event stream](#the-event-stream)
-   [Composition & reuse](#composition--reuse)
-   [Validation & leveled drift](#validation--leveled-drift)
-   [Resilience: retry, throttle, timeout](#resilience-retry-throttle-timeout)
-   [Auth as a boundary](#auth-as-a-boundary)
-   [Pluggable state store](#pluggable-state-store)
-   [Request body encoding](#request-body-encoding)
-   [HTTP transport (adapters)](#http-transport-adapters)
-   [Surfaces: any request style](#surfaces-any-request-style)
-   [Pagination](#pagination)
-   [Transform](#transform)
-   [Zero-infra observability](#zero-infra-observability)
-   [The stitch CLI](#the-stitch-cli)
-   [Scope & roadmap](#scope--roadmap)
-   [License](#license)

## Motivation

In almost every project involving HTTP calls, there’s usually a src/api directory filled with simple functions that make HTTP requests using a chosen HTTP library. These functions often do the bare minimum: send an HTTP request and “unwrap” the response.

Everything that actually makes an integration reliable — auth lifecycle, retries, rate limits, timeouts, response validation, drift detection, observability — is left to be re-implemented at every call site, and each wrapper rots independently. `fetch` hands back opaque bytes; that is the wrong primitive for application code, and an even worse one for an AI agent that needs structured, validated, observable results.

This project replaces that folder with a single primitive. You declare an endpoint (or “stitch”) and receive a ready-to-use function in return — with resilience, auth, validation, and observability folded into the call itself, for human and agent callers alike.

## Why StitchAPI

There are plenty of ways to get a typed API client — spec-based generators, hand-authored contract clients, workflow platforms, or a folder of hand-rolled fetch wrappers. StitchAPI sits in a spot none of them cover: it turns **one endpoint at a time** into a resilient, validated, observable function — no spec, no codegen, no server.

-   **Atomic, not spec-first.** Spec-based generators (openapi-generator, Orval, Kubb, …) need a complete, accurate OpenAPI document before they can emit anything — and most real-world APIs (internal services, undocumented vendors, the long tail) never get one. A stitch needs a URL and an example response. Got a spec anyway? It stays useful — spec ingestion is on the roadmap as a shortcut, never a requirement — and since every stitch carries its own schema, a spec can eventually be _emitted_ from your stitches instead.

-   **A runtime, not a code generator.** There is no generated SDK to commit, diff, and regenerate when the API changes. The declaration _is_ the client, and validation runs on every live call — so when a vendor silently renames a field, you get a loud, leveled **drift** signal (error / warn / info) instead of a `200 OK` and an `undefined` three layers downstream. Compile-time types can't catch that, and a generated client is only as fresh as its last regeneration.

-   **Resilience is declared, not hand-rolled.** Retries with backoff and `Retry-After`, proactive throttling (rate and concurrency caps), timeouts, pagination — the things every `src/api/` folder reinvents per project — are configuration on the stitch, uniform across every integration.

-   **Auth is a boundary, not a header you remember to set.** A stitch owns its credential and its lifecycle — bearer, API keys, cookie sessions with automatic login and re-login on expiry, OAuth2 client credentials. Callers get a **capability, not the credential**: they invoke the stitch and receive data without ever touching the secret. That matters double when the caller is an AI agent.

-   **Agents are first-class callers.** Typed clients were designed for humans writing app code. A stitch is also designed to be invoked by an agent: one definition is callable as an in-process function, a CLI command (`stitch run`), an HTTP endpoint (`stitch serve`), and an MCP tool server (`stitch mcp`) — returning structured, schema-validated, traceable results instead of opaque bytes.

-   **Observability with zero infrastructure.** Every call emits a typed event stream, but tracing is **off by default** — a stitch's only effect is its call, writing and printing nothing until you opt in (per stitch with `trace: 'console'` / `fileSink(path)` / a `TraceSink`, or globally with `STITCH_TRACE_CONSOLE=1` / `STITCH_TRACE_FILE=<path>` / `STITCH_EXPORT=otlp`). Then it's the console and a local JSONL log (`stitch trace` to inspect) — no collector, no dashboard, nothing to deploy.

-   **A library, not a platform.** Zero runtime dependencies, embeds in your project, nothing to operate. Workflow platforms (Windmill, n8n, …) solve integration with a server and a visual builder; StitchAPI keeps it a code primitive — stitches compose in plain TypeScript.

At a glance:

| Alternative                                            | Needs                    | You maintain                                          | StitchAPI instead                                                        |
| ------------------------------------------------------ | ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Spec-based codegen (openapi-generator, Orval, Kubb, …) | a complete OpenAPI spec  | a generated SDK, regenerated on every API change      | one endpoint at a time, validated live at runtime                        |
| Typed runtime clients (Zodios, ts-rest, …)             | a hand-authored contract | your own retry / auth / rate-limit code around it     | resilience, auth lifecycle, and drift detection built into the primitive |
| Workflow platforms (Windmill, n8n, …)                  | a server to deploy       | flows inside someone else's runtime                   | a zero-dependency library; composition is just code                      |
| Hand-rolled `fetch` wrappers                           | nothing                  | bespoke auth, retries, limits — re-solved per project | the same concerns, declared once per stitch                              |

For the full competitive landscape and positioning, see the [Overview](docs/OVERVIEW.md).

## Features

-   **One primitive, scoped to a surface** - `stitch(url | config)` returns a typed, callable function. One endpoint is a bare `stitch`; **a service with more than one endpoint is a `seam`** — declare the shared base, auth, and throttle budget once, add each endpoint with `.stitch()`, and members share config _and_ runtime (one store, throttle bucket, sink) behind a trusted principal boundary. Lighter, runtime-free sharing — a config fragment, or deriving one stitch from another — is `extends`, with `.with()` partial application on top.
-   **Event-stream core** - every call yields a typed stream (`start → progress → drift → result → done`); `await` is sugar that consumes it and returns the final validated value.
-   **Bring-your-own validation** - validate `params` / `query` / `body` / `headers` and the response with [Zod](https://zod.dev) or any [Standard Schema](https://standardschema.dev) library (Valibot, ArkType, …); TypeScript types are inferred from the schemas.
-   **Leveled drift detection** - live responses are diffed against a committed contract snapshot; changes surface as `error` / `warn` / `info` findings instead of a silent `undefined`.
-   **Declared resilience** - retry with backoff and `Retry-After`, proactive throttle (rate + concurrency, per stitch or per host), and total / per-attempt timeouts with real aborts.
-   **Auth as a boundary** - `bearer`, `apiKey`, `basic`, `cookieSession` (auto-login and re-login), and `oauth2` client credentials; secrets resolve at call time via `env()` / `secretsFile()` and never reach the caller.
-   **Data shaping** - `unwrap` dot-paths, `transform` (e.g. scrape HTML into structure), auto-looping pagination, and `json` / `form` / `multipart` request bodies.
-   **Any request style** - `http` is the default; `graphql`, `sse`, `stream`, and `download` are peer **surfaces**, each a subpath import (`stitchapi/sse`, …) on the same engine — so `import { stitch }` bundles `http` alone.
-   **Pluggable state store** - throttle counters and sessions/tokens live behind a 3-method store; in-memory by default, a shared store makes throttling distributed and sessions shared across workers.
-   **Zero-infra observability** - tracing is **off by default** (a stitch's only effect is its call); opt in per stitch with `trace: 'console'` / `fileSink(path)` / a `TraceSink`, or globally with `STITCH_TRACE_CONSOLE=1` / `STITCH_TRACE_FILE=<path>` / `STITCH_EXPORT=otlp`. `stitch trace` then summarizes runs, retries, drift, and latency percentiles.
-   **CLI, HTTP & MCP surfaces** - the definition your code imports is also runnable from the shell (`stitch run <name>` streams JSONL events), served over HTTP (`stitch serve`), or exposed to agents over MCP (`stitch mcp`) — the same stitch behind every front door.
-   **Typed URLs** - full [RFC 6570](https://datatracker.ietf.org/doc/html/rfc6570) URI templates (`{id}`, `{+path}`, `{?q,sort}`, explode `*`, prefix `:n`), and a `qs`-style query builder that serializes nested objects (`a[b]=c`) and arrays — both dependency-free.
-   **Pluggable transport** - `fetch` by default; drop in the shipped `axiosAdapter`, or any `Adapter` function, to route requests through axios or another HTTP client.
-   **Zero runtime dependencies** - `"dependencies": {}`; built on the platform's global `fetch`; tree-shakeable. The whole entry is **~22 kB min+gzip**; a typical `import { stitch }` trims to **~17 kB** — and with no transitive tree, that is the entire cost.

## Documentation

Deeper docs live in [`docs/`](docs):

-   [**Feature Lenses**](docs/FEATURE-LENSES.md) — the full feature map: every capability grouped by _lens_ (reliability, observability, security, data, …) and family.
-   [**Overview**](docs/OVERVIEW.md) — vision, positioning, competitive landscape, and scope.
-   [**Design**](docs/DESIGN.md) — the technical design and key decisions.

## Installing

Using npm:

```bash
$ npm install stitchapi
```

Using yarn:

```bash
$ yarn add stitchapi
```

Using pnpm:

```bash
$ pnpm add stitchapi
```

Once the package is installed, you can import the library using `import` or `require` approach:

```js
import { stitch } from "stitchapi";
// either
const { stitch } = require("stitchapi");
```

The runtime ships with zero dependencies. Schema validation is bring-your-own — pass a [Zod](https://zod.dev) schema or any [Standard Schema](https://standardschema.dev) validator ([Valibot](https://valibot.dev), [ArkType](https://arktype.io), …); none of them is bundled. The examples below use Zod for familiarity.

**Bundle size.** The whole `stitchapi` entry is **~22 kB minified + gzipped** (~61 kB raw, ~19 kB brotli); because the package is side-effect-free and every surface beyond `http` lives behind its own subpath import, a typical `import { stitch }` tree-shakes to **~17 kB min+gzip**. With zero dependencies, that is the _whole_ cost — there is no transitive tree to install or audit.

## Quick start

The smallest stitch is a URL — declare once, call many times:

```ts
import { stitch } from 'stitchapi';

const getUsers = stitch('https://api.example.com/users');

const users = await getUsers(); // GET, parsed JSON
```

Path params use [RFC 6570](https://datatracker.ietf.org/doc/html/rfc6570) URI templates — simple `{id}` interpolation is the common case, with the full operator set available (`{+reserved}`, `{/segment}`, `{?query,keys}`, explode `{list*}`, prefix `{var:3}`). Template variables are filled from `params`; `params`, `query`, `headers`, and `body` all travel in a single input object:

```ts
const getUser = stitch('https://api.example.com/users/{id}');

await getUser({ params: { id: 1 }, query: { expand: 'roles' } });
// → GET https://api.example.com/users/1?expand=roles
```

The query builder serializes nested objects and arrays `qs`-style — `{ filter: { type: 'admin' }, ids: [1, 2] }` → `filter[type]=admin&ids[0]=1&ids[1]=2`. Query defaults can be baked into the path; call-time query keys merge over them:

```ts
const findUsers = stitch('https://api.example.com/users?sort=name&type=admin');

await findUsers({ query: { type: 'user' } });
// → /users?sort=name&type=user
```

Add an `output` schema and you get TypeScript types, runtime validation, and drift detection in one move:

```ts
import { stitch } from 'stitchapi';
import { z } from 'zod';

const getUser = stitch({
    path: 'https://api.example.com/users/{id}',
    output: z.object({ id: z.number(), name: z.string() }),
});

const user = await getUser({ params: { id: 1 } }); // typed { id: number; name: string }
```

One endpoint is one `stitch`. The moment a service has more than one — sharing a base URL, auth, and a rate budget — model the whole surface as a [seam](#composition--reuse) and add each endpoint as a member; reach for a bare `stitch` only for a genuinely standalone call.

## The event stream

A stitch does not return `Promise<bytes>`. It yields a typed event stream — `await` is sugar that consumes the stream and returns the final, unwrapped, validated `result` (or throws a `StitchError` carrying `.status`, plus `.body` (the parsed error payload) and `.url` (the final request URL) when the failure came from a response):

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
        case 'progress': // { phase: 'auth'|'request'|'throttled'|'retry'|'paginate', attempt, waitedMs? }
            break;
        case 'drift': // { finding: { level: 'error'|'warn'|'info', path, change } }
            break;
        case 'result': // { value, status, attempts }
            break;
        case 'error': // { message, status?, attempts }
            break;
        case 'done': // { ok, ms, attempts }
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

const Website = z.object({ id: z.number(), host: z.string() });

const api = seam({
    baseUrl: 'https://api.example.com',
    retry: { attempts: 3, on: [429, 503] },
    timeout: { total: '30s' },
});

const listWebsites = api.stitch({
    path: '/websites',
    output: Website.array(),
    unwrap: 'data',
});
const getWebsite = api.stitch({ path: '/websites/{id}', output: Website });
```

Reach for `extends` for the lighter cases — sharing a plain config fragment, or deriving one stitch from another — where you want config reuse without a shared runtime. A fragment is just an object; `extends: [...]` merges left→right, with own fields winning last:

```ts
import { stitch } from 'stitchapi';

// A plain fragment — config to merge, no runtime of its own.
const base = {
    baseUrl: 'https://api.example.com',
    retry: { attempts: 3, on: [429, 503] },
};

const listWebsites = stitch({
    extends: [base],
    path: '/websites',
    output: Website.array(),
    unwrap: 'data',
});
```

A stitch is itself a composable value — extend one and override only the diff:

```ts
const getOneWebsite = stitch({
    extends: [listWebsites], // inherits baseUrl + retry + unwrap
    path: '/websites/{id}',
    output: Website,
});
```

Merge semantics: scalars (`path`, `method`, `baseUrl`, `unwrap`) replace; objects (`retry`, `throttle`, `timeout`, `input`) deep-merge; `hooks` chain across layers (`onRequest` runs base→child, the rest unwind child→base).

`.with()` pre-binds part of the input and returns a new stitch that reuses the same runtime — so cookies, tokens, and throttle state persist across the bound and unbound forms:

```ts
const adminSearch = search.with({ query: { role: 'admin' } });

await adminSearch({ query: { q: 'ada' } }); // → /websites?role=admin&q=ada
```

## Validation & leveled drift

Validation is not binary pass/fail. Wrap the `output` schema in `drift()` and every live response is compared against the schema **and** a committed contract snapshot, with each difference classified by level:

| Level     | Trigger                                            | Behavior                         |
| --------- | -------------------------------------------------- | -------------------------------- |
| **error** | a `critical` field went missing or changed type    | fails the call (`error` event)   |
| **warn**  | a watched / non-critical field changed             | `warn` event; the call succeeds  |
| **info**  | a brand-new field appeared that the contract lacks | `info` event — “want to use it?” |

```ts
import { drift, stitch } from 'stitchapi';
import { z } from 'zod';

const listListings = stitch({
    path: 'https://api.example.com/listings',
    output: drift(
        z.array(z.object({ id: z.number(), score: z.number().optional() })),
        {
            critical: ['[].id'], // error when these break — you rely on them
            watch: ['[].score'], // warn when this changes
            onNew: 'info', // level for brand-new fields (default 'info')
            snapshotFile: 'listings.contract.json', // committed baseline
        },
    ),
});
```

The first run records the baseline and reports nothing; later runs emit leveled `drift` events on the stream (array elements are addressed as `[].field`). A silently renamed field — the classic integration breakage — becomes a loud, leveled signal instead of an `undefined` three layers downstream.

The request side validates too. `input` takes a schema per part, and a mismatch fails fast with a `ValidationError` before any request is sent:

```ts
const createUser = stitch({
    method: 'POST',
    path: 'https://api.example.com/users',
    input: { body: z.object({ name: z.string() }) },
    output: z.object({ id: z.number(), name: z.string() }),
});
```

Schemas can be Zod, any [Standard Schema](https://standardschema.dev) validator (Valibot, ArkType, …), or a custom object implementing the tiny `Validator` interface.

## Resilience: retry, throttle, timeout

The things every `src/api/` folder reinvents are configuration here — uniform across every stitch:

```ts
const metadata = stitch({
    baseUrl: 'https://api.example.com',
    path: '/metadata',
    retry: { attempts: 4, on: [429, 502, 503], respectRetryAfter: true },
    throttle: { rate: '1/s', concurrency: 2, scope: 'host' },
    timeout: { total: '30s', perAttempt: '10s' },
});
```

-   **`throttle` is proactive** - a rate (`'1/s'`) and a concurrency cap that keep you under a vendor's limit before it bites; `scope: 'host'` shares one limiter across every stitch hitting the same host.
-   **`retry` is reactive** - `attempts` is the total including the first; retried statuses default to `[429, 502, 503, 504]`; backoff is `'expo'` / `'expo-jitter'` / `'fixed'` with `baseMs` / `maxMs` clamps; `respectRetryAfter` honors the `Retry-After` header (delta-seconds or HTTP-date).
-   **`timeout` aborts** - `total` and/or `perAttempt`, as milliseconds or `'30s'`-style strings, enforced with a real `AbortSignal` instead of a request left hanging.

Throttle waits and retries emit `throttled` / `retry` events on the stream, so the waiting is visible in the trace for free.

## Auth as a boundary

Auth is a field on the stitch (or on a fragment it extends) — never global. Secrets resolve **at call time**: `env()` reads an environment variable, `secretsFile()` reads `~/.stitch/secrets.json` (falling back to env). The stitch declaration is committable, and the caller — your code or an agent — invokes the stitch and gets data without ever seeing the credential.

Header strategies — `bearer`, `apiKey` (default header `x-api-key`), `basic`:

```ts
import { bearer, env, stitch } from 'stitchapi';

const getMovie = stitch({
    path: 'https://api.example.com/movies/{id}',
    auth: bearer(env('API_TOKEN')), // resolved per call; the caller passes no secret
});
```

**OAuth2 client credentials** — `oauth2()` POSTs the token endpoint (form-encoded `client_credentials` grant), caches the access token in the [store](#pluggable-state-store) with the TTL from `expires_in`, refreshes it `refreshSkewMs` (default 30s) before expiry, and attaches it as `Authorization: Bearer …`. A rejected token (status in `refreshOn`, default `[401]`) forces a fresh fetch and an uncounted re-run of the attempt:

```ts
import { env, oauth2, stitch } from 'stitchapi';

const listReports = stitch({
    path: 'https://api.example.com/reports',
    auth: oauth2({
        tokenUrl: 'https://auth.example.com/oauth/token',
        clientId: env('OAUTH_CLIENT_ID'),
        clientSecret: env('OAUTH_CLIENT_SECRET'),
        scope: 'reports:read', // optional, space-delimited
    }),
});
```

Give two stitches the same `key` plus a shared [store](#pluggable-state-store) and they share one token — across stitches, workers, and restarts.

**Cookie sessions** — the marquee case: `cookieSession` runs a login (itself a stitch), captures the cookie from `Set-Cookie`, replays it on every call, and re-logs-in when the wall returns:

```ts
import { cookieSession, env, secretsFile, stitch } from 'stitchapi';

const signIn = stitch({
    method: 'POST',
    baseUrl: 'https://api.example.com',
    path: '/auth/sign-in',
    bodyType: 'form',
});

const listWebsites = stitch({
    baseUrl: 'https://api.example.com',
    path: '/websites',
    unwrap: 'data',
    auth: cookieSession({
        login: signIn,
        cookie: 'session_token', // captured from Set-Cookie, replayed each call
        loginInput: () => ({
            body: {
                email: env('APP_USER')(),
                password: secretsFile('APP_PASS')(),
            },
        }),
        refreshOn: [401], // the wall → re-login, then retry (default)
    }),
});

await listWebsites();
// → logs in, replays the cookie, dissolves the 401 wall on expiry.
//   The caller never saw the password and never wrote the cookie dance.
```

A `200` that is really a login page is a soft wall — catch it with a content predicate:

```ts
auth: cookieSession({
    login: signIn,
    cookie: 'session_token',
    refreshWhen: (res) =>
        typeof res.body === 'string' && /log in/i.test(res.body),
});
```

## Pluggable state store

Throttle counters and session/token state live behind one small seam — a `store` you compose like any other value. The default is in-memory (zero-config, single process). Implement the 3-method interface over Redis/Postgres and, with no change at the call site:

-   **throttle goes distributed** - rate counters are read through the store, so a shared store paces calls across processes;
-   **sessions and tokens are shared** - `cookieSession` / `oauth2` state under the same `key` is reused across stitches and workers, surviving restarts.

```ts
export interface StitchStore {
    get(key: string): Promise<unknown | undefined>;
    set(key: string, value: unknown, ttlMs?: number): Promise<void>;
    incr(key: string, ttlMs: number): Promise<number>; // atomic — rate windows
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
    path: 'https://api.example.com/form',
    bodyType: 'form', // application/x-www-form-urlencoded
});
await submit({ body: { a: 1, b: 'x y' } });

const upload = stitch({
    method: 'POST',
    path: 'https://api.example.com/upload',
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
    path: 'https://api.example.com/users/{id}',
    adapter: axiosAdapter(axios), // body encoding, headers, and parsing match fetchAdapter
});
```

### Per-stitch dispatcher (proxy, custom CA, interface binding)

`fetchAdapter` takes options so you can thread a per-stitch undici **dispatcher** (an `Agent`) into the request — for a proxy, a custom CA, or binding to a specific network interface — without StitchAPI ever importing undici (the runtime stays zero-dependency, so you bring your own `Agent`). It rides through as Node's non-standard `dispatcher` fetch init option:

```ts
import { fetchAdapter, stitch } from 'stitchapi';
import { Agent } from 'undici';

const getUser = stitch({
    path: 'https://api.example.com/users/{id}',
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

| Surface       | Import                        | Shapes                                     | `await` resolves to            |
| ------------- | ----------------------------- | ------------------------------------------ | ------------------------------ |
| `http`        | `stitch` (default)            | a JSON-over-HTTP call                      | the validated body             |
| `graphql`     | `stitchapi/graphql`           | POST `{ query, variables }`, unwrap `data` | the `data` payload             |
| `sse`         | `stitchapi/sse`               | a `text/event-stream` reader (over fetch)  | every parsed event, collected  |
| `stream`      | `stitchapi/stream`            | a raw `ReadableStream` reader              | every decoded chunk, collected |
| `download`    | `stitchapi/download`          | a buffered binary GET                      | `{ blob, filename }`           |
| `llm`         | `stitchapi/llm`               | a chat-completion via a provider contract  | the normalised `{ text, … }`   |
| `shell`       | `@stitchapi/shell` (peer pkg) | a local command, args + stdin              | the command's stdout           |
| `postmessage` | `stitchapi/postmessage`       | a typed iframe ↔ parent RPC / event call  | the typed RPC response         |

(Distinct from the four _invocation_ surfaces — function, CLI, HTTP, MCP — which are how you _call_ a stitch. A request surface is how a stitch shapes its _request_.)

### GraphQL

`graphql()` POSTs `{ query, variables }` and unwraps `data`. A `200` carrying `errors[]` is a failure — it will not silently pass:

```ts
import { graphql } from 'stitchapi';

const getThing = graphql({
    baseUrl: 'https://api.example.com',
    query: 'query ($id: ID) { thing(id: $id) { name } }',
});

const thing = await getThing({ variables: { id: 1 } });
```

### Streaming: `sse` and `stream`

A streaming surface decodes a live response body into `delta` events. `await` collects every chunk into an array; `.stream()` yields them as they arrive and buffers nothing — for an unbounded stream, prefer `.stream()`. `sse` parses the `text/event-stream` wire format over `fetch` + Web Streams (never `EventSource`), yielding one `{ event?, data, id?, retry? }` per event:

```ts
import { sse } from 'stitchapi/sse';

const ticks = sse({ url: 'https://api.example.com/ticks' });

for await (const ev of ticks.stream()) {
    if (ev.type === 'delta') handle(ev.chunk); // a parsed SSE event
}
```

`stream` is the raw sibling — `decode: 'bytes'` (default), `'lines'`, or `'ndjson'`:

```ts
import { stream } from 'stitchapi/stream';

const logs = stream({
    url: 'https://api.example.com/logs',
    stream: { decode: 'ndjson' },
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

const getReport = download({ url: 'https://api.example.com/report.pdf' });

const { blob, filename } = await getReport({
    onProgress: (p) => console.log(p.loaded, '/', p.total),
});
```

### LLM and shell

Two non-HTTP surfaces speak the same engine. `llm` is a chat-completion over a provider _contract_ — the first-party `anthropic` and `openai` mappings are plain config, no SDK dependency, and the credential is the stitch's own `auth`:

```ts
import { apiKey, env } from 'stitchapi';
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

One logical call follows pages until `next` returns `undefined` (or the `max` safety cap, default 50, is hit), aggregating items into a single result. Each page is a full request — auth, retry, and throttle apply per page — and each page emits a `paginate` progress event:

```ts
const listAll = stitch({
    path: 'https://api.example.com/list',
    unwrap: 'data',
    paginate: {
        // previous page's raw body + pages fetched so far → input for the
        // next page (merged over the original), or undefined to stop
        next: (body, fetched) =>
            body.hasMore ? { query: { page: fetched + 1 } } : undefined,
    },
});

const everything = await listAll(); // [...page1, ...page2, ...] as one array
```

When the unwrapped page is not itself the array, pass `items` to pull the array out of each page.

## Transform

`transform` runs before `unwrap` and validation — turn an arbitrary payload (HTML, text, a legacy shape) into structured data, then let `unwrap` + `output` / `drift` treat it like any other contract:

```ts
const search = stitch({
    path: 'https://api.example.com/search',
    transform: (html) => scrape(html), // your parser: HTML/text → { items: [...] }
    unwrap: 'items',
    output: z.array(z.object({ title: z.string(), score: z.number() })),
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

That is per-call latency, status, attempts, throttle waits, and drift findings — recorded for free once you opt in, inspectable with [`stitch trace`](#the-stitch-cli) or plain `jq`. Drift rides the same events, so a leveled drift signal shows up in the trace with no extra wiring. The built-in JSONL and console sinks are safe by default — scrubbing happens at the sink boundary, so the live request is never touched, only the trace copy. Header values on a secret denylist (`authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`; widen it with `redactHeaders`) become `[REDACTED]`; credentials in the resolved URL are scrubbed (userinfo removed, secret query values like `api_key`/`access_token` replaced with `REDACTED`); and request bodies and response values are truncated to 2048 characters, with anything larger replaced by a `{ truncated, bytes, preview }` marker. Opt into full, untruncated capture with `STITCH_TRACE_MAX_BODY=full` (or `fileSink(path, { maxBodyBytes: false })`). Need a custom sink? Consume `.stream()` yourself — the built-in trace is just one consumer of the same events.

## The stitch CLI

One definition, more than one front door: the same stitch your code imports is callable from the shell, no app boot required. Export your stitches from a module (`stitches.ts` by default, `--module <path>` otherwise) and `stitch run` streams every event as one JSON line on stdout — ready for `jq`:

```bash
$ stitch run getUser --id 7 --query.expand roles
{"type":"start","name":"getUser","method":"GET","url":"https://api.example.com/users/7?expand=roles",...}
{"type":"result","value":{"id":7,"name":"Ada"},"status":200,"attempts":1,...}
{"type":"done","ok":true,"ms":142,...}
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

## Scope & roadmap

A stitch is a **per-call primitive**, not a workflow or iPaaS engine. Job queues, inbound webhooks, multi-step orchestration and rollback, business/DB idempotency, and app-level cache policy stay your app's job — absorbing them is exactly how a small library becomes the heavy platform it is positioned against.

The features once staged here have all shipped — the multi-cookie jar, circuit breaker, idempotency keys, and binary/blob responses; OTLP export; the HTTP (`stitch serve`) and MCP (`stitch mcp`) surfaces of the same definition; and the non-HTTP `shell` and `llm` kinds with `pipe()` composition (ADR 0008), so a stitch's output can feed a model or shell call in the same declarative chain, traced end to end. The full roadmap and scope rationale live in the [Overview](docs/OVERVIEW.md).

## License

[Apache-2.0](LICENSE)
