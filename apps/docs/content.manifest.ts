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
    { path: 'concepts', title: 'Concepts', icon: 'Lightbulb' },
    { path: 'guides', title: 'Guides', icon: 'BookOpen' },
    { path: 'guides/authoring', title: 'Authoring & composition' },
    { path: 'guides/auth', title: 'Auth' },
    { path: 'guides/resilience', title: 'Resilience' },
    { path: 'guides/data', title: 'Data shaping' },
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
        path: 'guides/resilience/accept-status',
        title: 'Accept status',
        description:
            'Declare statuses that are a normal result, not an error — an accepted non-2xx flows through transform/unwrap/validate instead of throwing.',
        kind: 'guide',
    },
    {
        path: 'guides/resilience/throttle',
        title: 'Throttle',
        description:
            'Space requests by rate and cap concurrency, scoped per stitch or per host.',
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
        path: 'guides/data/unwrap',
        title: 'unwrap',
        description: 'Pull just the part of the response you want by dot-path.',
        kind: 'guide',
    },
    {
        path: 'guides/data/transform',
        title: 'transform',
        description:
            'Reshape a response before unwrap and validation — for example, scrape HTML into structured data.',
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
            'Call a GraphQL endpoint with variables, unwrap data, and treat a 200 carrying errors as a failure.',
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
            'Swap the in-memory store for a shared one to back throttle and sessions with get/set/incr + TTL.',
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
        path: 'agents/llms-txt',
        title: 'Point an agent at llms.txt',
        description:
            'Feed the auto-generated llms.txt and per-page llms.mdx to an agent for context-frugal docs.',
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
            'StitchConfig and the retry, throttle, timeout, auth, validation, and drift option shapes.',
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
            'fetchAdapter, createTrace, multiplex, the OTLP exporters, memoryStore, and toValidator.',
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
