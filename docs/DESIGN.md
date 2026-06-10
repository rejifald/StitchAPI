# StitchAPI — Design (v1 working draft)

> **Status:** working draft · 2026-06. This is a basis for discussion, not a frozen spec.
> Items are tagged **[decided]**, **[proposed]** (my recommendation, open to change), or **[open]** (needs your call).
> Code is illustrative — names and exact shapes are up for debate. The point is to judge *ergonomics*.

---

## 1. What StitchAPI is

StitchAPI is **an agent-native runtime whose core primitive — a _stitch_ — replaces `fetch`** for both humans and agents.

A stitch is a typed, declarative, composable unit: `input → validated output`, wrapped with auth, retries, throttling, timeouts, lifecycle hooks, and observability. The primitive is **kind-agnostic** — today an HTTP call, later a GraphQL query, a shell script, or an LLM call, all treated as symmetric building blocks that compose into bigger stitches.

**Why now / why us.** Two market quadrants are empty:
- **Spec-less long tail** — every serious competitor (Massimo, Orval, Speakeasy, Stainless) needs an OpenAPI spec. A stitch needs one endpoint or one example.
- **Heterogeneous + agent-native** — the closest competitor, **Windmill**, is ~85% there but is a heavy server *platform* that treats HTTP/LLM as "just code." We are a **lightweight library** where HTTP/GraphQL/shell/LLM are symmetric *declared primitives*, consumed natively by agents.

---

## 2. Principles

1. **Progressive disclosure.** Zero-config to start; opt-in depth. `stitch('https://…')` just works. Every capability (validation, auth, retries, observability, streaming) has a sane default and reveals knobs only when you reach for them. *Simple to begin, opportunistic about what's possible.*
2. **Atomic stitches.** A stitch is fully self-contained. It can be exactly one endpoint and nothing else. **No global config is ever required.**
3. **Composition over configuration.** Cross-cutting concerns (baseUrl, auth, unwrap, retry, throttle, timeout, hooks) are **named, shareable values** you compose — not a central config object far from the call site.
4. **The stitch is the boundary.** Auth, validation, and observability live *at* the stitch. Agents receive **capabilities, not credentials** — they call a stitch and get data without ever seeing the secret.
5. **One definition, many surfaces.** The same stitch is callable as an in-process function, a CLI command, an HTTP endpoint, and an MCP/agent tool.
6. **The event stream is the spine.** Streaming output, observability, and drift detection all read the *same* event stream a stitch emits.
7. **Kind-agnostic core.** HTTP first, but the internal interface is built so GraphQL/shell/LLM slot in later without touching the core. **[v1: HTTP only, abstraction-ready]**

---

## 3. Anatomy of a stitch

```ts
const listWebsites = stitch({
  kind: 'http',                          // [decided] default; future: 'graphql' | 'shell' | 'llm'
  method: 'GET',                         // default GET
  baseUrl: env('API_BASE'),
  path: '/api/websites',

  input:  { query: WebsiteQuery },       // schemas for params / query / body / headers
  output: Website.array(),               // response contract → types + validation + drift
  unwrap: 'data',                        // pluck the payload

  auth:     session,                     // a co-located auth strategy value (§5)
  retry:    { attempts: 3, on: [429, 503] },
  throttle: { rate: '4/s', concurrency: 2 },
  timeout:  { total: '30s' },
  hooks:    { onRequest, onResponse, onError, onRetry },
});
```

Everything except a target (a URL or `path`) is optional. The smallest possible stitch is `stitch('https://…')`.

### Call convention **[decided]**

A stitch is called with a **single `input` object** and returns a value that is both awaitable *and* streamable:

```ts
const sites = await listWebsites();                       // GET, no input
const one   = await getWebsite({ params: { id: 1 } });    // path params
const made  = await createSite({ body: draft });          // POST body

for await (const ev of listWebsites.stream()) { /* §8 */ }
```

A stitch is **defined once and called many times** — it *is* a reusable function, so calling it with different inputs covers "create once, reuse with different params" directly. To *pre-bind* some inputs and supply the rest later, **`.with()`** returns a new stitch with those inputs merged in as defaults (call-time overrides per field):

```ts
const search    = stitch({ path: '/search', input: { query: SearchQuery } });
const adminHits = search.with({ query: { role: 'admin' } });   // specialized, still reusable
await adminHits({ query: { q: 'ada' } });                      // → /search?role=admin&q=ada
```

`.with()` binds `params`, `query`, `body`, or `headers`, and its result is itself a stitch (composes/extends like any other). A **curried** calling form is also available as an opt-in adapter (`stitch.curried(...)`) for stylistic preference, but `.with()` is the more general, recommended tool.

---

## 4. Composition & inheritance  ·  the reuse model

The tension: stitches must stay **atomic** (no global config) *and* let you DRY out `baseUrl` / `auth` / `retry` / etc. Resolution: **everything reusable is a named value, and a stitch composes values.** All three ergonomic variants below are **first-class and supported** — they're thin facades over one canonical resolved config, so you can pick whichever fits your code convention (or mix them in the same codebase). One engine, three authoring surfaces.

First, the reusable fragments — plain values you define once and import:

```ts
const base = preset({                       // a bundle of defaults
  baseUrl: env('API_BASE'),
  retry:   { attempts: 3, on: [429, 503] },
  timeout: { total: '30s' },
});

const session = cookieSession({                // an auth strategy (§5)
  login:  signIn,                              // ← another stitch
  cookie: 'session_token',
  secret: keychain('app'),
  refreshOn: [401],
});
```

### Variant A — `extends: [...]`  **[supported]**

```ts
const listWebsites = stitch({
  extends: [base, session],                 // left→right precedence; own fields win last
  path: '/api/websites',
  output: Website.array(),
  unwrap: 'data',
});
```

### Variant B — bound factory `defineStitch(...)`  (evolution of today's `prestitch`)

Best when *every* stitch in a service shares the same base + auth:

```ts
const apiStitch = defineStitch(base, session);   // a stitch() pre-bound to these

const listWebsites = apiStitch({ path: '/api/websites', output: Website.array() });
const getWebsite   = apiStitch({ path: '/api/websites/{id}', output: Website });
```

### Variant C — fluent builder  **[supported]**

```ts
const listWebsites = stitch
  .use(base, session)
  .get('/api/websites')
  .returns(Website.array())
  .unwrap('data');
```

### Extending another stitch

A stitch is itself a composable value — inherit one and override the diff:

```ts
const getWebsite = stitch({
  extends: [listWebsites],     // inherits base + auth + retry + unwrap
  path: '/api/websites/{id}',  // override
  output: Website,             // override
});
```

### Merge semantics **[proposed]**

- **Scalars** (`path`, `method`, `baseUrl`, `unwrap`): replace.
- **Objects** (`retry`, `throttle`, `timeout`, `input`, auth options): deep-merge field-wise.
- **`hooks`**: **chain**, don't replace — base `onRequest` runs, then child's; `onResponse` unwinds child→base (middleware order). This is what makes a base like "always log + add trace header" actually composable.
- **`output` / contracts**: replace (a child declares its own); compose explicitly with `schema.merge(...)` when you want to extend.

---

## 5. Auth — inferred, co-located, capability-not-credential

**Co-located [decided].** Auth is a field on the stitch (or on a fragment it extends). Never global. An atomic one-endpoint stitch carries its own auth.

**Inferred by default [proposed].** If you don't specify `auth`, StitchAPI infers a common strategy from signals:
- an `Authorization: Bearer …`/`X-Api-Key` header in the example/curl you stitched from → Bearer/API-key, value resolved from a matching `*_TOKEN` / `*_API_KEY` env var;
- a `Set-Cookie` from a provided login example → cookie session;
- an OAuth2 token endpoint + client id/secret in env → client_credentials.

Inference is always overridable. (Progressive disclosure: it usually "just works"; you configure only when it can't guess.)

**Explicit strategies [proposed]:** `bearer()`, `apiKey()`, `basic()`, `cookieSession()`, `oauth2()` — each a value you can name, share, and `extends`.

**The boundary — the selling point.** The secret resolves at call time from `env()` / `keychain()` / a secret manager. The stitch **declaration** is committed; the secret is not. So:

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
throttle: { rate: '1/s', concurrency: 2, scope: 'host' },   // proactive limiter
timeout:  { total: '30s', perAttempt: '10s' },
```

- **`throttle`** is *proactive* — a token-bucket/concurrency cap to stay *under* a vendor's limit (replaces the hand-rolled 1/s buckets and per-request delays integrations write by hand). `scope: 'host'` shares one limiter across all stitches hitting the same host.
- **`retry`** is *reactive* — backoff+jitter, honoring `Retry-After`.
- All emit events (`retry`, `throttled`) onto the stream → visible in the trace for free.

---

## 7. Validation & drift — error / warn / info

Validation is **not** binary pass/fail. A stitch compares each live response against (a) its `output` schema and (b) the committed **contract snapshot** (`<stitch>.contract.json`), and classifies every difference by level:

| Level | Trigger | Behavior |
|---|---|---|
| **error** | a field you *rely on* is missing or wrong type | fail the call (or `error` event); **CI fails** |
| **warn** | a watched, non-critical field changed (type, became nullable, removed-but-optional) | `warn` event; call still succeeds |
| **info** | a **new** field appeared that isn't in the contract | `info` event — "the vendor added `rating_v2`, want to consume it?" |

```ts
output: drift(Torrent, {
  critical: ['id', 'magnet'],   // error if these break — you depend on them
  watch:    ['seeders'],        // warn if this changes
  onNew:    'info',             // default: surface new fields as info
}),
```

Defaults (progressive disclosure): required schema fields → **error**, unknown new fields → **info**, optional changes → **warn**. The snapshot is what makes "a *new* field appeared" detectable (diff live shape vs last-known shape, not just vs schema). All drift becomes events on the stream → console/JSONL/OTLP. CI mode re-validates committed sample payloads and fails on `error` (configurable to fail on `warn`).

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

One shape generalizes **HTTP progress/pagination** *and* (future) **LLM token streaming** — "more direct streaming than `fetch`." The `await` form is sugar that consumes the stream and returns the `result` value (or throws on `error`).

---

## 9. Observability — zero-infra, opt-in depth

> *console/JSONL by default, OTLP only when you want it. You never need infra to get insight.*

Observability is a **consumer of the event stream**, not a separate system:

- **Default (zero infra):** events tee to the console (pretty) and a rolling JSONL file (`~/.stitch/runs/*.jsonl`). You instantly have per-vendor latency, error rate, retry counts, throttle waits, and drift flags.
- **Local viewer (zero infra):** `stitch trace` / `stitch top` reads that JSONL → p99, error rate, drift timeline, in your terminal.
- **Opt-in bridge:** `export: 'otlp'` (or `'langfuse'`) fans the *same* events to Jaeger/Grafana/Langfuse when you have them, using OTel `http.*` semantic conventions.

---

## 10. The four surfaces

One definition, four front doors:

| Surface | How | For |
|---|---|---|
| **Function** | `await listWebsites()` | your app; another agent's code-mode sandbox |
| **CLI** | `stitch run list-websites --id 1` | shell scripts & agents — JSONL output, pipeable, no app boot |
| **HTTP** | `stitch serve` | remote/other-language callers |
| **MCP** | `stitch mcp` | one code-mode tool (`run_stitch`) — avoids one-tool-per-endpoint bloat |

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
const users = stitch({ path: 'https://reqres.in/api/users', output: User.array(), unwrap: 'data' });
const list = await users();   // typed User[]; drift-checked
```

**4. POST with a body contract**
```ts
const createUser = stitch({ method: 'POST', path: '/api/users', input: { body: NewUser }, output: User });
await createUser({ body: { name: 'Ada' } });
```

**5. Shared base via `extends`**
```ts
const api = preset({ baseUrl: env('API_BASE'), retry: { attempts: 3 } });
const listWebsites = stitch({ extends: [api], path: '/api/websites', output: Website.array() });
```

**6. Bound factory (every stitch shares base + auth)**
```ts
const s = defineStitch(api, session);
const listWebsites = s({ path: '/api/websites', output: Website.array() });
const getWebsite   = s({ path: '/api/websites/{id}', output: Website });
```

**7. Extend another stitch**
```ts
const getWebsite = stitch({ extends: [listWebsites], path: '/api/websites/{id}', output: Website });
```

**8a. Auth inferred (Bearer from env)**
```ts
// API_TOKEN in env → inferred Bearer, no auth config needed
const movie = stitch('https://api.example.com/v3/movie/{id}');
```

**8b. Auth explicit — the agent auth-wall case**
```ts
const signIn = stitch({
  method: 'POST', path: '/api/auth/sign-in/email', baseUrl: env('API_BASE'),
  input: { body: Credentials }, captures: { cookie: 'session_token' },
});
const listWebsites = stitch({
  extends: [api],
  path: '/api/websites', output: Website.array(), unwrap: 'data',
  auth: cookieSession({ login: signIn, cookie: 'session_token', secret: keychain('app'), refreshOn: [401] }),
});
await listWebsites();   // logs in, manages cookie, retries wall, returns Website[]
```

**9. Resilience (replaces hand-rolled per-provider limiters)**
```ts
const metadata = stitch({
  baseUrl: env('METADATA_API'), path: '/graphql',  // (graphql kind: future)
  throttle: { rate: '1/s' }, retry: { attempts: 4, on: [429, 502, 503] },
});
```

**10. Streaming consumption**
```ts
for await (const ev of listWebsites.stream()) {
  if (ev.type === 'progress' && ev.phase === 'retry') log('retrying…');
  if (ev.type === 'drift'    && ev.level === 'info') log('new field:', ev.path);
  if (ev.type === 'result')  render(ev.value);
}
```

**11. Drift levels**
```ts
const listings = stitch({
  baseUrl: env('SEARCH_API'), path: '/search',
  output: drift(Listing.array(), { critical: ['id'], watch: ['score'], onNew: 'info' }),
});
```

**12. Observability (nothing to configure)**
```bash
stitch run list-websites          # auto-logged to console + ~/.stitch/runs/*.jsonl
stitch trace --since 1h           # p99, error rate, drift timeline — no infra
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
  stitch({ kind: 'http',  path: '/api/movie/{id}' }),
  stitch({ kind: 'llm',   prompt: 'Summarize this movie in one line: {{input}}' }),
);   // one composed stitch; same auth/retry/observability machinery
```

---

## 12. Dogfooding targets

Validated against two real apps (kept brand-neutral here):
- **An auth-gated SaaS** — replace hand-written fetch wrappers; first real test = unblock an agent on a cookie-walled `GET /api/websites` via a `cookieSession` stitch. Also covers Bearer and OAuth2 client_credentials integrations.
- **A multi-provider aggregator** — replace per-provider hand-rolled auth+retry+throttle across: a GraphQL API (ApiKey + 1/s bucket), a cookie-session client (403→relogin), an HTML-scrape provider (drift-prone), a Bearer REST API, and two media servers with bespoke token headers.

If the abstraction makes these clean, it works.

---

## 13. Roadmap (phasing)

1. **Core vertical slice (HTTP):** stitch config + event-stream + `await` sugar; validation + drift levels; retry/throttle/timeout; zero-infra console/JSONL trace.
2. **Composition:** fragments + `extends` + `defineStitch` (pick syntax from §4); auth strategies + inference; the auth-wall demo on a real cookie-walled app.
3. **Surfaces:** CLI (`run`/`trace`) → MCP → HTTP serve.
4. **Depth:** OTLP export; contract snapshots + CI gate; Mermaid diagram from definition.
5. **Kinds:** GraphQL → shell → LLM; `pipe()` composition; live trace overlay on the diagram.

---

## 14. Open questions

- ~~Composition syntax / call convention~~ — **resolved**: all three composition facades supported (extends / factory / builder); call = single-input-object + `.with()` + optional curried.
- **Validation lib** — move from Zod-locked to **Standard Schema** (Zod/Valibot/ArkType)? (Recommended; affects bundle size.)
- **Secret resolvers** — which to ship first: `env()`, `keychain()`, file, cloud secret managers?
- **Visual** — Mermaid-from-definition first; how important is the live interactive trace view for v1?
