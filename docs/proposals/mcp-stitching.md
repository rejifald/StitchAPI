# Proposal — the MCP surface: turn any MCP server into typed, resilient stitches (and re-expose many as one)

**Status:** proposed · **Scope:** new `stitchapi/mcp` _client_ direction in `packages/core` + a `gateway` composer; generalizes the existing `stitchapi/mcp` _server_ · **Target branch:** `main`
**Relates:** ADR 0002 (seam), ADR 0005 (surfaces), ADR 0008 (non-HTTP surfaces & `pipe`), ADR 0009 (`postMessage` — the precedent for a non-`fetch` surface). **Complements, does not replace** `search_docs` (that hosts _our_ docs; this wraps _any_ MCP server the user points at).

> [!NOTE]
>
> A design record, not yet implemented. It resolves the one real architectural
> fork — _where does the long-lived JSON-RPC session live, given surfaces are
> stateless?_ — against the grain of the existing primitives (§3), not with a new
> subsystem.

---

## TL;DR

An MCP server is just an API: JSON-RPC `tools/call` over stdio or Streamable HTTP.
StitchAPI already turns any API into a typed, resilient function and composes
them — so the whole of MCP drops in behind **one surface** and **one seam**, with
zero new runtime dependencies.

-   **Inbound (the new half).** `mcp.stdio()` / `mcp.http()` connects to an MCP
    server and hands back its tools as ordinary `Stitch`es — each with validation,
    cache, retry, throttle, and tracing for free. _An MCP tool becomes a typed,
    resilient function._
-   **A server is a seam.** `seam` is documented verbatim as "the primitive for any
    **shared surface** (a third-party API, an internal service)." An MCP server maps
    onto it natively: one connection, shared auth/throttle/trace, a `.as(principal)`
    trust boundary, and a `close()` lifecycle — tools are its members.
-   **Many servers → one seam → one MCP (the headline).** Aggregate tools from
    several MCP servers (plus your own REST/GraphQL) into a single seam. Consume it
    in-process as typed stitches **and** re-expose the whole thing as **one** MCP
    server — reusing the stdio server that already ships (`packages/core/src/mcp.ts`),
    but serving a curated, _composed_ toolset instead of raw passthrough.

The outbound direction (stitches → MCP) already exists for the code-mode
single-tool case. This proposal builds the inbound direction and generalizes the
outbound one so the two doors are symmetric.

---

## 1. Problem, and why now

-   **Agents live on MCP now, and MCP servers are unreliable primitives.** They are
    network- or subprocess-backed, rate-limited, and often slow (LLM- or web-backed
    tools). Today every server re-invents (or skips) retry, timeout, caching, and
    auth. StitchAPI is _exactly_ the missing policy layer — but it can't touch MCP
    until MCP is a transport it understands.
-   **Tool sprawl degrades tool selection.** An agent pointed at six MCP servers
    sees forty tools and picks badly. There is no first-class way to compose a few of
    them into one well-named, deterministic tool. `linked`/`all`/`any`/`race` already
    do this for stitches; they just need MCP tools to be stitches.
-   **We already speak MCP on one side only.** `packages/core/src/mcp.ts` exposes a
    user's registry _as_ an MCP server (`run_stitch`, `list_stitches`,
    `describe_stitch`). The mirror — consuming _someone else's_ MCP server as typed
    stitches — is missing, and it's the direction that unlocks composition.

## 2. Not the same as `run_stitch` or `search_docs`

|             | `run_stitch` (exists)         | `search_docs` (proposed)  | **MCP surface (this)**                          |
| ----------- | ----------------------------- | ------------------------- | ----------------------------------------------- |
| Direction   | Outbound (our stitches → MCP) | Outbound (our docs → MCP) | **Inbound** (any MCP → our stitches) + outbound |
| Over what   | The user's stitch registry    | Our docs corpus           | **Third-party MCP servers** the user names      |
| Value       | Expose what you built         | Learn StitchAPI           | **Wrap, harden, and compose** what others built |
| Composition | —                             | —                         | `linked`/`all`/`any`/`race` across servers      |

They are siblings. This one is the first to point _outward_ at the MCP ecosystem
rather than publishing StitchAPI into it.

## 3. Architecture — reusing what we have

Four facts from the codebase decide the whole design; none require a new subsystem.

### 3.1 A tool is a `Surface`, and `execute` is the linchpin

`Surface` (`surface.ts:30`) already has an escape hatch for transports that aren't
`fetch`:

```ts
readonly execute?: Adapter; // surface.ts
```

The engine resolves transport as `cfg.kind?.execute ?? rt.adapter`
(`engine.ts:678`). So a surface can **bring its own transport** — which is exactly
what MCP needs, because stdio JSON-RPC is not HTTP at all. `mcp.stdio(...).tool(name)`
returns a `Surface` (the `kind`) whose:

-   `execute` sends `tools/call { name, arguments }` over the connection and returns
    an `AdapterResponse`;
-   `buildRequest` maps the stitch input → `arguments`;
-   `interpret` turns the JSON-RPC result's content blocks into a `SurfaceOutcome`
    (`{ ok: true, value }` or `{ ok: false, message, status }`), honoring `isError`;
-   `stream` maps `notifications/progress` → `delta` events (see §3.4).

Because the surface carries `execute`, a single MCP tool works **standalone**, no
seam required:

```ts
import { stitch } from 'stitchapi';
import { oauth2 } from 'stitchapi';
import { mcp } from 'stitchapi/mcp';

// the client owns the JSON-RPC session (initialize handshake + lifecycle)
const gh = mcp.stdio({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
});
//   or  mcp.http({ url: 'https://host/mcp', auth: oauth2({ /* ... */ }) })

const searchRepos = stitch({
    kind: gh.tool('search_repositories'), // Surface<…> with execute bound to `gh`
    output: RepoHits, // MCP returns loosely-typed content blocks — validate them
    cache: { ttl: '5m' }, // opt-in; off by default (see §5)
    retry: { attempts: 3 },
});

const hits = await searchRepos({ query: 'stitch', perPage: 10 });
await gh.close();
```

Crucially, surfaces "hold no per-call state" (ADR 0005, Decision 1) — and that
invariant is preserved: the surface object is pure config + closures; the
**connection** (the socket / child process) is the long-lived thing, and it lives
on the client/seam, not the surface. See §3.2.

### 3.2 An MCP server is a seam

`seam` (`seam.ts:204`) is the long-lived entity stitches _belong to_: one shared
runtime (store, vault, trace sink, throttle bucket), a `.as(principal)` trust
boundary, and `flush()`/`close()` lifecycle. The `mcp.stdio()`/`mcp.http()` client
**is** an MCP-specialized seam:

```ts
// shared throttle/auth/trace across every tool; one lifecycle owns the transport
const gh = mcp.stdio({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
});

const searchRepos = gh.tool('search_repositories', {
    output: RepoHits,
    cache: { ttl: '5m' },
});
const getIssue = gh.tool('get_issue', { output: Issue });

const forUser = gh.as('user:42'); // per-principal auth session, shared throttle bucket (ADR 0002)
await gh.close(); // kills the child process / closes the HTTP session
```

`.tool(name, config?)` is sugar for `gh.stitch({ kind: gh.tool(name), ...config })`.
The connection's `close()` is wired into the seam's existing lifecycle — nothing
new. This is the answer to "where does the session live": on the seam, which is
_designed_ to be the long-lived owner of a shared surface's runtime.

### 3.3 Many servers → one seam → one MCP (the headline)

A stitched pipeline across servers is just a `Composable` (`all`/`any`/`linked`
from `stitchapi/pipe`), and a `Composable` can be a member of a seam. So a
**gateway** is a seam whose members are drawn from several upstream MCP clients
plus your own stitches:

```ts
import { gateway } from 'stitchapi/mcp';
import { all, linked } from 'stitchapi/pipe';

const gh = mcp.stdio({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
});
const jira = mcp.http({
    url: 'https://jira.internal/mcp',
    auth: oauth2({
        /* ... */
    }),
});

const desk = gateway({
    // a curated, composed tool — not raw passthrough
    triage: linked(async (run) => {
        const issue = await run(gh.tool('get_issue'), { number: 128 });
        const dupes = await run(gh.tool('search_repositories'), {
            query: issue.title,
        });
        const ticket = await run(
            jira.tool('create_issue'),
            toTicket(issue, dupes),
        );
        return summarize({ issue, dupes, ticket });
    }),
    // …plus any plain member: gh.tool('get_issue'), a REST stitch, etc.
});

// Face 1 — consume in-process as a typed stitch:
const out = await desk.stitch('triage')({
    /* input */
});

// Face 2 — re-expose the whole seam as ONE MCP server (stdio or HTTP),
// reusing packages/core/src/mcp.ts, but serving `triage` (not 40 upstream tools):
desk.serve({ transport: 'stdio' });
```

`any`/`race` give **failover** across redundant providers of the same capability
(two web-search MCPs, primary/backup); `all` gives fan-out; `linked` gives typed
dependent chaining. This is the literal "stitching" — and the result is one small,
well-named toolset the downstream agent can actually pick from.

### 3.4 Streaming, progress & resumability come free

Streamable HTTP MCP _is_ SSE, and long-running tools emit `notifications/progress`.
The `sse` surface (`sse.ts`) already models exactly this: `stream` yields deltas,
`resumeToken`/`applyResume` persist a `Last-Event-ID` across drops, and the engine
(not the surface) owns the per-run reconnection state (`engine.ts:1187`). The MCP
surface reuses that machinery: `progressToken` → resume token, progress
notifications → `delta` events, so `stitch.stream()` works over MCP with no new
reconnection logic.

## 4. Tool contract & naming — P22 governs the boundary

Per **P22** ("a standards-interop contract uses the standard's field names"), the
surface speaks **MCP's vocabulary** at the wire boundary and does not rename:
`tools/call`, `name`, `arguments`, `inputSchema`, `content`, `isError`,
`progressToken`. StitchAPI's own words (`input`, `output`, `kind`) stay on the
_authoring_ side; the mapping between them is the surface's job, declared once.

-   **Input.** An MCP tool's `inputSchema` (JSON Schema) becomes the stitch's `input`
    validator via the existing `toValidator` ladder — the same path `from-curl` and
    the OpenAPI import already use.
-   **Output.** MCP returns `content: [{ type: 'text' | 'image' | 'resource', … }]`.
    `interpret` extracts the payload; the surface's `contractValue` hook (already used
    by `sse`) is what the user's `output` validator sees, so validation targets the
    clean shape, not the envelope.
-   **Errors.** A tool result with `isError: true` maps to a non-`ok`
    `SurfaceOutcome`. Following the StitchError message-leak rule, the raw server
    message is **masked to a generic token by default** and surfaced only via explicit
    opt-in — the same posture the HTTP/SSE error surfaces already take.

## 5. Decisions (recommended defaults)

1. **Zero new runtime deps in the hot path.** Hand-roll the JSON-RPC client exactly
   as `core/src/mcp.ts` hand-rolls the server. `@modelcontextprotocol/sdk` stays out
   of `packages/core` (it's a heavy, Node-shaped dep) — it may back an _optional_
   serving helper, never the client. Preserves the zero-dep / browser-first bar.
2. **Cache and retry are OFF unless the tool says it's safe.** MCP tool definitions
   carry `readOnlyHint` / `idempotentHint` annotations. `from-mcp` (§7) scaffolds
   `cache`/`retry` **only** for tools annotated read-only/idempotent; everything else
   defaults to no side effects, honoring the library's "no side effects by default"
   principle. An agent must never get a stale or double-fired `send_email`.
3. **Transports are environment-gated by export condition.** `mcp.http()` is
   browser-safe (rides the `fetch` adapter + SSE machinery). `mcp.stdio()` is
   Node-only (`child_process`) behind the `node` condition — same pattern as
   `basic()`'s `Buffer`→`btoa` split. Importing `stitchapi/mcp` in a browser never
   pulls `child_process`.
4. **The client is the seam; the tool is the surface.** No new top-level
   `StitchConfig` key — the tool name is a parameter to `gh.tool(name)`, which
   returns the `kind`. Keeps the config contract minimal (P2 — one word, one
   meaning).

## 6. Testing — reuse what already ships

No new test framework. The MCP client bottoms out in an `Adapter`, so:

-   **`mockAdapter`** (`test-mock.ts`) already fakes JSON-RPC responses by routing on
    request shape — deterministic MCP tests with no live server. A thin
    `mockMcpServer({ tools })` helper wraps it to produce an in-memory transport +
    `tools/list` so the client's handshake resolves.
-   **`stubStitch` / `failStitch`** (`test-stub.ts`) already replace any resulting
    member for pipeline tests — a composed `gateway` tool is tested by stubbing its
    upstreams.
-   The **conformance kit** (`verifyAdapterContract`) gains an MCP-transport fixture
    so third-party transports (a WebSocket MCP, say) can prove they conform.

## 7. CLI symmetry

The CLI already scaffolds a stitch from one example (`stitch from-curl` /
`--from-har`) and exports a registry to OpenAPI (`toOpenApi`, `openapi.ts`). Two
symmetric additions:

-   **`stitch from-mcp <server>`** — connect, `tools/list`, and scaffold one typed
    stitch per tool (input validator from `inputSchema`, cache/retry per annotation,
    §5.2). Bulk analogue of `from-curl`.
-   **`stitch serve --mcp`** — serve the registry (or a named seam) as an MCP server,
    generalizing `core/src/mcp.ts` to HTTP and to curated toolsets. The outbound door.

## 8. The three gates

-   **Browser-first.** `mcp.http()` runs in the browser on the existing `fetch`
    adapter; `mcp.stdio()` is `node`-gated. The hot path adds no Node-only imports.
-   **Bundle-frugal.** Zero new deps; the JSON-RPC codec is shared with the existing
    server. Phase 1 lands with a measured bundle delta against
    `bundle-size.mjs`, held to a stated budget.
-   **Contract-not-dependency.** A tool's _identity_ — server + tool name + input/output
    schemas — is declarative and round-trips as JSON (that's what `from-mcp` scaffolds
    and `describe_stitch`/`diagram` render). The live connection is runtime state, like
    any adapter — not part of the capability that must serialize.

## 9. What to hold the line on

-   **The client never becomes an agent.** It wraps, hardens, and composes tool
    _calls_. Server-initiated features that reverse the direction — **sampling**
    (server asks the client to run an LLM), **elicitation**, **roots** — are out of
    scope for v1 (§11). Pretending to support them half-way is worse than not.
-   **No implicit caching or retries.** §5.2 is a safety property, not a default to
    relax later. The annotation gate stays.
-   **Don't fork the JSON-RPC codec.** One hand-rolled encoder/decoder, shared by the
    client and `core/src/mcp.ts`. If they drift, `tools/call` framing bugs appear on
    one side only.
-   **P22 at the boundary.** Resist renaming MCP fields into "nicer" StitchAPI words
    on the wire. The translation lives in the surface, declared once.

## 10. Phasing (one PR each, stop between)

1. **JSON-RPC codec + `mcp.http()` client + the MCP `Surface`.** Inbound over
   Streamable HTTP only; single-tool `stitch({ kind: client.tool(name) })`. Bundle
   delta measured and gated. Browser-safe.
2. **The client-as-seam.** `.tool()`/`.stitch()` members, shared throttle/auth,
   `.as(principal)`, `close()` lifecycle. `mcp.stdio()` transport behind the `node`
   condition.
3. **Streaming & resumability.** Wire `notifications/progress` → `delta`,
   `progressToken` → resume token through the existing SSE machinery.
4. **`gateway()` + `.serve()`.** Compose across servers; re-expose one seam as one
   MCP server (generalizing `core/src/mcp.ts` to HTTP + curated tools).
5. **CLI + testing.** `stitch from-mcp`, `stitch serve --mcp`, `mockMcpServer`, the
   conformance-kit MCP fixture.
6. **Docs + an ADR.** Promote the resolved design (surface-carries-`execute`,
   seam-owns-session, annotation-gated resilience) into an ADR; document the three
   siblings (`run_stitch` / `search_docs` / MCP surface) so nobody wires the wrong one.

## 11. Out of scope (for now)

-   **Reverse-direction MCP:** sampling, elicitation, roots. These require the gateway
    to act as a client-of-the-caller; revisit once inbound is solid.
-   **A hosted "public gateway."** This is a library capability the user runs; we are
    not operating a multi-tenant MCP proxy.
-   **Non-JSON-RPC MCP transports** beyond stdio + Streamable HTTP (e.g. WebSocket)
    until one is standardized — though the `execute`-carrying surface makes adding one
    a contained change.
