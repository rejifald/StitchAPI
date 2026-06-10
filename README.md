<img src="https://github.com/rejifald/StitchAPI/blob/9c65d767e6e2ecff7e0a7a2922843a7cdc38a0b5/docs/media/logo_baner_light.png?raw=true" alt="StitchAPI Logo Banner"/>

---

> **Status:** v1 runtime, under active development. The shape below is real and runnable; feedback is welcome.

**StitchAPI is an agent-native runtime whose core primitive — a _stitch_ — replaces `fetch`** for both humans and agents.

A stitch is a typed, declarative, composable unit: `input → validated output`, wrapped with auth, retries, throttling, timeouts, lifecycle hooks, and observability. You declare it once and call it many times. The smallest possible stitch is `stitch('https://…')`; every capability beyond that is opt-in.

A stitch is a **per-call primitive, not a workflow / queue / iPaaS engine.** Orchestration, job queues, inbound webhooks, and business state stay your app's job (see [Scope](#scope--what-a-stitch-is-not)). That boundary is the point: absorbing them is how a small library drifts into a heavy platform.

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
![npm bundle size](https://img.shields.io/bundlephobia/minzip/stitchapi)
![Tree Shaking](https://badgen.net/bundlephobia/tree-shaking/stitchapi)

</div>

## Table of Contents

-   [Why a new primitive](#why-a-new-primitive)
-   [Install](#install)
-   [Quick start](#quick-start)
-   [The event stream + `await` sugar](#the-event-stream--await-sugar)
-   [Composition: extends / defineStitch / builder / `.with()`](#composition-extends--definestitch--builder--with)
-   [Validation & leveled drift](#validation--leveled-drift)
-   [Resilience: retry, throttle, timeout](#resilience-retry-throttle-timeout)
-   [Auth as a boundary — capability, not credential](#auth-as-a-boundary--capability-not-credential)
-   [Pluggable store: distributed throttle & shared sessions](#pluggable-store-distributed-throttle--shared-sessions)
-   [Request body encoding](#request-body-encoding)
-   [GraphQL kind](#graphql-kind)
-   [Pagination](#pagination)
-   [Transform (e.g. scrape → structured)](#transform-eg-scrape--structured)
-   [Zero-infra observability](#zero-infra-observability)
-   [Zero dependencies](#zero-dependencies)
-   [Live playground](#live-playground)
-   [Scope — what a stitch is _not_](#scope--what-a-stitch-is-not)
-   [Roadmap](#roadmap)

## Why a new primitive

`fetch` returns bytes. Everything that makes an integration _reliable_ — auth, retries, rate limits, timeouts, response validation, schema-drift detection, observability — is left for you (or an agent) to re-implement at every call site. The result is the `src/api` folder every project grows: dozens of hand-rolled wrappers that each do the bare minimum and rot independently.

A stitch folds those concerns into the call itself:

-   **Progressive disclosure.** Zero-config to start; opt-in depth. `stitch('https://…')` just works; knobs appear only when you reach for them.
-   **Atomic & composable.** A stitch can be exactly one endpoint and nothing else — **no global config is ever required.** Cross-cutting concerns (`baseUrl`, `auth`, `retry`, `throttle`, …) are named, shareable values you compose, not a central config far from the call site.
-   **The stitch is the boundary.** Auth, validation, and observability live _at_ the stitch. An agent receives a **capability** — it calls the stitch and gets typed data — and never sees the secret.
-   **The event stream is the spine.** Streaming output, observability, and drift detection all read the _same_ event stream a stitch emits.
-   **Kind-agnostic core.** HTTP and GraphQL today; the internal interface is built so shell/LLM kinds slot in later as symmetric building blocks.

For the full rationale and scope, see [`docs/DESIGN.md`](docs/DESIGN.md).

## Install

```bash
npm install stitchapi
# or: yarn add stitchapi
# or: pnpm add stitchapi
```

```ts
import { stitch } from 'stitchapi';

// or: const { stitch } = require('stitchapi');
```

StitchAPI ships its runtime with **zero dependencies**. Schema validation is _bring-your-own_ — see [Zero dependencies](#zero-dependencies).

## Quick start

A stitch is defined once and called many times. The smallest one is a URL:

```ts
import { stitch } from 'stitchapi';

const getUsers = stitch('https://api.example.com/users');

const users = await getUsers(); // GET, parsed JSON
```

Path params (RFC 6570-style `{id}`) and query come in via a single input object:

```ts
const getUser = stitch('https://api.example.com/users/{id}');

await getUser({ params: { id: 1 }, query: { expand: 'roles' } });
// → GET https://api.example.com/users/1?expand=roles
```

Add a contract and you get types **and** validation **and** drift detection in one move:

```ts
import { stitch } from 'stitchapi';
import { z } from 'zod';

const getUser = stitch({
    path: 'https://api.example.com/users/{id}',
    output: z.object({ id: z.number(), name: z.string() }),
});

const user = await getUser({ params: { id: 1 } }); // typed { id: number; name: string }
```

## The event stream + `await` sugar

A stitch does **not** return `Promise<bytes>`. It yields a typed event stream — and `await` is sugar that consumes that stream and returns the final, validated, unwrapped `result` (or throws a `StitchError`):

```ts
const users = await getUsers(); // sugar: consume the stream → the result value
```

Consume the stream directly when you want progress, retries, throttling waits, and drift as they happen — it's the same spine that powers observability:

```ts
for await (const ev of getUsers.stream()) {
    switch (ev.type) {
        case 'start': // { name, method, url, input }
        case 'progress': // { phase: 'auth'|'request'|'throttled'|'retry'|'paginate', attempt, waitedMs? }
            break;
        case 'drift': // { finding: { level: 'error'|'warn'|'info', path, change } }
            if (ev.finding.level === 'info')
                console.log('new field:', ev.finding.path);
            break;
        case 'result': // { value, status, attempts }
            render(ev.value);
            break;
        case 'error': // { message, status?, attempts }
        case 'done': // { ok, ms, attempts }
            break;
    }
}
```

## Composition: extends / defineStitch / builder / `.with()`

Everything reusable is a named value, and a stitch composes values. The three authoring facades are thin surfaces over **one** resolved config — pick whichever fits your code, or mix them.

First, define reusable fragments once:

```ts
import { defineStitch, preset, stitch } from 'stitchapi';
import { z } from 'zod';

const api = preset({
    baseUrl: 'https://api.example.com',
    retry: { attempts: 3, on: [429, 503] },
    timeout: { total: '30s' },
});

const Website = z.object({ id: z.number(), host: z.string() });
```

**A — `extends: [...]`** (left→right precedence; own fields win last):

```ts
const listWebsites = stitch({
    extends: [api],
    path: '/websites',
    output: Website.array(),
    unwrap: 'data',
});
```

**B — bound factory `defineStitch(...)`** (best when every stitch shares the same base):

```ts
const apiStitch = defineStitch(api);

const getWebsite = apiStitch({ path: '/websites/{id}', output: Website });
```

**C — fluent builder**:

```ts
const search = stitch
    .use(api)
    .get('/websites')
    .returns(Website.array())
    .unwrap('data');
```

A stitch is itself a composable value — **extend another stitch** and override only the diff:

```ts
const getWebsite = stitch({
    extends: [listWebsites], // inherits base + retry + unwrap
    path: '/websites/{id}', // override
    output: Website, // override
});
```

Merge semantics: scalars (`path`, `method`, `baseUrl`, `unwrap`) **replace**; objects (`retry`, `throttle`, `timeout`, `input`) **deep-merge**; `hooks` **chain** (base runs, then child) so a shared "log + add trace header" base is genuinely composable.

**`.with()`** pre-binds part of the input and returns a new, still-reusable stitch (call-time overrides per field):

```ts
const search = stitch({ path: 'https://api.example.com/search' });
const adminHits = search.with({ query: { role: 'admin' } });

await adminHits({ query: { q: 'ada' } }); // → /search?role=admin&q=ada
```

## Validation & leveled drift

Validation is **not** binary pass/fail. A stitch compares each live response against its `output` schema **and** a committed contract snapshot, and classifies every difference by level:

| Level     | Trigger                                             | Behavior                         |
| --------- | --------------------------------------------------- | -------------------------------- |
| **error** | a field you _rely on_ is missing or changed type    | fails the call / `error` event   |
| **warn**  | a watched, non-critical field changed               | `warn` event; call succeeds      |
| **info**  | a **new** field appeared that isn't in the contract | `info` event — "want to use it?" |

```ts
import { drift, stitch } from 'stitchapi';
import { z } from 'zod';

const listListings = stitch({
    path: 'https://api.example.com/listings',
    output: drift(
        z.array(z.object({ id: z.number(), score: z.number().optional() })),
        {
            critical: ['[].id'], // error if these break — you depend on them
            watch: ['[].score'], // warn if this changes
            onNew: 'info', // surface brand-new fields as info (default)
            snapshotFile: 'listings.contract.json', // committed baseline
        },
    ),
});
```

The snapshot is what makes "a _new_ field appeared" detectable (diff the live shape vs the last-known shape, not just vs the schema). The first run records the baseline and reports nothing; later runs surface leveled `drift` events on the stream. This turns a silently-dropped field — the classic cause of breakage — into a loud, leveled signal instead of an `undefined` three layers deep.

You can also validate the request side. `input` takes a schema per part:

```ts
const createUser = stitch({
    method: 'POST',
    path: 'https://api.example.com/users',
    input: { body: z.object({ name: z.string() }) },
    output: z.object({ id: z.number(), name: z.string() }),
});
```

## Resilience: retry, throttle, timeout

```ts
const metadata = stitch({
    baseUrl: 'https://api.example.com',
    path: '/metadata',
    retry: { attempts: 4, on: [429, 502, 503], respectRetryAfter: true },
    throttle: { rate: '1/s', concurrency: 2, scope: 'host' },
    timeout: { total: '30s', perAttempt: '10s' },
});
```

-   **`throttle`** is _proactive_ — a rate (`'1/s'`) + concurrency cap that keeps you _under_ a vendor's limit, replacing the hand-rolled token buckets integrations write by hand. `scope: 'host'` shares one limiter across every stitch hitting the same host.
-   **`retry`** is _reactive_ — exponential backoff with jitter, honoring `Retry-After` when `respectRetryAfter` is set.
-   **`timeout`** aborts a slow call (`total`, and/or `perAttempt`) instead of hanging.

All three emit events (`throttled`, `retry`) onto the stream, so the waits and retries are visible in the trace for free.

## Auth as a boundary — capability, not credential

Auth is a field on the stitch (or on a fragment it extends), **never global**. The secret resolves at call time from `env()` / `keychain()` — the stitch _declaration_ is committed; the secret is not. A caller (an agent) invokes the stitch and gets data **without ever seeing the credential.**

Header strategies — `bearer`, `apiKey`, `basic`:

```ts
import { bearer, env, stitch } from 'stitchapi';

const getMovie = stitch({
    path: 'https://api.example.com/movies/{id}',
    auth: bearer(env('API_TOKEN')), // resolved per call; the caller passes no secret
});
```

The marquee case — a cookie wall dissolved. `cookieSession` runs a login (itself a stitch), manages the cookie jar, and re-logs-in on the wall:

```ts
import { cookieSession, env, keychain, stitch } from 'stitchapi';

const signIn = stitch({
    method: 'POST',
    baseUrl: 'https://api.example.com',
    path: '/auth/sign-in',
    bodyType: 'form',
});

const listWebsites = stitch({
    baseUrl: 'https://api.example.com',
    path: '/websites',
    output: Website.array(),
    unwrap: 'data',
    auth: cookieSession({
        login: signIn,
        cookie: 'session_token',
        loginInput: () => ({
            body: {
                email: env('APP_USER')(),
                password: keychain('APP_PASS')(),
            },
        }),
        refreshOn: [401], // re-login when the wall returns
    }),
});

await listWebsites();
// → logs in, replays the cookie, retries the 401 wall, returns typed Website[].
//   The caller never saw the password and never wrote the cookie dance.
```

A 200 that is _really_ a login page is a soft wall — pass a content predicate to catch it:

```ts
auth: cookieSession({
    login: signIn,
    cookie: 'session_token',
    refreshWhen: (res) =>
        typeof res.body === 'string' && /log in/i.test(res.body),
});
```

## Pluggable store: distributed throttle & shared sessions

Throttle counters and session/token state are process-local by default. The fix is one small seam — a `store` you compose like any other value. The default is in-memory (zero-config, single process); a Redis/Postgres-backed store makes throttle **distributed** and sessions **persistent & shared across workers**, with no change to the call site.

```ts
export interface StitchStore {
    get(key: string): Promise<unknown | undefined>;
    set(key: string, value: unknown, ttlMs?: number): Promise<void>;
    incr(key: string, ttlMs: number): Promise<number>; // atomic — for rate windows
}
```

```ts
import { defineStitch, memoryStore, preset } from 'stitchapi';

// memoryStore() is the shipped default. Implement the 3-method interface over
// Redis/Postgres to go distributed — same call site, no other change.
const api = defineStitch(preset({ store: memoryStore() }));
```

-   **Throttle** reads/writes its rate counters through the store → a shared store paces calls _across processes_.
-   **Auth** (`cookieSession`) reads/writes the cookie jar through the store → give two stitches the same `cookieSession({ key })` plus a shared `store` and they **share one session**, surviving restarts.

You opt into a real store only when you scale out — progressive disclosure applied to state.

## Request body encoding

`bodyType` controls request encoding (`'json'` default, `'form'`, `'multipart'`):

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
    bodyType: 'multipart', // multipart/form-data, with a named file part
});
await upload({
    body: { field: 'v', file: { value: bytes, filename: 'a.bin' } },
});
```

## GraphQL kind

`graphql()` is a stitch preset for GraphQL-over-HTTP: it `POST`s `{ query, variables }` and unwraps `data`. A 200 that carries `errors[]` is treated as a failure.

```ts
import { graphql } from 'stitchapi';

const getThing = graphql({
    baseUrl: 'https://api.example.com',
    query: 'query($id: ID) { thing(id: $id) { name } }',
});

const thing = await getThing({ variables: { id: 1 } });
```

It composes with everything else — `auth`, `throttle`, `retry`, `output`/`drift` all apply, because under the hood it's just a stitch.

## Pagination

One logical call follows pages until `next` returns `undefined` (or `max` is hit), aggregating items into a single result. Each page is a **full request**, so auth / retry / throttle apply per page, and a `paginate` progress event fires for each.

```ts
const listAll = stitch({
    path: 'https://api.example.com/list',
    unwrap: 'data',
    paginate: {
        // given the previous page's raw body + how many pages were fetched,
        // return the input for the next page, or undefined to stop
        next: (body, fetched) =>
            body.hasMore ? { query: { page: fetched + 1 } } : undefined,
        max: 50, // safety cap (default 50)
    },
});

const everything = await listAll(); // [...page1, ...page2, ...] as one array
```

## Transform (e.g. scrape → structured)

`transform` runs **before** unwrap and validation — turn an arbitrary payload (HTML, text, a legacy shape) into structured data, then let `unwrap` + `output`/`drift` treat it like any other contract:

```ts
const search = stitch({
    path: 'https://api.example.com/search',
    transform: (html) => scrape(html), // your parser: HTML/text → { items: [...] }
    unwrap: 'items',
    output: z.array(z.object({ title: z.string(), score: z.number() })),
});
```

Pair this with `drift` and a renamed HTML selector that silently drops a field becomes a fatal contract error instead of a quiet data loss.

## Zero-infra observability

Observability is a **consumer of the event stream**, not a separate system — you never need infra to get insight. Every run is recorded as JSONL with no configuration:

```bash
# every event of every run, appended as JSONL — zero infra
cat ~/.stitch/runs/proto.jsonl

# opt into a live, pretty, one-line-per-event trace on stderr
STITCH_TRACE_CONSOLE=1 node app.js

# choose where the JSONL goes
STITCH_TRACE_FILE=./run.jsonl node app.js
```

You instantly have per-call latency, status, retry counts, throttle waits, and drift flags. Because drift and observability read the same events, a leveled drift signal shows up in the trace for free. For a custom sink, `createTrace` is exported. (An OTLP/Langfuse bridge and a terminal trace viewer are on the [roadmap](#roadmap).)

## Zero dependencies

The runtime ships with **`"dependencies": {}`** — nothing is pulled into your tree, and it's tree-shakeable. Schema validation is _bring-your-own_: pass a [Zod](https://zod.dev) schema, any [Standard Schema](https://standardschema.dev) validator ([Valibot](https://valibot.dev), [ArkType](https://arktype.io)), a plain `Validator`, or a predicate. None of them is bundled — you depend only on the validator you already use. The examples here use Zod for familiarity.

## Live playground

A separate, runnable showcase streams the stitch event stream to the browser **live** over SSE — every feature above against a behavior-simulating mock backend, no build step:

```bash
bash playground/run.sh   # → http://localhost:5174
```

See [`playground/README.md`](playground/README.md) for how it's wired.

## Scope — what a stitch is _not_

A stitch is a **per-call primitive**, not a platform. These stay your app's concern — absorbing them is exactly how StitchAPI would become the heavy engine it's positioned against:

-   job queues and scheduling
-   inbound webhooks
-   multi-step orchestration / broad fan-out
-   business/DB idempotency and multi-step rollback or compensation
-   app-level response-cache policy and business state

See [`docs/DESIGN.md`](docs/DESIGN.md) §12 for the validated coverage analysis.

## Roadmap

Built today: HTTP + GraphQL kinds; composition (`extends` / `defineStitch` / builder / `.with()`); the event stream + `await`; validation + leveled drift; retry / throttle / timeout; auth (`bearer` / `apiKey` / `basic` / `cookieSession` + content-aware refresh); pluggable store; form/multipart encoding; static headers; transform; pagination; zero-infra JSONL trace.

Next, in leverage order: OAuth2 `client_credentials`; multi-cookie jar; binary/blob responses; circuit breaker + idempotency keys; OTLP export + a terminal trace viewer; the four surfaces (CLI / HTTP / MCP) of one definition; then shell → LLM kinds and `pipe()` composition.

## License

[Apache-2.0](LICENSE)
