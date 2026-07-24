# StitchAPI — Design (v1 working draft)

> **Status:** working draft · 2026-06. This is a basis for discussion, not a frozen spec.
> Items are tagged **[decided]**, **[proposed]** (my recommendation, open to change), or **[open]** (needs your call).
> Code is illustrative — names and exact shapes are up for debate. The point is to judge _ergonomics_.

---

## 1. What StitchAPI is

StitchAPI **turns any API into a typed, resilient function** — _API stitching_. Its core primitive, a _stitch_, takes one endpoint and hands back a callable; `fetch`/axios are pluggable adapters underneath, not something it replaces. It is agent-native by the same move: the callable a human imports is the one an agent invokes.

A stitch is a typed, declarative, composable unit: `input → validated output`, wrapped with auth, retries, throttling, timeouts, lifecycle hooks, and observability. The primitive is **kind-agnostic** — today an HTTP call, later a GraphQL query, a shell script, or an LLM call, all treated as symmetric building blocks that compose into bigger stitches.

**Why now / why us.** Two market quadrants are empty:

-   **Spec-less long tail** — every serious competitor (Massimo, Orval, Speakeasy, Stainless) needs an OpenAPI spec. A stitch needs one endpoint or one example.
-   **Heterogeneous + agent-native** — the closest competitor, **Windmill**, is ~85% there but is a heavy server _platform_ that treats HTTP/LLM as "just code." We are a **lightweight library** where HTTP/GraphQL/shell/LLM are symmetric _declared primitives_, consumed natively by agents.

**What it's not.** A stitch is a _per-call primitive_, not a workflow / queue / iPaaS engine. Orchestration, job queues, inbound webhooks, app-level caching, and business state stay the app's job — see the scope boundary in §12. Absorbing them is exactly how we'd drift into the heavy platform we're positioned against.

---

## 2. Principles

1. **Progressive disclosure.** Zero-config to start; opt-in depth. `stitch('https://…')` just works. Every capability (validation, auth, retries, observability, streaming) has a sane default and reveals knobs only when you reach for them. _Simple to begin, opportunistic about what's possible._
2. **Atomic stitches.** A stitch is fully self-contained. It can be exactly one endpoint and nothing else. **No global config is ever required.**
3. **Composition over configuration.** Cross-cutting concerns (baseUrl, auth, pick, retry, throttle, timeout, hooks) are **named, shareable values** you compose — not a central config object far from the call site.
4. **The stitch is the boundary.** Auth, validation, and observability live _at_ the stitch. Agents receive **capabilities, not credentials** — they call a stitch and get data without ever seeing the secret.
5. **One definition, many surfaces.** The same stitch is callable as an in-process function, a CLI command, an HTTP endpoint, and an MCP/agent tool.
6. **The event stream is the spine.** Streaming output, observability, and drift detection all read the _same_ event stream a stitch emits.
7. **Kind-agnostic core.** HTTP first, but the internal interface is built so GraphQL/shell/LLM slot in later without touching the core. **[v1: HTTP only, abstraction-ready]**
8. **Browser-first.** **[decided]** If `fetch` runs there, a stitch runs there. The call path stays free of `node:*` imports and unguarded `process.env` reads; Node-only conveniences (file trace sink, keychain/secrets file, CLI/serve/MCP) sit behind platform seams or separate entry points and no-op explicitly — never crash — in the browser.
9. **Pay only for what you import.** **[decided]** FE bundles pay per byte, so the import graph is part of the API: the core entry pulls the engine and nothing else; surfaces, adapters, stores, and sinks ship as subpath exports; tree-shakeability is enforced (`sideEffects: false` + a CI size budget), not assumed.
10. **Contract, not dependency.** **[decided]** Redis is not the only KV store, `fetch` not the only transport, Zod not the only validator — core commits to no vendor. It ships contracts plus platform defaults (`fetchAdapter`, `memoryStore`, console/JSONL sinks); vendor-shaped code lives in separate packages with the vendor SDK as a peer dependency; every seam ships a conformance kit (`stitchapi/testing`) so third-party implementations prove compliance in their own CI; seam interfaces evolve additively within a major.
11. **Declarative spelling.** **[decided]** Every capability has a JSON-serializable spelling; function-valued config (hooks, `transform`, predicates) is sugar, never the only way in. An agent cannot emit a closure — a stitch that round-trips as data is what agent authoring, the registry, spec export, and inference-from-example stand on.
12. **No side effects by default.** **[decided]** A stitch's call is its only effect on the world. The state it keeps — throttle buckets, cookie jar, token cache, circuit-breaker counters — is in-memory and process-local, gone when the process exits; nothing is persisted or shared across workers, and no trace is written, unless you opt in. A `store` makes throttle distributed and sessions persistent/shared (§13); `trace: 'console'` / a `fileSink` turns observability on (§9). Persistence and sharing are deliberate, never silent — progressive disclosure applied to durability.

---

## 3. Anatomy of a stitch

```ts
const listWebsites = stitch({
    kind: 'http', // [decided] default; future: 'graphql' | 'shell' | 'llm'
    method: 'GET', // default GET
    baseUrl: env('API_BASE'),
    path: '/api/websites',

    input: { query: WebsiteQuery }, // schemas for params / query / body / headers
    output: Website.array(), // response contract → types + validation + drift
    pick: 'data', // pluck the payload

    auth: session, // a co-located auth strategy value (§5)
    retry: { attempts: 3, on: [429, 503] },
    throttle: { rate: '4/s', concurrency: 2 },
    timeout: { total: '30s' },
    hooks: { onRequest, onResponse, onError, onRetry },
});
```

Everything except a target is optional. Spell the target one of two ways:

-   **`url`** — the whole endpoint as one string (`url: 'https://api.example.com/users/{id}'`). The **atomic spelling**: reach for it when a stitch is exactly one endpoint with no base to share, so you don't pre-split into base + path for a composition that doesn't exist. Templated (`{param}`, including the host) and `?query`-aware just like `path`, and may be a function for lazy/env resolution.
-   **`baseUrl` + `path`** — a shareable base joined to a per-endpoint path. The **composition spelling**: a shared fragment supplies `baseUrl` once and each stitch supplies its own `path` (§4).

The two are mutually exclusive — when both appear, `url` wins. The smallest possible stitch is `stitch('https://…')` (a bare string is shorthand for `path`; an absolute one resolves as-is). A target that resolves to a relative URL (a `path` with no `baseUrl`) is a config error under the default transport.

### URL templates & query **[decided]**

The target is an [RFC 6570](https://datatracker.ietf.org/doc/html/rfc6570) URI template, expanded dependency-free (a faithful port of `url-template` v3): simple `{id}` is the common case, with the full operator set available — `{+reserved}`, `{#fragment}`, `{.label}`, `{/segment}`, `{;path}`, `{?query,keys}`, `{&continuation}` — plus the explode (`{list*}`) and prefix (`{var:3}`) modifiers. **Template variables are filled from `params`** (the path-scoped bucket); the `query` input carries the query string, so the two never double-encode a value.

Query values serialize `qs`-style and dependency-free: nested objects expand to `a[b]=c`, arrays to indexed keys (`ids[0]=1&ids[1]=2`), with brackets percent-encoded exactly as `qs` does by default. A literal `?a=b` baked into `path`/`url` is parsed as predefined defaults that call-time `query` keys merge over. (The array serialization format is fixed for now — see [§15](#15-open-questions).)

### Call convention **[decided]**

A stitch is called with a **single `input` object** and returns a value that is both awaitable _and_ streamable:

```ts
const sites = await listWebsites(); // GET, no input
const one = await getWebsite({ params: { id: 1 } }); // path params
const made = await createSite({ body: draft }); // POST body

for await (const ev of listWebsites.stream()) {
    /* §8 */
}
```

A stitch is **defined once and called many times** — it _is_ a reusable function, so calling it with different inputs covers "create once, reuse with different params" directly. To _pre-bind_ some inputs and supply the rest later, **`.with()`** returns a new stitch with those inputs merged in as defaults (call-time overrides per field):

```ts
const search = stitch({ path: '/search', input: { query: SearchQuery } });
const adminHits = search.with({ query: { role: 'admin' } }); // specialized, still reusable
await adminHits({ query: { q: 'ada' } }); // → /search?role=admin&q=ada
```

`.with()` binds `params`, `query`, `body`, or `headers`, and its result is itself a stitch (composes/extends like any other). A **curried** calling form is also available as an opt-in adapter (`stitch.curried(...)`) for stylistic preference, but `.with()` is the more general, recommended tool.

---

## 4. Composition & inheritance · the reuse model

The tension: stitches must stay **atomic** (no global config) _and_ let you DRY out `baseUrl` / `auth` / `retry` / etc. Resolution: **everything reusable is a named value, and a stitch composes values.** The ergonomic variants below are thin facades over one canonical resolved config. One engine, two authoring surfaces.

First, the reusable fragments — plain values you define once and import:

```ts
const base = {
    // a bundle of defaults
    baseUrl: env('API_BASE'),
    retry: { attempts: 3, on: [429, 503] },
    timeout: { total: '30s' },
};

const session = cookieSession({
    // an auth strategy (§5)
    login: signIn, // ← another stitch
    cookie: 'session_token',
    secret: keychain('app'),
    refreshOn: [401],
});
```

### Variant A — `extends: [...]` **[supported]**

```ts
const listWebsites = stitch({
    extends: [base, session], // left→right precedence; own fields win last
    path: '/api/websites',
    output: Website.array(),
    pick: 'data',
});
```

### Variant B — a `seam` (a surface every stitch belongs to)

Best when _every_ stitch in a service shares the same base + auth — and should also
share **runtime** (one store, throttle bucket, sink) and a trusted principal boundary:

```ts
const api = seam({ extends: [base, session] }); // members inherit config + share runtime

const listWebsites = api.stitch({
    path: '/api/websites',
    output: Website.array(),
});
const getWebsite = api.stitch({ path: '/api/websites/{id}', output: Website });
```

### Extending another stitch

A stitch is itself a composable value — inherit one and override the diff:

```ts
const getWebsite = stitch({
    extends: [listWebsites], // inherits base + auth + retry + pick
    path: '/api/websites/{id}', // override
    output: Website, // override
});
```

### Merge semantics **[proposed]**

-   **Scalars** (`path`, `method`, `baseUrl`, `url`, `pick`): replace. The endpoint is one slot: `url` and `baseUrl`/`path` are mutually exclusive, so the last fragment to set either spelling wins it whole — a child `url` clears an inherited `baseUrl`/`path`, and a child `baseUrl`/`path` clears an inherited `url`.
-   **Objects** (`retry`, `throttle`, `timeout`, `input`, auth options): deep-merge field-wise.
-   **`hooks`**: **chain**, don't replace — base `onRequest` runs, then child's; `onResponse` unwinds child→base (middleware order). This is what makes a base like "always log + add trace header" actually composable.
-   **`output` / contracts**: replace (a child declares its own); compose explicitly with `schema.merge(...)` when you want to extend.

---

## 5. Auth — inferred, co-located, capability-not-credential

**Co-located [decided].** Auth is a field on the stitch (or on a fragment it extends). Never global. An atomic one-endpoint stitch carries its own auth.

**Inferred by default [proposed].** If you don't specify `auth`, StitchAPI infers a common strategy from signals:

-   an `Authorization: Bearer …`/`X-Api-Key` header in the example/curl you stitched from → Bearer/API-key, value resolved from a matching `*_TOKEN` / `*_API_KEY` env var;
-   a `Set-Cookie` from a provided login example → cookie session;
-   an OAuth2 token endpoint + client id/secret in env → client_credentials.

Inference is always overridable. (Progressive disclosure: it usually "just works"; you configure only when it can't guess.)

**Explicit strategies [proposed]:** `bearer()`, `apiKey()`, `basic()`, `cookieSession()`, `oauth2()` — each a value you can name, share, and `extends`.

**The boundary — the selling point.** The secret resolves at call time from `env()` / `secretsFile()` / a secret manager. The stitch **declaration** is committed; the secret is not. So:

```
Agent today:  GET /api/websites  →  401 (httpOnly cookie wall)  →  dead end.

Agent with a stitch:
  stitch run list-websites
    → runtime runs `signIn`, manages the cookie jar, retries on 401,
      validates the response, returns typed Website[].
  The agent got the data. It never saw the password.
  It never implemented the cookie dance.   →  capability, not credential.
```

This is a concrete cookie wall (`GET /api/websites` needs a `session_token` cookie) dissolved — and it generalizes to any cookie login, header-based `ApiKey`, or bespoke token-header integration.

---

## 6. Resilience — retry, throttle, timeout

```ts
retry:    { attempts: 3, backoff: 'expo+jitter', on: [429, 503], respectRetryAfter: true },
throttle: { rate: '1/s', concurrency: 2, pool: 'host' },   // proactive limiter
timeout:  { total: '30s', perAttempt: '10s' },
```

-   **`throttle`** is _proactive_ — a token-bucket/concurrency cap to stay _under_ a vendor's limit (replaces the hand-rolled 1/s buckets and per-request delays integrations write by hand). `pool: 'host'` shares one limiter across all stitches hitting the same host.
-   **`retry`** is _reactive_ — backoff+jitter, honoring `Retry-After`.
-   All emit events (`retry`, `throttled`) onto the stream → visible in the trace for free.

---

## 7. Validation & drift — schema-anchored (ADR 0015)

Validation is **not** binary pass/fail, and it needs **no snapshot**. The declared `output` schema _is_ the contract. A stitch validates each live response against it (returning the validated value — coerced, defaulted, unknown keys stripped) and then **diffs the raw body against that validated value**; the delta is the drift:

| Change         | Trigger                                                        | Level (default) | Behavior                     |
| -------------- | -------------------------------------------------------------- | --------------- | ---------------------------- |
| **invalid**    | a required field is missing or incompatible                    | `error`         | **throws** (`STITCH_DRIFT`)  |
| **coerced**    | the schema coerced a value (`"42"`→`42`) — a hidden wire shift | `warn`          | `drift` event; call succeeds |
| **undeclared** | the response carried a key the schema strips                   | `info`          | `drift` event; call succeeds |
| **defaulted**  | a `.default()` fired because the field was absent              | `verbose`       | `drift` event; call succeeds |

```ts
output: drift(Torrent, {
  ignore: ['meta', '_debug'],      // acknowledged, unconsumed fields — never reported
  severity: { coerced: 'info' },   // re-level a kind; or pass a level / list to filter
}),
```

Severity lives in the **schema**, not a parallel `critical`/`watch` system: make a field required and its loss throws (`invalid`); make it `.optional()`/`.nullable()` and that variance validates clean and is never drift. Soft drift is always non-fatal; `severity` (a level, list, or per-kind map) filters or re-levels it, and `ignore` silences known-but-unconsumed paths. All drift becomes events on the stream → console/JSONL/OTLP. (Author-contract drift in fields you don't declare needs a published spec or observation, deliberately out of scope — see ADR 0015.)

This directly answers the "I care about some fields, not others, but still want to know" need — and turns a silent HTML-scrape breakage into a loud, leveled signal.

---

## 8. The event model — the streaming spine

A stitch does **not** return `Promise<bytes>`. It yields a typed event stream:

```ts
type StitchEvent<T> =
  | { type: 'start';    input; meta }
  | { type: 'progress'; phase: 'auth'|'request'|'throttled'|'retry'|'paginate'; ... }
  | { type: 'delta';    chunk }          // streamed body / LLM tokens (future kinds)
  | { type: 'drift';    level: 'error'|'warn'|'info'; path; change }
  | { type: 'result';   value: T }        // validated, unwrapped
  | { type: 'error';    error }
  | { type: 'done';     timing; usage };
```

One shape generalizes **HTTP progress/pagination** _and_ (future) **LLM token streaming** — "more direct streaming than `fetch`." The `await` form is sugar that consumes the stream and returns the `result` value (or throws on `error`).

---

## 9. Observability — zero-infra, opt-in depth

> _Off by default; one flag from console or JSONL, one more for OTLP. You never need infra to get insight — but you never pay for it unasked either (no side effects by default, §2)._

Observability is a **consumer of the event stream**, not a separate system — and, like all state, it is **off until you opt in**:

-   **Off by default (zero infra):** a stitch traces nothing. Turn it on per stitch with `trace: 'console'` (colored stderr) or `trace: fileSink('runs.jsonl')` (JSONL on disk), or globally with `STITCH_TRACE_CONSOLE=1` / `STITCH_TRACE_FILE=<path>`. Either way you instantly have per-vendor latency, error rate, retry counts, throttle waits, and drift flags.
-   **Local viewer (zero infra):** `stitch run --trace` records the JSONL file (off without the flag — the CLI honors the same no-side-effects default), and `stitch trace` / `stitch top` reads it → p99, error rate, drift timeline, in your terminal.
-   **Opt-in bridge:** `STITCH_EXPORT=otlp` fans the _same_ events to Jaeger/Grafana/Langfuse when you have them, using OTel `http.*` semantic conventions.

---

## 10. The four surfaces

One definition, four front doors:

| Surface      | How                               | For                                                                    |
| ------------ | --------------------------------- | ---------------------------------------------------------------------- |
| **Function** | `await listWebsites()`            | your app; another agent's code-mode sandbox                            |
| **CLI**      | `stitch run list-websites --id 1` | shell scripts & agents — JSONL output, pipeable, no app boot           |
| **HTTP**     | `stitch serve`                    | remote/other-language callers                                          |
| **MCP**      | `stitch mcp`                      | one code-mode tool (`run_stitch`) — avoids one-tool-per-endpoint bloat |

---

## 11. Usage cookbook — all the variants

The point of this section: judge convenience across the full range, simplest → richest.

**1. Dead simple (parity with today)**

```ts
const users = stitch('https://reqres.in/api/users');
console.log(await users());
```

**2. Path params + query**

```ts
const user = stitch('https://reqres.in/api/users/{id}');
await user({ params: { id: 1 }, query: { expand: 'roles' } });
```

**3. Add a contract → get types + validation + drift**

```ts
const users = stitch({
    url: 'https://reqres.in/api/users',
    output: User.array(),
    pick: 'data',
});
const list = await users(); // typed User[]; drift-checked
```

**4. POST with a body contract**

```ts
const createUser = stitch({
    method: 'POST',
    path: '/api/users',
    input: { body: NewUser },
    output: User,
});
await createUser({ body: { name: 'Ada' } });
```

**5. Shared base via `extends`**

```ts
const api = { baseUrl: env('API_BASE'), retry: { attempts: 3 } };
const listWebsites = stitch({
    extends: [api],
    path: '/api/websites',
    output: Website.array(),
});
```

**6. A seam (every stitch shares base, auth, AND runtime)**

```ts
const s = seam({ extends: [api, session] });
const listWebsites = s.stitch({
    path: '/api/websites',
    output: Website.array(),
});
const getWebsite = s.stitch({ path: '/api/websites/{id}', output: Website });
```

**7. Extend another stitch**

```ts
const getWebsite = stitch({
    extends: [listWebsites],
    path: '/api/websites/{id}',
    output: Website,
});
```

**8a. Auth inferred (Bearer from env)**

```ts
// API_TOKEN in env → inferred Bearer, no auth config needed
const movie = stitch('https://api.example.com/v3/movie/{id}');
```

**8b. Auth explicit — the agent auth-wall case**

```ts
const signIn = stitch({
    method: 'POST',
    path: '/api/auth/sign-in/email',
    baseUrl: env('API_BASE'),
    input: { body: Credentials },
    captures: { cookie: 'session_token' },
});
const listWebsites = stitch({
    extends: [api],
    path: '/api/websites',
    output: Website.array(),
    pick: 'data',
    auth: cookieSession({
        login: signIn,
        cookie: 'session_token',
        secret: secretsFile('app'),
        refreshOn: [401],
    }),
});
await listWebsites(); // logs in, manages cookie, retries wall, returns Website[]
```

**9. Resilience (replaces hand-rolled per-provider limiters)**

```ts
const metadata = stitch({
    baseUrl: env('METADATA_API'),
    path: '/graphql', // (graphql kind: future)
    throttle: { rate: '1/s' },
    retry: { attempts: 4, on: [429, 502, 503] },
});
```

**10. Streaming consumption**

```ts
for await (const ev of listWebsites.stream()) {
    if (ev.type === 'progress' && ev.phase === 'retry') log('retrying…');
    if (ev.type === 'drift' && ev.level === 'info') log('new field:', ev.path);
    if (ev.type === 'result') render(ev.value);
}
```

**11. Drift levels**

```ts
const listings = stitch({
    baseUrl: env('SEARCH_API'),
    path: '/search',
    // `id` required in the schema → its loss throws; soft drift is leveled here
    output: drift(Listing.array(), {
        ignore: ['[].meta'], // acknowledged, unconsumed
        severity: { coerced: 'info' }, // re-level a kind (or a level/list to filter)
    }),
});
```

**12. Observability (off by default; opt in with `--trace`)**

```bash
stitch run list-websites --trace  # records ~/.stitch/runs/*.jsonl for `stitch trace`
stitch trace --since 1h           # p99, error rate, drift timeline — no infra
stitch run list-websites --trace=console          # stream events to stderr instead
STITCH_EXPORT=otlp stitch serve   # opt-in: same events → Grafana/Jaeger/Langfuse
```

**13. The four surfaces of one stitch**

```bash
stitch run list-websites          # CLI
stitch serve --port 8787          # HTTP   → POST /stitch/list-websites
stitch mcp                        # MCP    → run_stitch tool for agents
```

**14. (Future kinds — abstraction-ready, not in v1)**

```ts
const enrich = pipe(
    stitch({ kind: 'http', path: '/api/movie/{id}' }),
    stitch({
        kind: 'llm',
        prompt: 'Summarize this movie in one line: {{input}}',
    }),
); // one composed stitch; same auth/retry/observability machinery
```

---

## 12. Coverage & scope — validated against two real apps

Two production apps (brand-neutral here) were audited end to end to test fit:

-   **An auth-gated SaaS** — a cookie-walled API plus a domain registrar (Bearer), an SMS gateway (OAuth2 client_credentials), and currency feeds.
-   **A multi-provider aggregator** — a GraphQL API (ApiKey + 1/s bucket), a cookie-session download client (403→relogin), a multi-cookie HTML-scrape tracker (drift-prone), a Bearer REST API, and two media servers with bespoke token headers.

A stitch is a **per-call primitive**, so the audit splits into three buckets.

**Covered today (replaces hand-rolled code in both):** auth header injection (bearer/apikey/basic), cookie login + re-login on status, **content-aware "soft-auth" refresh** (a 200 that is really a login page), retry + `Retry-After`, in-process throttle (rate + concurrency), timeout/abort, form/multipart encoding, validation + leveled drift, HTML-scrape transform, GraphQL, static headers.

**Planned additions (in scope, mostly additive):**
| Addition | Why |
|---|---|
| **Pluggable state store** ⭐ | throttle + session/token state are in-memory; a `store` interface (in-memory default; Redis/Postgres adapter) turns _distributed rate-limiting_ and _persistent/shared sessions_ into a config choice. See §13. |
| Pagination | auto-loop cursor/offset/Link; neither app has a generic one. |
| OAuth2 `client_credentials` | token fetch + cache + expiry refresh, as an auth strategy. |
| Multi-cookie jar | capture the full Set-Cookie set, not one named cookie. |
| Binary/blob responses (+ stream) | arraybuffer/stream return for downloads. |
| Circuit breaker · idempotency keys · OTLP export | resilience + the observability bridge (both apps already run OTel). |

**Out of scope — a stitch is not a platform:** job queues, inbound webhooks, business/DB idempotency, multi-step rollback/compensation, app-level response-cache policy, broad fan-out orchestration. These stay app concerns; absorbing them is how StitchAPI would become the heavy platform it's positioned against (§1).

**Verdict:** covers ~80–90% of what both apps reinvent at the integration layer, with a bounded, mostly-additive list for the rest.

---

## 13. State & stores (pluggable) [proposed]

The two gaps both audits flagged _critical_ — distributed rate limiting and persistent/shared sessions — are the same question: **where does a stitch's state live?** Today it's process-local. The fix is one small seam:

```ts
interface StitchStore {
    get(key: string): Promise<unknown | undefined>;
    set(key: string, value: unknown, ttlMs?: number): Promise<void>;
    incr(key: string, ttlMs: number): Promise<number>; // atomic — for rate windows
}

const api = seam({
    store: redisStore(fromIoredis(redis)), // default is an in-memory store
});
```

-   **Throttle** reads/writes its rate counters through the store → a Redis-backed store gives _cross-process_ rate limiting with no change to the call site.
-   **Auth** (`cookieSession`, future `oauth2`) reads/writes the cookie jar / token through the store → sessions & tokens **survive restarts and are shared across workers**.

Default is in-memory (zero-config, single process). You opt into Redis/Postgres only when you scale out — progressive disclosure (§2) applied to state.

---

## 14. Roadmap (phasing)

Built (now in `src/`): HTTP + GraphQL kinds; config + composition; event-stream + await; validation + leveled drift; retry/throttle/timeout; auth (bearer/apikey/basic/cookieSession + content-aware refresh); form/multipart; static headers; transform; zero-infra trace.

Next, to close the validated gaps (§12), in leverage order:

1. **Pluggable state store** (§13) — unlocks distributed throttle + persistent/shared sessions in one move.
2. **Pagination** (auto-loop).
3. **OAuth2 `client_credentials`** auth strategy.
4. **Multi-cookie jar** for `cookieSession`.
5. **Binary/blob responses.**
6. **Circuit breaker · idempotency keys.**
7. **Depth:** OTLP export; the four surfaces (CLI/HTTP/MCP); Mermaid-from-definition.
8. **Kinds:** shell → LLM; `pipe()` composition.

---

## 15. Open questions

-   ~~Composition syntax / call convention~~ — **resolved**: the composition facades supported (extends + `seam` for a whole shared surface); call = single-input-object + `.with()` + optional curried.
-   **Validation lib** — move from Zod-locked to **Standard Schema** (Zod/Valibot/ArkType)? (Recommended; affects bundle size.)
-   **Secret resolvers** — which to ship first: `env()`, `secretsFile()`, cloud secret managers?
-   **Query array format** — arrays currently serialize `qs`-style indexed (`ids[0]=1&ids[1]=2`), matching the pre-rebuild baseline. Should the format be configurable (`arrayFormat: 'indices' | 'brackets' | 'repeat'`), and which is the right default for the APIs we target? (Flagged for future review; behavior is fixed until then.)
-   **Visual** — Mermaid-from-definition first; how important is the live interactive trace view for v1?
