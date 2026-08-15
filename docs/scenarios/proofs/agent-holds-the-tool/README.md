# Proofs — the agent chooses the arguments

Runnable evidence for the claims in [`../../agent-holds-the-tool.md`](../../agent-holds-the-tool.md).

**C1 was the deciding claim and the boundary HOLDS.** Across 34 JSON-RPC exchanges and 30 separate
payload scans — `initialize`, `ping`, `tools/list`, `list_stitches`, `describe_stitch` on all ten
stitches, a successful `run_stitch` on `bearer(env(...))` / `apiKey` in a header / `apiKey` in the
query / `cookieSession`, a direct call to the registered login stitch, a vendor 401 with a
credential-shaped string in its error body, a validation failure, an unknown stitch, an unknown
tool, an unknown JSON-RPC method and a stdio parse error — **not one of the five credentials the
registry holds appeared, by value, anywhere.** The controls hold too: the same calls put
`Bearer sk_live_…`, `X-API-Key: ak_live_…`, `?api_key=ak_live_…` and `Cookie: SESSION=sess_live_…`
on the wire, so the vendor authenticated every one of them, and the shipped stdio transport writes
byte-identical payloads to the in-process ones. This is the product's central promise and it is
kept.

**C2 refutes the capture's own hypothesis.** Scenario 10 measured `engine.ts:231` merging
`input.headers` **over** `cfg.headers`, and the capture predicted a prompt injection could set any
header on a call it did not author. It cannot: `sanitizeAgentInput` (mcp.ts:125-130) **deletes the
whole `headers` slot** unless the stitch declares an `input.headers` schema. Six model-supplied
headers — `authorization`, `cookie`, `host`, `x-forwarded-for`, `content-type`, `x-anything` —
reached the vendor as **zero headers**. And even on a stitch that opts in, `authorization` is
unforgeable, because `auth` is applied to a clone **after** the merge (engine.ts:647).

Three findings went the other way — one is a genuine credential leak, and one has since been fixed
upstream (#663):

- **The MCP error channel is an unfiltered `Error.message` pass-through** (C4). StitchAPI's own
  messages are terse and clean — `HTTP 500`, `timed out after 25ms`, `circuit open` — and a vendor
  500 whose body held an internal hostname, a stack frame and a `postgres://vendor:hunter2@…` DSN
  reached the model as **four characters**. But a message written by the _transport_ is forwarded
  verbatim, and on the **default `fetchAdapter`** with an `apiKey({ in: 'query' })` stitch the model
  received `Failed to parse URL from http://api.vendor.test:99999/v1/metrics?api_key=ak_live_qry_…`
  — **the credential, in its context, from zero lines of user code.**
- **A model-supplied `query` overwrites a query parameter the operator pinned in the configured
  path** (C2 d). `path: '/v1/orders?tenant=acme'` + `input: { query: { tenant: 'globex' } }` put
  `?tenant=globex` on the wire and the vendor returned the other tenant's data. A pin is a default,
  not a constraint.
- **A declared input schema was a check, not a filter — filed as #648, fixed by #663** (C7 e).
  `validateInput` threw on failure and **discarded the parsed value**; it now returns each declared
  slot's parsed value — coerced, defaulted, stripped — and the engine runs on it
  (engine.ts:415-447). The `query` validator that returned `{ limit: 10 }` used to put
  `?tenant=globex&limit=10` on the wire; measured now it puts `?tenant=acme&limit=10` — the
  stripped key gone, the operator's pin restored — and C7 (e) keeps that pinned as a regression
  check. A slot with **no** schema is still the full passthrough.

And the shape of the surface decides two more: there is **no allow-list** beyond the registry object
you hand `createMcpServer` (C3), and **no confirmation seam in either direction** (C6) — the server
cannot ask a human, and code-mode puts a read and a refund behind the same tool name, so the host
cannot either.

Every script is standalone and offline. Each prints one `PASS`/`FAIL` line and exits non-zero on
failure. **181 checks across 8 scripts.**

## Run them

```sh
# one claim
pnpm exec tsx docs/scenarios/proofs/agent-holds-the-tool/c1-credential-reach.ts

# all of them
for f in docs/scenarios/proofs/agent-holds-the-tool/c[0-9]*.ts; do pnpm exec tsx "$f" || exit 1; done
```

Run from the repository root — the scripts import core from `packages/core/src` by relative path, so
they test the working tree, not the published bundle. The suite takes about two seconds; the only
waits are the deliberate `throttle` gaps in C5, and nothing here does network I/O (the one
"transport failure" is a port outside the valid range, which `fetch` rejects before opening a
socket).

They typecheck under `packages/core`'s full strict set. **`src/version.d.ts` is in the file list on
purpose** — `src/mcp.ts` reads the build-time `__PKG_VERSION__` define, and without that declaration
`tsc` cannot see the identifier:

```sh
cd packages/core && pnpm exec tsc --noEmit --ignoreConfig \
  --target ES2022 --lib ES2022,DOM --module ESNext --moduleResolution Bundler \
  --esModuleInterop --skipLibCheck --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --noImplicitOverride --noPropertyAccessFromIndexSignature \
  --noUnusedLocals --noUnusedParameters --verbatimModuleSyntax --isolatedModules \
  --types node src/version.d.ts ../../docs/scenarios/proofs/agent-holds-the-tool/*.ts
```

The same define is why `client.ts` loads `src/mcp.ts` through a **dynamic** import behind
`loadMcp()`: a static import would evaluate the module before any assignment could stand the define
in, and the import sorter controls statement order. It is the one piece of ceremony in the
directory, and it is documented in place.

## The exposure table — what can the model SEE, and what can it SET?

**This is the consolidation deliverable.** Every row is measured; reproduce the left half with
`c1-credential-reach.ts` / `c3-allowlist.ts` and the right half with `c2-input-rewrite.ts`.

### What reaches the model

| Payload                           | Carries a credential?  | What it carries instead                                                                                                                             |
| --------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`                      | **no**                 | protocol version, `capabilities: { tools }`, `serverInfo`                                                                                           |
| `tools/list`                      | **no**                 | 3 tool descriptors, 1,464 bytes, constant for any registry size                                                                                     |
| `list_stitches`                   | **no**                 | every stitch's **name, method and path** — the route table                                                                                          |
| `describe_stitch`                 | **no**                 | ~1KB/stitch: the **full internal endpoint URL**, surface, input-slot booleans, `output`, the **auth scheme**, policies, pipeline, a Mermaid diagram |
| `run_stitch` success              | **no**                 | the validated result body                                                                                                                           |
| `run_stitch` vendor 4xx/5xx       | **no**                 | `HTTP <status>` — **not** `.body`, `.url`, `.status` or the response headers                                                                        |
| `run_stitch` timeout / circuit    | **no**                 | `timed out after 25ms` / `circuit open`                                                                                                             |
| `run_stitch` input validation     | **no**                 | `invalid <slot>: <the schema's own issue text>`                                                                                                     |
| `run_stitch` unknown name         | **no**                 | the message plus **every registered name**                                                                                                          |
| `run_stitch` missing credential   | **no**                 | `missing env var VENDOR_BEARER_TOKEN` — the **variable name**, never the value                                                                      |
| **`run_stitch` transport error**  | **YES, conditionally** | the transport's message **verbatim** — see the footgun below                                                                                        |
| a vendor endpoint that mints keys | **YES, by contract**   | the response body, which is what a capability is for                                                                                                |

### What the model can set

| Input field                                     | Reaches the wire?                | What an attacker actually gets                                                                                                        |
| ----------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `headers`                                       | **no**                           | deleted outright unless the stitch declares `input.headers` (mcp.ts:128)                                                              |
| `headers` (opted in)                            | **yes, except `authorization`**  | any non-credential header; on a `cookieSession` stitch, a `SESSION` pair sent **before** the real one                                 |
| `query`                                         | **yes, absent a `query` schema** | **overwrites an operator's pinned query parameter**; appends anything else. A declared schema's parsed value is what ships (#663)     |
| `params`                                        | **yes, encoded**                 | `{id}` percent-encodes `/` → traversal blocked. `{+id}` (reserved expansion) does **not** → a different endpoint, with the credential |
| `body`                                          | **yes, whole**                   | the entire request body of a write, when no `input.body` schema is declared                                                           |
| `signal`                                        | **yes, inert**                   | aborts the call before it is sent — a self-inflicted denial, no request on the wire                                                   |
| `url` / `baseUrl` / `path` / `adapter` / `auth` | **no**                           | inert: the engine reads input by field name and these are config slots                                                                |

Read the two tables together: **the credential boundary is the library's and it holds; the argument
boundary is entirely the operator's.** That is the finding this directory exists for.

## What each script establishes

| Script                   | Question                                                    | Measured                                                                                                                             |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `c1-credential-reach.ts` | **DECIDING** — does a credential reach the model anywhere?  | **No.** 30 payload scans, 4 auth strategies, 14,529 bytes; the wire proves each call authenticated; stdio bytes identical            |
| `c2-input-rewrite.ts`    | **DECIDING** — can `input` redirect or rewrite the call?    | **The header hypothesis is refuted** (6 headers → 0). 5 other levers are real; `authorization` is unforgeable                        |
| `c3-allowlist.ts`        | any allow-list? what do the discovery tools disclose?       | **None beyond the registry object.** ~1KB/stitch incl. the internal URL. `selectStitch` also answers to `__config.name`              |
| `c4-error-rendering.ts`  | does a failure leak the URL, headers or the vendor body?    | **No — and yes.** `HTTP 500` only; but the channel is unfiltered and `apiKey({in:'query'})` + a transport error leaks                |
| `c5-runaway.ts`          | do `throttle`/`circuit` apply? any non-count budget?        | **Both apply; nothing is on by default.** 1 tool call = 5 (retry) or 12 (paginate) requests. **No spend budget exists**              |
| `c6-confirmation.ts`     | is there a confirmation seam for an irreversible call?      | **No, in either direction.** No elicitation channel, no tool `annotations`, one tool name for a read and a refund                    |
| `c7-schema.ts`           | is `input` typed enough? does a schema constrain the model? | **Four untyped bags; presence-only descriptions.** A schema filters its ONE slot (#663, pinned); an undeclared slot is a passthrough |
| `c8-assembled.ts`        | the safest exposure, against the naive one                  | **47 executable lines, 3 seams, 0 config keys** — and every C2/C3/C7 attack replayed and blocked                                     |

## Files

- `vendor.ts` — six credential values (five held by StitchAPI, one minted by the vendor), the env
  vars they resolve from, and `Wire`: an `Adapter` that **records every outbound request** (url,
  method, headers, body) before answering it. The vendor enforces its own auth on every route, so a
  200 in a proof is evidence the real credential arrived rather than an artefact of a permissive
  stub. `/v1/orders` echoes the `tenant` it received — that echo is C2's sharpest measurement.
- `client.ts` — an MCP client that drives the server over JSON-RPC and keeps the **exact response
  bytes**, in two transports: `inProcess` (`createMcpServer().handle`) and `overStdio` (the shipped
  `serveStdio` over a `PassThrough` pair). Also `loadMcp`, the `__PKG_VERSION__` shim.
- `stitches.ts` — ten stitches over four auth strategies, plus the two variables C7 needs isolated:
  one stitch with a tight `input.params` contract and one that opts into `input.headers`.
- `harness.ts` — `check` / `checkSeq` / **`checkClean`** / **`checkDiscloses`** / **`checkWire`** /
  `checkAtMost` / `note` / `heading` / `finish`. `checkClean` is the assertion this scenario exists
  for: it scans one payload against every secret by value and prints the byte count it scanned, so
  a clean result is a measurement rather than an assurance. A hit prints the secret's **label** and
  surrounding context, never the secret.
- `safe-exposure.ts` — the answer C8 counts, between `BEGIN`/`END USER CODE` markers: `expose` (the
  allow-list, which also rejects the configured-name bypass), `only` (a `Proxy` apply-trap that
  rebuilds the input from an explicit key list), `readsOnly` (a method gate on the `Adapter`).
- `ambient.d.ts` — one `declare` for core's build-time `__PKG_VERSION__` define, so the typecheck
  command below runs against the unmodified tree (core keeps its own copy in `src/version.d.ts`,
  which a bare file-list `tsc` never loads).

## Reading the numbers honestly

- **C1 is a strong positive and should be read as one.** The capability boundary is not a slogan
  here: four auth strategies, a login whose `Set-Cookie` carries the session, an error path whose
  vendor body contains a credential-shaped string, and a `cookieSession` whose login stitch is
  itself registered and callable — none of them put a held credential into a JSON-RPC payload. The
  registered login stitch is the sharpest of those: an agent can call it, and gets `HTTP 401`,
  because the login credential lives in `cookieSession.loginInput` and the MCP path never reaches it.
- **The one leak is `apiKey({ in: 'query' })`, not MCP.** The auth guide already warns that a key in
  the URL "leaks wherever URLs go — server access logs, proxies, the browser history, a `Referer`
  header". What C4 adds is one more destination: an unfiltered error message, and therefore the
  model's context, its output, and any tool it calls next. The control is exact — the identical
  transport failure on a `bearer` stitch disclosed the URL and no secret.
- **`sanitizeAgentInput` is a denylist of one key, and that is a design decision with a cost.** It
  removes `headers` and forwards everything else as authored. Today nothing else is exploitable
  (`signal` and `onProgress` are runtime-only slots JSON can fill only with inert values, and the
  measured worst case is a call that aborts itself). But the default for a NEW input slot is
  "exposed to the agent", and the function's own comment says its job is to forward "only the input
  a stitch is built to accept" — which is an allow-list's description of a denylist's behaviour.
- **The `describe_stitch` disclosure is a deliberate trade and mostly the right one.** Teaching an
  agent the endpoint, the pipeline and the auth scheme is what makes code-mode usable, and the
  things that would actually help an attacker are absent: the credential, the operator's configured
  request headers (an `x-internal-tenant` pin and an internal shard hostname stayed hidden), and the
  env var name. What it costs is that a prompt injection reading the tool output learns the internal
  route table for free.
- **C5's amplification is the number to take away, not the throttle.** `throttle` and `circuit` both
  work on the MCP path — that was never really in doubt once you notice `run_stitch` just calls the
  stitch. What a host cannot see is that **one tool call is not one request**: `retry: { attempts: 5 }`
  made five and `paginate` made twelve, with no signal of either in the tool result. A host that
  budgets "20 tool calls" has budgeted up to 1,000 vendor requests.
- **C8's 47 lines are the honest cost and they are cheap.** Three seams, no fork, no config key, and
  every measured attack blocked while the reads keep working and keep authenticating. The line count
  goes the library's way here precisely because the expensive half — the credential boundary, the
  resilience chain, the discovery tools, the JSON-RPC layer and the transport — is already done.

## Footguns

1. **A transport error message reaches the model verbatim, and an `apiKey({ in: 'query' })`
   credential rides in it.** Measured on the built-in `fetchAdapter` with no user code:
   `Failed to parse URL from http://api.vendor.test:99999/v1/metrics?api_key=ak_live_qry_…`.
   Node's `fetch` only writes that on a malformed URL, but `node-fetch`, `got` and several house
   wrappers put the full URL in **every** network error (`request to <url> failed, reason: …`), so
   with a swapped adapter a routine DNS failure does it. **Fix: `apiKey({ in: 'header' })`.** There is
   no redaction on this path — `errorResult((e as Error).message)` is the whole of it (mcp.ts:184).
2. **A query parameter pinned in the configured path is a default, not a constraint.**
   `path: '/v1/orders?tenant=acme'` reads like an operator invariant and is overwritten by
   `input: { query: { tenant: 'globex' } }` (`{ ...predefined, ...input.query }`, engine.ts:211).
   Measured end to end: the vendor echoed `globex`. Since #663 a strip-mode `input.query` schema is
   the constraint — C7 (e) measures the pin surviving it; absent one, anything that must not move
   belongs in a `headers` entry or in the path template, not in the query string.
3. **An input schema filters only its own slot — and the two cookie writers disagree.** Since #663
   (issue #648, filed from this audit) `validateInput` returns the parsed value and the request is
   built from it (engine.ts:415-447), so a stripping schema drops unknown keys from the wire — but
   only on the slot it is declared on; an undeclared slot is a full passthrough. Separately,
   `cookieSession.apply` **joins** the `Cookie` header
   (`[req.headers.cookie, cookie].join('; ')`, auth.ts:918-921) while `apiKey({ in: 'cookie' })`
   **replaces** the same-named pair via `setCookiePair` (auth.ts:228-245). Measured on a
   headers-opted-in stitch: `SESSION=attacker; SESSION=sess_live_…`, and a vendor that reads the
   first pair — Express, Rails, Go's `net/http`, PHP — runs the call as the model's session.
4. **Renaming a registry key does not hide a stitch.** `selectStitch` falls back from the key to
   every stitch's configured `__config.name` (registry.ts:71-74), so `{ readOnlyOrders: refund }`
   still answers to `run_stitch({ name: 'refund' })` — callable, and absent from `list_stitches`, at
   the same time. `safe-exposure.ts`'s `expose` rejects the mismatch at construction.
5. **`sensitive: true` does not mean "do not expose this".** It is a **cache** opt-out
   (types.ts:1652-1658) — the one word in `StitchConfig` that reads like an agent-visibility flag,
   and measured, a stitch carrying it was still listed by `list_stitches` and still ran. None of the
   32 top-level config slots controls MCP exposure.
6. **`stitch mcp --module ./stitches.ts` exposes the whole module.** `collectStitches` recognises a
   stitch structurally and keys it by export name (cli.ts:654-657), so a write, an internal login
   stitch and a debug endpoint are all equally callable the moment they are exported. There is no
   per-stitch opt-in anywhere in `StitchConfig`.
7. **Code-mode makes the host's destructive-tool prompt undecidable.** One `run_stitch` name covers
   a `GET /v1/orders/77` and a `POST /v1/refunds`, and the tool descriptors carry **no
   `annotations`** — no `readOnlyHint`, no `destructiveHint` — so a host that prompts before
   destructive tools has nothing to key on, and the method is buried in an argument it has no schema
   for. `list_stitches` does report `POST /v1/refunds`, but a host would have to call a tool to learn
   it, and annotations are fixed at `tools/list` time.
8. **`{+id}` in a path template turns a param into a path.** RFC 6570 reserved expansion does not
   percent-encode `/` (util.ts:369-379), so `params: { id: '../../v1/api-keys' }` normalised onto a
   different endpoint **with the bearer token attached**. The ordinary `{id}` encoded it to
   `..%2F..%2F` and stayed put. Templating the whole endpoint (`url: '{+endpoint}'`) reached
   `metadata.internal` outright.
9. **Nothing is on by default, and nothing measures spend.** Fifty tool calls made fifty vendor
   requests. Every bound the config surface offers is a count (`throttle.rate` spacing,
   `throttle.concurrency`, `retry.attempts`, `paginate.pages`, `circuit.failures`,
   `stream.buffer.chars`) or a duration (`timeout`, `circuit.cooldown`) — the axis the runaway
   incident in the capture actually ran along has no knob.
10. **The stdio transport's serialisation guarantee does not travel.** Eight tool calls written in one
    chunk were answered in request order and still paced, because `serveStdio` chains dispatch
    (mcp.ts:346). `mcp.ts`'s own header invites a host to build a Streamable HTTP transport over the
    same `handle()` — and that host inherits none of it.
