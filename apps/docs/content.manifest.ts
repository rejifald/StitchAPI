/**
 * StitchAPI docs — content manifest.
 *
 * The single source of truth for the documentation information architecture.
 * The skeleton generator (`scripts/generate-skeleton.mjs`) reads this to emit
 * the folder tree, each `meta.json` (label + page order), and a stub `.mdx`
 * per page using the template for its `kind`.
 *
 * Invariants (enforced by `test/content-manifest.spec.ts`, plus a CI gate that
 * re-runs `gen:docs` and fails on any diff):
 *  - Two-way sync: every `.mdx` under `content/docs` is listed here, and every
 *    entry here has a file. No orphan pages, no undocumented pages. This is the
 *    same anti-drift rule the runtime sells, applied to the docs themselves.
 *    Exception: sections in `HAND_MAINTAINED_SECTIONS` curate their own
 *    `meta.json` and page set, so their pages live outside this manifest.
 *  - `description` is mandatory and is a real sentence — it feeds search,
 *    `llms.txt`, and an agent's relevance decision when the page is pulled as
 *    standalone `llms.mdx`. Never ship a placeholder.
 *  - Error `code`s and their slugs are an API. Once published, never rename a
 *    slug — add a new page and redirect the old one.
 *
 * Page templates and the full rule set live in `AUTHORING.md`.
 *
 * NOTE: the scaffold's stock `content/docs/index.mdx` and `content/docs/test.mdx`
 * are replaced/removed by this IA — `index` below is the new docs home.
 */

export type PageKind =
    | 'landing' // curated orientation page (usually a folder index); hand-shaped
    | 'tutorial' // step-by-step (installation, quickstart); hand-shaped
    | 'concept' // explanation — why it's shaped this way
    | 'guide' // how-to — the workhorse template
    | 'reference' // prose + AutoTypeTable
    | 'error'; // errors & pitfalls catalog entry

export interface Section {
    /** Folder path relative to `content/docs`. `''` is the root. */
    path: string;
    /** Sidebar group label — becomes the folder `meta.json` `title`. */
    title: string;
    /**
     * Optional folder-level blurb — becomes the `meta.json` `description`.
     * Currently only the root section carries one (it feeds the docs home).
     */
    description?: string;
    /** Optional lucide icon name (the lucide-icons source plugin is enabled). */
    icon?: string;
}

export interface Page {
    /** Path relative to `content/docs`, no extension; folders via `/`. */
    path: string;
    /** `title` frontmatter and sidebar link label. */
    title: string;
    /** Mandatory. A real sentence — see the invariants above. */
    description: string;
    kind: PageKind;
    /** Error pages only: the stable registry code, e.g. `STITCH_DRIFT`. */
    code?: string;
}

/**
 * Sidebar groups, in display order. The generator writes one `meta.json` per
 * entry; the root entry orders the top-level groups.
 */
export const sections: Section[] = [
    {
        path: '',
        title: 'Documentation',
        description:
            'API stitching: turn any API into a typed, resilient function — declare an endpoint once and call it like a local function from your code, the CLI, or an agent, without ever touching a credential.',
    },
    { path: 'getting-started', title: 'Getting started', icon: 'Rocket' },
    { path: 'recipes', title: 'Recipes', icon: 'ChefHat' },
    { path: 'scenarios', title: 'Scenarios', icon: 'Map' },
    { path: 'concepts', title: 'Concepts', icon: 'Lightbulb' },
    { path: 'guides', title: 'Guides', icon: 'BookOpen' },
    { path: 'guides/authoring', title: 'Authoring & composition' },
    { path: 'guides/auth', title: 'Auth' },
    { path: 'guides/resilience', title: 'Resilience' },
    { path: 'guides/data', title: 'Data shaping' },
    { path: 'guides/transport', title: 'Transport & adapters' },
    { path: 'guides/validation', title: 'Validation & drift' },
    { path: 'guides/observability', title: 'Observability' },
    { path: 'guides/state', title: 'State & stores' },
    { path: 'guides/testing', title: 'Testing' },
    { path: 'surfaces', title: 'Surfaces', icon: 'Layers' },
    { path: 'integrations', title: 'Integrations', icon: 'Plug' },
    { path: 'agents', title: 'For agents', icon: 'Bot' },
    { path: 'reference', title: 'Reference', icon: 'Code' },
    { path: 'errors', title: 'Errors & pitfalls', icon: 'TriangleAlert' },
];

/**
 * Sections whose `meta.json` and page set are curated by hand, NOT generated
 * from this manifest. The skeleton generator skips them (never rewrites their
 * `meta.json`) and the two-way-sync test exempts their pages. Use this only for
 * a section whose page set churns independently of this file — e.g.
 * integrations, where every shipped `@stitchapi/*` package adds its own page
 * per-PR. The section entry still lives in `sections` (above) so the generator
 * keeps it in its parent's sidebar order.
 */
export const HAND_MAINTAINED_SECTIONS: ReadonlySet<string> = new Set([
    'integrations',
]);

/**
 * Every page, grouped by section in reading order. The generator preserves this
 * order inside each folder's `meta.json`.
 */
export const pages: Page[] = [
    // ── Root ────────────────────────────────────────────────────────────────
    {
        path: 'index',
        title: 'StitchAPI',
        description:
            'The agent-native runtime where a typed, declarative stitch replaces fetch for humans and agents alike.',
        kind: 'landing',
    },

    // ── Getting started ─────────────────────────────────────────────────────
    {
        path: 'getting-started/index',
        title: 'Introduction',
        description:
            'What a stitch is, the integration pain it removes, and how this documentation is organized.',
        kind: 'landing',
    },
    {
        path: 'getting-started/installation',
        title: 'Installation',
        description:
            'Install stitchapi and set up the zero-dependency runtime in Node or the browser.',
        kind: 'tutorial',
    },
    {
        path: 'getting-started/quickstart',
        title: 'Quickstart',
        description:
            'Declare your first stitch from one endpoint and call it as a typed function in five minutes.',
        kind: 'tutorial',
    },
    {
        path: 'getting-started/migration-notes',
        title: 'Migration notes',
        description:
            'Three spec-correct behaviors — lowercase header names, %20 query spaces, and template-narrowed stitch types — that differ from a naive baseline and surprise migrators.',
        kind: 'guide',
    },

    // ── Recipes ─────────────────────────────────────────────────────────────
    {
        path: 'recipes/index',
        title: 'Recipes',
        description:
            'Working examples of common tasks — each one the whole thing in a single block, with links down to the guides for depth.',
        kind: 'landing',
    },
    {
        path: 'recipes/typed-json-round-trip',
        title: 'Send JSON and get a typed result back',
        description:
            'POST a validated body and read a typed, runtime-validated result — input checked before the request, output checked after.',
        kind: 'guide',
    },
    {
        path: 'recipes/define-an-entity-once',
        title: 'Define an entity once, derive every request shape',
        description:
            'Declare a resource schema once and derive the create body, update body, and query filter with your validator’s own .omit()/.partial()/.pick() — no StitchAPI-specific schema layer.',
        kind: 'guide',
    },
    {
        path: 'recipes/paginate-into-one-array',
        title: 'Loop a cursor API into one array',
        description:
            'Follow nextCursor across every page and aggregate the items — no manual while-loop, cursor bookkeeping, or concat.',
        kind: 'guide',
    },
    {
        path: 'recipes/make-a-flaky-call-succeed',
        title: 'Make a flaky call succeed on its own',
        description:
            'Add retry with backoff so transient 429s and 5xxs recover without your code noticing.',
        kind: 'guide',
    },
    {
        path: 'recipes/survive-a-flaky-dependency',
        title: 'Keep a failing dependency from taking you down',
        description:
            'Compose timeout, retry, and a circuit breaker so a degraded upstream fails fast instead of hanging every caller.',
        kind: 'guide',
    },
    {
        path: 'recipes/cancel-an-in-flight-call',
        title: 'Cancel an in-flight call',
        description:
            'Pass an AbortSignal in the call input — aborting severs the request and stops retries, waits, and pagination with it.',
        kind: 'guide',
    },
    {
        path: 'recipes/idempotent-writes',
        title: 'Retry a write without double-charging',
        description:
            'Attach an idempotency key so a retried POST settles once, not twice.',
        kind: 'guide',
    },
    {
        path: 'recipes/catch-a-breaking-api-change',
        title: 'Catch a breaking API change before your users do',
        description:
            'Wrap output with drift to validate every response against the declared schema and catch a dropped required field, a type coercion, or an undeclared new key.',
        kind: 'guide',
    },
    {
        path: 'recipes/catch-a-selector-rename',
        title: 'Catch a silent selector rename in scraped HTML',
        description:
            'Scrape an HTML page into a structured object with transform, then drift the structured shape against its schema so a markup or selector rename becomes a hard contract error instead of a silently missing field.',
        kind: 'guide',
    },
    {
        path: 'recipes/inspect-what-the-server-sent',
        title: 'Inspect what the server actually sent',
        description:
            'Probe a fresh call with .inspect() to read the unredacted raw body next to the validated value and the drift findings diffed between them — without throwing — when you need to see what changed after the fact.',
        kind: 'guide',
    },
    {
        path: 'recipes/watch-a-call-as-it-happens',
        title: 'Watch retries and throttling as they happen',
        description:
            "Iterate a stitch's event stream instead of awaiting it, and observe every retry, pause, and drift in real time.",
        kind: 'guide',
    },
    {
        path: 'recipes/mirror-a-paginated-api',
        title: 'Mirror a paginated API to NDJSON',
        description:
            'Pull every page of a cursor-paginated, OAuth2-protected endpoint — with retry and throttle on each page — and write the rows as newline-delimited JSON.',
        kind: 'guide',
    },
    {
        path: 'recipes/one-rate-limit-across-workers',
        title: 'Share one rate limit across every worker',
        description:
            'Point the throttle at a shared store so a whole fleet draws from a single rate budget instead of N× the limit.',
        kind: 'guide',
    },
    {
        path: 'recipes/auth-as-a-capability',
        title: 'Authenticate without the token touching your code',
        description:
            'Declare auth on the stitch so callers get a capability, not a credential — the secret is read per call and never returned.',
        kind: 'guide',
    },
    {
        path: 'recipes/expose-a-stitch-to-an-agent',
        title: 'Let an agent call your API without handing it the key',
        description:
            'Expose your stitches over MCP through one run_stitch tool — the agent invokes a capability and never sees the credential.',
        kind: 'guide',
    },
    {
        path: 'recipes/one-stitch-every-surface',
        title: 'Call one stitch as a function, a CLI command, and an agent tool',
        description:
            'One definition, four front doors — in-process, shell, HTTP, and MCP — with nothing about the stitch changing.',
        kind: 'guide',
    },

    // ── Scenarios ───────────────────────────────────────────────────────────
    {
        path: 'scenarios/index',
        title: 'Scenarios',
        description:
            'Real integration problems that have no one-line answer anywhere — what the usual fixes cost, what StitchAPI changes, and what it leaves to you.',
        kind: 'landing',
    },
    {
        path: 'scenarios/oauth2-refresh-token-rotation',
        title: 'OAuth2 refresh tokens that rotate',
        description:
            'A single-use refresh token plus two concurrent workers revokes the whole account. What the usual fixes cost, and what a custom auth strategy buys you.',
        kind: 'guide',
    },
    {
        path: 'scenarios/cost-based-rate-limits',
        title: 'Rate limits priced in query cost',
        description:
            'Shopify bills per query cost, answers 200 OK when you overspend, and puts the wait in the body. Why status-code retry and rate-per-second both miss, and what does work.',
        kind: 'guide',
    },
    {
        path: 'scenarios/batch-partial-failure',
        title: 'Batch writes that fail one item at a time',
        description:
            'A bulk endpoint returns 200 and reports that 7 of your 100 items did not land. Retrying the request re-writes the 93 that did — so the retry unit has to be the body, not the call.',
        kind: 'guide',
    },
    {
        path: 'scenarios/async-job-polling',
        title: 'Submit, poll, download — the async job triangle',
        description:
            'A 202 with a Location header, a status endpoint that reports failure at HTTP 200, and a single-use result URL. Three endpoints and a loop, and you have to pick which guarantee you keep.',
        kind: 'guide',
    },
    {
        path: 'scenarios/mid-stream-failure',
        title: 'A stream that fails after 800 tokens',
        description:
            'The 200 was spent on the first token, so the failure arrives in-band or not at all. When a stream can be resumed this is one flag; when it cannot — every LLM API — the flag has nothing to resume from, and the real answer is two small seams of user code.',
        kind: 'guide',
    },
    {
        path: 'scenarios/conditional-requests-304',
        title: 'The free poll — ETag revalidation and the bodyless 304',
        description:
            'A 304 means "use what you have", carries no body, and is not a 2xx. Turning it back into the resource takes one seam — and the cache primitive cannot help.',
        kind: 'guide',
    },
    {
        path: 'scenarios/multipart-upload',
        title: 'The upload you must clean up after',
        description:
            'Multipart upload is four steps, and the fourth — abort on failure — is the one no HTTP client models. Skip it and the parts bill forever, invisibly.',
        kind: 'guide',
    },
    {
        path: 'scenarios/webhook-receipt',
        title: 'Receiving a signed webhook',
        description:
            'StitchAPI does not receive webhooks — that is your server. Here is exactly where the line falls, measured, and what the library does own on the far side of it.',
        kind: 'guide',
    },
    {
        path: 'scenarios/multi-tenant-blast-radius',
        title: "One customer's revoked token, everyone's outage",
        description:
            'Tokens and caches isolate per tenant automatically. Rate budgets and circuit breakers do not — they isolate only by a string you have to remember to write.',
        kind: 'guide',
    },
    {
        path: 'scenarios/provider-failover',
        title: 'Failing over to the backup provider',
        description:
            'Everything per-provider is free and declarative. The routing between them is entirely yours — and the combinator named for this job bills you twice on every successful call.',
        kind: 'guide',
    },
    {
        path: 'scenarios/unstable-pagination',
        title: 'The page that moved while you were reading it',
        description:
            'Offset pagination over a live collection silently returns wrong lists. A client cannot fix that — but it should not report a clean run over data it lost.',
        kind: 'guide',
    },
    {
        path: 'scenarios/intermittent-drift',
        title: 'The vendor changed the shape for 5% of responses',
        description:
            'Leveled drift catches a canary rollout precisely and refuses to invent a value. What it cannot do is tell a harmless coercion from a destructive one.',
        kind: 'guide',
    },
    {
        path: 'scenarios/large-response-memory',
        title: 'The export that eats the heap',
        description:
            'The NDJSON decoder is genuinely O(1) — and the engine retains every chunk one line later, so neither await nor .stream() is memory-bounded.',
        kind: 'guide',
    },
    {
        path: 'scenarios/expiring-signatures',
        title: 'The signature that expired in your own queue',
        description:
            'A rate-limited queue cannot age a SigV4 signature here — the wait happens before signing, by construction. Clock drift still needs 26 lines.',
        kind: 'guide',
    },
    {
        path: 'scenarios/unconfirmed-write',
        title: "The charge you can't confirm",
        description:
            'A timeout tells you nothing about the server. idempotency.keyOf fixes the restart and the race in configuration alone — the default key does not, and it double-charged a re-driven job.',
        kind: 'guide',
    },
    {
        path: 'scenarios/n-plus-one-fanout',
        title: 'One list, a hundred follow-up calls',
        description:
            'cache.coalesce collapses in-flight duplicates — 100 concurrent calls over 30 ids made 30 requests. A coalesced failure is not shared, and that is where it loses.',
        kind: 'guide',
    },
    {
        path: 'scenarios/deprecation-headers',
        title: 'The vendor told you for six months, in a header',
        description:
            'Deprecation and Sunset arrive on responses that succeeded, so nothing fails and nothing retries. Response headers are reachable in exactly three places — here is the table.',
        kind: 'guide',
    },
    {
        path: 'scenarios/agent-holds-the-tool',
        title: 'The agent picks the arguments',
        description:
            'Exposing a vendor API to an LLM over MCP. The credential boundary held under 30 payload scans — the argument boundary is yours, and an input slot with no schema is a full passthrough.',
        kind: 'guide',
    },
    {
        path: 'scenarios/stale-fixture',
        title: 'The mock that passed for six months',
        description:
            'Your fake goes stale and the suite keeps saying green. Resilience and streams test perfectly offline — here is the definitive table of which time-driven features manualClock actually drives.',
        kind: 'guide',
    },
    {
        path: 'scenarios/precision-loss',
        title: 'The ID that changed on the way in',
        description:
            'JSON.parse turns a 64-bit snowflake into a different number, silently. wire.response text plus transform recovers the exact digits in 16 lines.',
        kind: 'guide',
    },
    {
        path: 'scenarios/pii-in-the-logs',
        title: "The customer data you didn't mean to log",
        description:
            'Response bodies reach 13 destinations and metadata reaches 11 — with nothing in between. An output allowlist takes it to zero; sensitive: true does not, and only gates the cache.',
        kind: 'guide',
    },
    {
        path: 'scenarios/dual-run-migration',
        title: 'The migration you have to run twice',
        description:
            'Dual-running a vendor v1 and v2 when you own neither endpoint. One of five isolation channels is safe by default, and the combinator that looks built for this broadcasts one input to both.',
        kind: 'guide',
    },

    // ── Concepts ────────────────────────────────────────────────────────────
    {
        path: 'concepts/the-stitch',
        title: 'The stitch primitive',
        description:
            'A typed, declarative, composable unit that turns input into validated output with auth, resilience, and observability built in.',
        kind: 'concept',
    },
    {
        path: 'concepts/the-seam',
        title: 'The seam',
        description:
            'The shared-runtime primitive a set of stitches belong to — one store, vault, throttle bucket, and trace sink behind a shared base config and a trusted principal boundary.',
        kind: 'concept',
    },
    {
        path: 'concepts/event-stream',
        title: 'The event stream',
        description:
            'Why a stitch returns an async iterable of typed events — start, progress, drift, result, done — instead of Promise<bytes>.',
        kind: 'concept',
    },
    {
        path: 'concepts/run-identity',
        title: 'Run identity & the trace tree',
        description:
            'How a stitch identifies one call and its place in a tree — a shared traceId, the span id (spanId), and a parentSpanId — so composed runs form one OpenTelemetry span tree, and how that maps onto the traceparent header on the wire.',
        kind: 'concept',
    },
    {
        path: 'concepts/correlation-vs-idempotency',
        title: 'Correlation vs idempotency',
        description:
            'Two keys that look alike but answer different questions — an idempotency key decides what makes two attempts the same write, a correlation/trace id identifies one request for logs and spans — and why they stay separate fields.',
        kind: 'concept',
    },
    {
        path: 'concepts/capability-not-credential',
        title: 'Capability, not credential',
        description:
            'How a stitch holds the secret and hands the caller a capability, so an agent invoking it never sees the token.',
        kind: 'concept',
    },
    {
        path: 'concepts/principles',
        title: 'Principles',
        description:
            'Progressive disclosure, atomic stitches, composition over configuration, and the other ideas that shape the API.',
        kind: 'concept',
    },

    // ── Guides · Authoring & composition ────────────────────────────────────
    {
        path: 'guides/authoring/stitch',
        title: 'stitch()',
        description:
            'Declare an endpoint and get back a typed, callable function — the core authoring move.',
        kind: 'guide',
    },
    {
        path: 'guides/authoring/extends',
        title: 'extends',
        description:
            'Layer fragments — strings, objects, or other stitches — with deep-merge to compose configuration.',
        kind: 'guide',
    },
    {
        path: 'guides/authoring/seam',
        title: 'seam',
        description:
            'Group stitches under one shared runtime — store, vault, throttle bucket, and trace sink — behind a shared base config, and bind per-principal sessions with seam.as().',
        kind: 'guide',
    },
    {
        path: 'guides/authoring/with',
        title: '.with() partial application',
        description:
            'Pre-bind part of a call and reuse the same runtime so cookies, throttle, and sessions persist.',
        kind: 'guide',
    },
    {
        path: 'guides/authoring/hooks',
        title: 'Hooks',
        description:
            'Observe a call as it runs — onRequest, onResponse, onError, onRetry — and where each fires relative to auth, retry, throttle, and timeout.',
        kind: 'guide',
    },

    // ── Guides · Auth ───────────────────────────────────────────────────────
    {
        path: 'guides/auth/bearer',
        title: 'bearer',
        description:
            'Attach a bearer token resolved at call time from an env var or a secrets file.',
        kind: 'guide',
    },
    {
        path: 'guides/auth/api-key',
        title: 'apiKey',
        description:
            'Send an API key as a header or query parameter, resolved at call time.',
        kind: 'guide',
    },
    {
        path: 'guides/auth/basic',
        title: 'basic',
        description:
            'HTTP Basic authentication with credentials resolved from a secret resolver.',
        kind: 'guide',
    },
    {
        path: 'guides/auth/cookie-session',
        title: 'cookieSession',
        description:
            'Log in once, capture and replay cookies, and refresh the session on a status code or a soft 200 wall.',
        kind: 'guide',
    },
    {
        path: 'guides/auth/oauth2',
        title: 'oauth2',
        description:
            'OAuth2 client_credentials: fetch, cache, and auto-refresh a token behind the capability boundary.',
        kind: 'guide',
    },
    {
        path: 'guides/auth/secret-resolvers',
        title: 'Secret resolvers',
        description:
            'Resolve secrets lazily at call time with env() and secretsFile() instead of hard-coding them.',
        kind: 'guide',
    },

    // ── Guides · Resilience ─────────────────────────────────────────────────
    {
        path: 'guides/resilience/retry',
        title: 'Retry & backoff',
        description:
            'Retry on configurable status codes with expo/jitter/fixed backoff and respect for Retry-After.',
        kind: 'guide',
    },
    {
        path: 'guides/resilience/verdict',
        title: 'Verdict',
        description:
            'Declare what counts as success — accept a non-2xx as a normal result, or fail a 200 whose body says it failed.',
        kind: 'guide',
    },
    {
        path: 'guides/resilience/throttle',
        title: 'Throttle',
        description:
            'Space requests by rate and cap concurrency, pooled per stitch or per host.',
        kind: 'guide',
    },
    {
        path: 'guides/resilience/timeout',
        title: 'Timeouts',
        description:
            'Enforce total and per-attempt timeouts with a real AbortSignal.',
        kind: 'guide',
    },
    {
        path: 'guides/resilience/circuit-breaker',
        title: 'Circuit breaker',
        description:
            'Stop hammering a failing dependency by opening a circuit after repeated failures.',
        kind: 'guide',
    },
    {
        path: 'guides/resilience/delegate-backoff',
        title: 'Delegate backoff',
        description:
            'Surface rate-limit outcomes as a RateLimitError so an outer gate owns the backoff, instead of retrying and throttling them internally.',
        kind: 'guide',
    },
    {
        path: 'guides/resilience/idempotency',
        title: 'Idempotency keys',
        description:
            "Attach idempotency keys to writes so safe retries don't duplicate side effects.",
        kind: 'guide',
    },

    // ── Guides · Data shaping ───────────────────────────────────────────────
    {
        path: 'guides/data/pick',
        title: 'pick',
        description: 'Pull just the part of the response you want by dot-path.',
        kind: 'guide',
    },
    {
        path: 'guides/data/transform',
        title: 'transform',
        description:
            'Reshape a response before pick and validation — for example, scrape HTML into structured data.',
        kind: 'guide',
    },
    {
        path: 'guides/data/pagination',
        title: 'Pagination',
        description:
            'Auto-loop pages and aggregate items, with auth, retry, and throttle applied to every page.',
        kind: 'guide',
    },
    {
        path: 'guides/data/body-encoding',
        title: 'Body encoding',
        description: 'Send request bodies as json, form, or multipart.',
        kind: 'guide',
    },
    {
        path: 'guides/data/url-shaping',
        title: 'URL shaping',
        description:
            'RFC 6570 path templates and qs-style nested query serialization — how params and query become the URL.',
        kind: 'guide',
    },
    {
        path: 'guides/data/graphql',
        title: 'GraphQL',
        description:
            'Call a GraphQL endpoint with variables, pick data, and treat a 200 carrying errors as a failure.',
        kind: 'guide',
    },

    // ── Guides · Transport & adapters ───────────────────────────────────────
    {
        path: 'guides/transport/adapters',
        title: 'The adapter seam',
        description:
            'Swap the transport a stitch calls through — fetch, axios, xhr, or your own — without changing what the stitch promises its caller.',
        kind: 'guide',
    },
    {
        path: 'guides/transport/fetch-adapter',
        title: 'fetchAdapter',
        description:
            'The default fetch-backed transport, and the undici dispatcher option that threads a proxy, a custom CA, or a bound interface through one stitch.',
        kind: 'guide',
    },
    {
        path: 'guides/transport/axios-adapter',
        title: 'axiosAdapter',
        description:
            'Route a stitch through an axios instance you already configured, keeping its agent, proxy, and interceptors.',
        kind: 'guide',
    },
    {
        path: 'guides/transport/xhr-adapter',
        title: 'xhrAdapter',
        description:
            'Draw an upload progress bar in the browser with an XMLHttpRequest-backed transport, which reports the bytes sent that fetch cannot.',
        kind: 'guide',
    },
    {
        path: 'guides/transport/custom-adapter',
        title: 'Writing an adapter',
        description:
            "Implement the one-function Adapter contract to carry a stitch over a transport StitchAPI doesn't ship, and declare what it supports.",
        kind: 'guide',
    },

    // ── Guides · Validation & drift ─────────────────────────────────────────
    {
        path: 'guides/validation/validation',
        title: 'Validation',
        description:
            'Validate params, query, body, headers, and the response, failing fast before the request when input is wrong.',
        kind: 'guide',
    },
    {
        path: 'guides/validation/drift',
        title: 'Drift detection',
        description:
            'Detect silent contract changes as non-fatal findings by diffing the raw response against the validated value.',
        kind: 'guide',
    },
    {
        path: 'guides/validation/standard-schema',
        title: 'Standard Schema',
        description:
            'Bring any Standard Schema validator — Zod, Valibot, ArkType — for validation and inferred types.',
        kind: 'guide',
    },

    // ── Guides · Observability ──────────────────────────────────────────────
    {
        path: 'guides/observability/trace-sinks',
        title: 'Trace sinks',
        description:
            'Emit the event stream to the console or a JSONL file, or plug in your own TraceSink.',
        kind: 'guide',
    },
    {
        path: 'guides/observability/otlp',
        title: 'OTLP export',
        description:
            'Export traces as OpenTelemetry spans for your existing observability stack.',
        kind: 'guide',
    },

    // ── Guides · State & stores ─────────────────────────────────────────────
    {
        path: 'guides/state/pluggable-store',
        title: 'The pluggable store',
        description:
            'Swap the in-memory store for a shared one to back throttle and sessions with get/set/increment + TTL.',
        kind: 'guide',
    },
    {
        path: 'guides/state/distributed-throttle',
        title: 'Distributed throttle',
        description:
            'Share one rate budget across workers by pointing the throttle at a shared store.',
        kind: 'guide',
    },
    {
        path: 'guides/state/shared-sessions',
        title: 'Shared sessions',
        description:
            'Persist and share a login across stitches and workers via a session key and a shared store.',
        kind: 'guide',
    },

    // ── Guides · Testing ────────────────────────────────────────────────────
    {
        path: 'guides/testing/mocking',
        title: 'Testing',
        description:
            'Mock the transport to test a stitch definition, or swap in a fake stitch to test code that calls one — from stitchapi/testing.',
        kind: 'guide',
    },

    // ── Surfaces ────────────────────────────────────────────────────────────
    {
        path: 'surfaces/function',
        title: 'In-process function',
        description:
            'Call a stitch directly as a typed async function, awaited or streamed.',
        kind: 'guide',
    },
    {
        path: 'surfaces/cli',
        title: 'CLI',
        description:
            'Run and trace stitches from the shell with stitch run and stitch trace.',
        kind: 'guide',
    },
    {
        path: 'surfaces/http-serve',
        title: 'HTTP serve',
        description:
            "Expose a stitch over HTTP for callers that aren't in-process.",
        kind: 'guide',
    },
    {
        path: 'surfaces/mcp',
        title: 'MCP',
        description:
            'Expose a single code-mode run_stitch tool to agents instead of one tool per endpoint.',
        kind: 'guide',
    },

    // ── Integrations ────────────────────────────────────────────────────────
    // Hand-maintained (see HAND_MAINTAINED_SECTIONS): the integrations pages
    // live in content/docs/integrations/meta.json, added per-PR as each
    // @stitchapi/* package ships. Intentionally absent from this manifest.

    // ── For agents ──────────────────────────────────────────────────────────
    {
        path: 'agents/index',
        title: 'Use from an agent',
        description:
            'How an agent invokes, authors, and reasons over stitches — the agent entry point.',
        kind: 'landing',
    },
    {
        path: 'agents/run-stitch-tool',
        title: 'run_stitch & code-mode',
        description:
            'Drive stitches from a sandbox with one context-frugal tool instead of flooding the model with per-endpoint tools.',
        kind: 'guide',
    },
    {
        path: 'agents/author-from-one-example',
        title: 'Author from one example',
        description:
            'Have an agent emit a stitch declaration from a single curl, HAR, or doc snippet.',
        kind: 'guide',
    },
    {
        path: 'agents/adopt-in-your-project',
        title: 'Adopt in your project',
        description:
            'Drop a rule into your repo so any agent reaches for a typed stitch instead of a hand-rolled fetch — by hand, or with npx stitch init.',
        kind: 'guide',
    },
    {
        path: 'agents/token-savings',
        title: 'How the rule saves tokens',
        description:
            'Why the stitch init rule is the cheapest layer of the agent stack — a ~300-token file the agent reads when relevant, not the whole docs corpus.',
        kind: 'guide',
    },
    {
        path: 'agents/llms-txt',
        title: 'Point an agent at llms.txt',
        description:
            'Feed the auto-generated llms.txt and per-page llms.mdx to an agent for context-frugal docs.',
        kind: 'guide',
    },
    {
        path: 'agents/search-over-mcp',
        title: 'Search the docs over MCP',
        description:
            'Connect an agent to the hosted docs MCP — search_docs finds the relevant sections, get_doc reads a full page — for context-frugal retrieval when loading the whole corpus is more than you need.',
        kind: 'guide',
    },

    // ── Reference ───────────────────────────────────────────────────────────
    {
        path: 'reference/stitch',
        title: 'stitch()',
        description: 'Signatures for stitch() and graphql().',
        kind: 'reference',
    },
    {
        path: 'reference/seam',
        title: 'seam()',
        description:
            'SeamConfig — every prop a seam takes, the eight per-endpoint keys it refuses — plus the Seam handle and the lifecycle-free PrincipalSeam that seam.as() returns.',
        kind: 'reference',
    },
    {
        path: 'reference/auth-strategies',
        title: 'Auth strategies',
        description:
            'bearer, apiKey, basic, cookieSession, oauth2, and the env() and secretsFile() resolvers.',
        kind: 'reference',
    },
    {
        path: 'reference/config-types',
        title: 'Config types',
        description:
            'StitchConfig and every nested option shape — wire, retry, backoff, throttle, timeout, circuit, verdict, idempotency, cache, paginate, and drift.',
        kind: 'reference',
    },
    {
        path: 'reference/surfaces',
        title: 'Request surfaces',
        description:
            'http, graphql, sse, stream, and download — the request styles a stitch can speak, each a subpath import riding one engine.',
        kind: 'reference',
    },
    {
        path: 'reference/helpers',
        title: 'Helpers',
        description:
            'fetchAdapter, createTrace, multiplex, the OTLP exporters, memoryStore, the secret-redaction hooks, and the duration, size, and rate token grammars.',
        kind: 'reference',
    },
    {
        path: 'reference/conformance-kits',
        title: 'Conformance kits',
        description:
            'Prove a custom adapter, store, or trace sink implements its seam — from stitchapi/testing, in your own CI.',
        kind: 'reference',
    },
    {
        path: 'reference/events',
        title: 'Event types',
        description:
            'The StitchEvent union and the shape of each event in the stream.',
        kind: 'reference',
    },

    // ── Errors & pitfalls ───────────────────────────────────────────────────
    // Seed registry — PROVISIONAL until the runtime error-taxonomy refactor.
    // Each code below is grounded in documented runtime behavior; reconcile the
    // final set with the named error classes when the runtime gains codes + url.
    {
        path: 'errors/index',
        title: 'Errors & pitfalls',
        description:
            'How StitchAPI errors work, the code-to-docs contract, and an index of every coded failure.',
        kind: 'landing',
    },
    {
        path: 'errors/stitch-validation',
        title: 'STITCH_VALIDATION',
        description: 'Input or response failed schema validation.',
        kind: 'error',
        code: 'STITCH_VALIDATION',
    },
    {
        path: 'errors/stitch-drift',
        title: 'STITCH_DRIFT',
        description:
            'A required field was missing or incompatible, breaking the response contract.',
        kind: 'error',
        code: 'STITCH_DRIFT',
    },
    {
        path: 'errors/stitch-auth-wall',
        title: 'STITCH_AUTH_WALL',
        description:
            'Authentication failed, or a soft 200 login wall was hit and could not be refreshed.',
        kind: 'error',
        code: 'STITCH_AUTH_WALL',
    },
    {
        path: 'errors/stitch-timeout',
        title: 'STITCH_TIMEOUT',
        description: 'A total or per-attempt timeout aborted the call.',
        kind: 'error',
        code: 'STITCH_TIMEOUT',
    },
    {
        path: 'errors/stitch-circuit-open',
        title: 'STITCH_CIRCUIT_OPEN',
        description:
            'The circuit breaker is open after repeated failures and short-circuited the call.',
        kind: 'error',
        code: 'STITCH_CIRCUIT_OPEN',
    },
    {
        path: 'errors/stitch-graphql',
        title: 'STITCH_GRAPHQL',
        description:
            'A GraphQL 200 response carried an errors array and failed the call.',
        kind: 'error',
        code: 'STITCH_GRAPHQL',
    },
    {
        path: 'errors/rate-limit',
        title: 'RateLimitError',
        description:
            'A delegate-backoff stitch surfaced a rate-limit response for an outer gate to back off on, instead of retrying it.',
        kind: 'error',
        code: 'RateLimitError',
    },
];
