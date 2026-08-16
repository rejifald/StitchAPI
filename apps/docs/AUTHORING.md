# Authoring StitchAPI documentation

This is the contract for writing docs pages. Read it before you write one.

This guide governs **structure** — templates, sections, twoslash, tabs, the
manifest. How the prose _reads_ — voice, economy, how a claim is shown rather than
asserted — is the separate, equally-mandatory contract in
[`EDITORIAL.md`](./EDITORIAL.md). A page must pass both.

It matters more than a usual style guide because the first content pass ships
the **structure only** — every page starts life as a generated stub. There is no
finished page to copy yet, so **this guide plus [`content.manifest.ts`](./content.manifest.ts)
_are_ the exemplar.**

Audience: human writers **and** agents. Every rule below is chosen so a page
works equally well rendered in a browser and pulled out of context as a
machine-readable `llms.mdx`.

---

## How the site is built

- **Engine:** Fumadocs (Next.js App Router). Pages are MDX with frontmatter under
  `content/docs/`.
- **Structure is data:** [`content.manifest.ts`](./content.manifest.ts) is the
  source of truth for the information architecture — every page (path, title,
  description, kind) and every sidebar group. The skeleton generator reads it to
  emit folders, each `meta.json`, and a stub `.mdx` per page.
  **A page that isn't in the manifest doesn't exist; a manifest entry with no
  file is a bug.** Don't reorganize the tree by hand — change the manifest.
  `test/content-manifest.spec.ts` and a CI `gen:docs` diff gate enforce this
  two-way sync, so a drifted manifest fails the build.
    - **Exception — hand-maintained sections:** a section listed in
      `HAND_MAINTAINED_SECTIONS` (e.g. `integrations`, whose pages are added
      per-PR as each `@stitchapi/*` package ships) curates its own `meta.json`
      and page set. The generator skips it and the sync test exempts its pages,
      so for those folders you edit `meta.json` by hand and the manifest stays
      out of it.
- **Machine-readable output is automatic:** Fumadocs emits `llms.txt`,
  `llms-full.txt`, and a per-page `llms.mdx` from your content. You never write
  these — but [rule 5](#authoring-rules) exists because of them.

## Information architecture

Ten top-level groups, ordered for a first read (the order in the root
`meta.json`):

**Getting started → Recipes → Scenarios → Concepts → Guides → Surfaces →
Integrations → For agents → Reference → Errors & pitfalls.**

Guides are **fine-grained** — one page per feature — grouped into capability
subfolders (`authoring`, `auth`, `resilience`, `data`, `validation`,
`observability`, `state`). Fine-grained is deliberate: one page per feature means
one focused `llms.mdx` per feature, so an agent pulls just the `cookieSession`
page into context, not the whole auth manual.

**Scenarios** (`content/docs/scenarios`) sit inside the docs tree and inside the
manifest, but answer a different question than a guide does: a guide teaches a
feature, a scenario takes one integration problem end-to-end across several
features and says what the library does _not_ solve. They carry their own
inbound-linking rule. See [Scenarios](#scenarios).

The **blog** (`content/blog`, served at `/blog`) is a **separate collection** with
its own rules — flat files, dated frontmatter, prose-first, and its own
interlinking convention. See [Blog posts](#blog-posts). Everything above this
line is about the `content/docs` tree.

---

## The four templates

Pick the template by the page's `kind` in the manifest. Copy the skeleton
verbatim, then fill it. Required sections are marked `(required)` — don't drop
them; don't add a fifth top-level section without a reason.

> **Frontmatter:** the page schema (`pageSchema`) allows `title`, `description`,
> and `icon`, plus an optional `prerequisites` list — see
> [Prerequisites](#prerequisites--the-upstream-pointer). `kind` and `code` live in
> the manifest, not the frontmatter. Keep the rest to `title` + `description`.

### Guide — the workhorse (`kind: guide`)

<!-- prettier-ignore -->
````mdx
---
title: cookieSession
description: Log in once, capture and replay cookies, and refresh the session on a status code or a soft 200 wall.
---

{/* What & when (required) — 1–2 sentences: what this does + when you reach for
it. Leads the page because it is also the agent's relevance signal in llms.mdx.
No heading. */}
Use `cookieSession` when an API authenticates with a login form and a cookie
instead of a token, and you want the session captured, replayed, and refreshed
for you.

## Example {/* (required) */}

{/* The smallest stitch that uses the feature, above the fold. Twoslash — see
"Code examples" below. */}
```ts twoslash
import { stitch } from 'stitchapi';
import { cookieSession, env } from 'stitchapi/auth';

const signIn = stitch({
    method: 'POST',
    path: 'https://api.example.com/auth/sign-in',
});

const listUsers = stitch({
    path: 'https://api.example.com/users',
    pick: 'data',
    auth: cookieSession({
        login: signIn,
        cookie: 'session_token',
        loginInput: () => ({
            body: { email: env('APP_USER')(), password: env('APP_PASS')() },
        }),
        refresh: 401,
    }),
});
```

## Options {/* (required) */}

{/* Only the options that matter here, with defaults. Link to Reference for the
exhaustive table — never paste a full type table into a guide (rule 6). */}
`refresh` re-runs the login: a bare `StatusMatch` (`refresh: 401`) matches a
status code, and `refresh: { when }` takes a content predicate (for soft 200
walls). See
[Reference → Auth strategies](/docs/reference/auth-strategies) for every field.

<Callout type="warn">
    **Anti-pattern:** don't reach for X here — do Y instead. Tempting-but-wrong
    uses and one-line micro-gotchas go inline like this, at the point of
    temptation (rule 10). Anything systemic gets a catalog page instead — link it
    under See also.
</Callout>

## See also {/* (required) */}

<Cards>
    <Card title="Shared sessions" href="/docs/guides/state/shared-sessions" />
    <Card title="Capability, not credential" href="/docs/concepts/capability-not-credential" />
    <Card title="STITCH_AUTH_WALL" href="/docs/errors/stitch-auth-wall" />
</Cards>
````

### Concept (`kind: concept`)

Explanation, not how-to. No step lists, no "do this then that" — that's a guide.

<!-- prettier-ignore -->
````mdx
---
title: The event stream
description: Why a stitch returns an async iterable of typed events instead of Promise<bytes>.
---

{/* What it is (required) — 1–2 sentences. */}
A stitch returns an async iterable of typed events —
`start → progress → drift → result → done` — not `Promise<bytes>`.

## Why it's shaped this way {/* (required) */}

{/* The mental model and the design rationale. This is the heart of a concept
page. */}

## How it relates {/* (required) */}

{/* How this connects to other concepts and to the features that use it. */}

## See also {/* (required) */}

<Cards>
    <Card title="Guide: trace sinks" href="/docs/guides/observability/trace-sinks" />
</Cards>
````

### Reference (`kind: reference`)

Hybrid: editorial prose for orientation, generated tables for the shapes.

<!-- prettier-ignore -->
````mdx
---
title: Config types
description: StitchConfig and the retry, throttle, timeout, auth, validation, and drift option shapes.
---

{/* One line on what this page documents. */}
The configuration object accepted by `stitch()`.

## StitchConfig {/* (required: signature) */}

```ts twoslash
import type { StitchConfig } from 'stitchapi';
```

{/* (required: the no-drift table) Generated from the real type — never
hand-write a type table. See "Type tables" below. */}

<AutoTypeTable path="../../packages/core/src/types.ts" name="StitchConfig" />

## See also {/* (required) */}

<Cards>
    <Card title="Guide: stitch()" href="/docs/guides/authoring/stitch" />
</Cards>
````

### Errors & pitfalls (`kind: error`)

The most rigid template, and the most agent-facing — the runtime's future
`error.url` deep-links straight here. The page slug is that URL; treat it as an
API (rule 9).

<!-- prettier-ignore -->
````mdx
---
title: STITCH_AUTH_WALL
description: Authentication failed, or a soft 200 login wall was hit and could not be refreshed.
---

## What you'll see {/* (required) */}

{/* The symptom, with the literal error message where possible. */}

## Why it happens {/* (required) */}

{/* The trigger. */}

## How to fix {/* (required) — the payoff. */}

{/* Concrete remediation steps. */}

## Related {/* (required) */}

<Cards>
    <Card title="Guide: cookieSession" href="/docs/guides/auth/cookie-session" />
</Cards>
````

---

## Prerequisites — the upstream pointer

`See also` and the blog's "Related reading" footer point a reader **onward** — to
the next page, the sibling argument. Nothing points **back**. A reader who lands
cold on an advanced page (parallel composition, a distributed throttle, an MCP
recipe) gets no signal for the foundational concept the prose already assumes.

`prerequisites` is that signal: an **optional** frontmatter list of internal hrefs
to the foundational pages a page leans on. The renderer resolves each to its real
title from source — so the link text can't drift — and shows a **"New to stitches?
Start here"** box at the _top_ of the page. It is the inverse of `See also`: a step
_back_ before diving in, and it works the same on a docs page and a blog post.

```yaml
---
title: Run independent API calls in parallel
description: When calls do not depend on each other, run them concurrently.
prerequisites: ['/docs/concepts/the-stitch', '/docs/concepts/the-seam']
---
```

- **Aim at the foundational set, not at siblings.** The usual targets are
  `/docs/concepts/the-stitch`, `/docs/concepts/the-seam`,
  `/docs/concepts/event-stream`, `/docs/concepts/capability-not-credential`, and
  `/docs/getting-started/quickstart`. One or two is plenty — it's a heads-up, not
  a syllabus.
- **Only when the opening assumes prior knowledge.** A page that self-grounds in
  its first sentence — states its premise, defines its term — needs none, and the
  foundational pages themselves never declare one.
- **Cross-surface is normal.** A blog post pointing at
  `/docs/concepts/the-stitch` is the common case; a docs page may point at
  another docs page.
- **Every href must resolve.** `test/prerequisites.spec.ts` fails the build on a
  dangling or self-referential prerequisite — the same no-orphans guarantee the
  blog's sibling links carry. The box silently drops a broken link at runtime, so
  that gate is the only thing that flags it. Keep it green.

---

## Authoring rules

1. **Examples are Twoslash, always.** Every code block is type-checked against
   the real `stitchapi` at build time. A snippet that calls a renamed
   option fails the build. See [Code examples](#code-examples--twoslash).
2. **Frontmatter is `title` + `description`, both mandatory.** `description` is a
   real sentence — it's the search result, the `llms.txt` line, and the agent's
   relevance signal. No placeholders, no fragments.
3. **Neutral naming.** No real third-party service names — use archetypes ("the
   SaaS", "the aggregator"). The canonical host is the first-party demo API
   **`api.example.com`**, which the sandbox simulator serves so examples run.
   (This is a locked project convention, not a docs-only rule.) Draw every example
   from the shared roster — see
   [The canonical example world](#the-canonical-example-world).
4. **Terminology.** "stitch" is lowercase, both noun and verb. Say "capability,
   not credential" and "the event stream". Never "SDK", "endpoint wrapper", or
   "client".
5. **Self-contained pages.** Each page must stand alone when extracted into
   `llms.mdx`. No "as we saw above" or "continuing from the previous page" —
   restate the one-line premise and link instead.
6. **One source of truth per fact.** Full type tables live only in Reference;
   error remediation lives only in Errors & pitfalls; positioning lives only on
   the entry pages. Everywhere else, link. This is the anti-drift rule the
   product sells, applied to the docs.
7. **`See also` is mandatory.** Fine-grained pages strand readers without it.
   Every page links to its neighbors, its Reference entry, and any relevant
   catalog pages.
8. **Backfill TSDoc as you go.** Writing a Reference page means adding or
   extending TSDoc on the types it documents — that's what enriches the
   generated `AutoTypeTable`, and it pays down the near-empty TSDoc on
   `types.ts`.
9. **Alternatives are tabs, not prose.** When the same outcome has more than one
   equivalent form — package manager, import style, how a stitch is declared, how
   its result is consumed — show the forms as tabs and let the reader's pick
   persist. Never write "you can also…" and never pick one form for the reader
   while hiding the rest. See [Code variants — tabs](#code-variants--tabs).
10. **Anti-patterns go inline, at the point of temptation.** Where a feature has
    a tempting-but-wrong use — the shortcut a reader reaches for right before it
    bites them — flag it with a `<Callout type="warn">` in the section that
    introduces that use, never in a separate "best/bad practices" page. Lead with
    **Anti-pattern** and write it as _don't X — do Y instead_, so the fix travels
    with the warning. Keep it to the one decision in front of the reader; a
    systemic failure mode is a catalog page in Errors & pitfalls (link it under
    `See also`), not a restated list elsewhere (rule 6).

---

## The canonical example world

Every example everywhere draws from **one demo API** — `https://api.example.com`
— and a fixed roster of named stitches. The host is **first-party and served by the
sandbox simulator** (a fetch-shim that never touches the network), so the snippet a
page shows is the snippet that _runs_ in the playground and the sandbox MCP. Reuse
the same names: a reader who meets `getUser` on the intro page recognizes it on the
auth page and in the playground — one example world, no drift.

### The base

Assumed by every page. A page inlines only the slice it needs — but when it needs
a `baseUrl`, a type, or shared auth, it uses _these_, verbatim:

<!-- prettier-ignore -->
```ts
import { seam } from 'stitchapi';
import { bearer, env } from 'stitchapi/auth';
import { z } from 'zod';

// Types — reuse these exact shapes (they match what the sim returns).
const User  = z.object({ id: z.number(), name: z.string(), email: z.string(), role: z.enum(['admin', 'member', 'viewer']) });
const Order = z.object({ id: z.number(), total: z.number(), status: z.enum(['open', 'paid', 'shipped']) });

// The shared base every stitch extends — or a `seam`, when runtime state is shared.
const api = seam({
    baseUrl: 'https://api.example.com',
    auth: bearer(env('API_TOKEN')),
    retry: { attempts: 3, on: [429, 503] },
});
```

### The roster

Each stitch is the canonical demonstration of **one** capability. Reach for the
row that matches what the page teaches; don't coin a new stitch for a shape one of
these already shows. (The sim wraps every payload in a `{ data }` envelope, so each
stitch `unwrap`s it.)

<!-- prettier-ignore -->
```ts
const getUser    = api.stitch({ path: '/users/{id}', pick: 'data', output: User });
const listUsers  = api.stitch({ path: '/users', pick: 'data', output: User.array() });
const createUser = api.stitch({ method: 'POST', path: '/users', input: { body: User.omit({ id: true }) },
                               pick: 'data', output: User });
const listOrders = api.stitch({ path: '/users/{id}/orders', pick: 'data', output: Order.array() });
```

| Stitch       | Endpoint                             | The canonical demo of                                                                                  |
| ------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `getUser`    | `GET /users/{id}` → `User`           | the intro · path params · typed output · drift · all four surfaces                                     |
| `listUsers`  | `GET /users?role&sort` → `User[]`    | query builder · pagination · `.with()` — `const admins = listUsers.with({ query: { role: 'admin' } })` |
| `createUser` | `POST /users` → `User`               | input validation · `bodyType` · `.safe()` and errors                                                   |
| `listOrders` | `GET /users/{id}/orders` → `Order[]` | nested resource · drift on money/status · `transform` / `unwrap` · throttle                            |
| `events`     | `SSE /events` (`stitchapi/sse`)      | the streaming surfaces · the event spine                                                               |

### Auth, secrets, surfaces — same names everywhere

- **Auth deep-dives reuse the base:** `cookieSession` logs in via a `signIn`
  stitch; `oauth2` hangs off `api`. Secrets are **always** `API_TOKEN`,
  `APP_USER` / `APP_PASS`, `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET`.
- **The four surfaces always show `getUser`**, so the comparison is
  apples-to-apples: `await getUser({ params: { id: '42' } })` ·
  `stitch run getUser --id 42` · `GET /get-user` · `tool: get_user`.
- **GraphQL** mirrors `getUser` against `/graphql` — the surface contrast is the
  same operation, not a new one.

**Extending the roster.** Only when a feature needs a shape these can't show
(e.g. a `multipart` upload, a binary `download`). Add the stitch to this section
first — same base, same `api.example.com` — and add a matching handler to the
[sandbox simulator](../../docs/sandbox/contracts/sim.ts) so it still runs. A
one-off domain invented inline is exactly what this section exists to stop.

---

## Code examples — Twoslash

Write the fence as `ts twoslash`:

````md
```ts twoslash
import { stitch } from 'stitchapi';

// ...
```
````

Twoslash compiles the snippet against the workspace's real `stitchapi`
types during the docs build, renders inline type hovers, and **fails the build
on a type error**. That's the whole point: examples cannot silently drift from
the runtime.

- Imports must resolve to published entry points (`stitchapi`), not deep
  paths.
- To intentionally show an error, use Twoslash's `// @errors:` directive — don't
  ship an un-annotated broken snippet.
- One-time pipeline wiring (the `fumadocs-twoslash` transformer in
  `source.config.ts`) is a tooling task, separate from writing pages.

## Folding setup code

Every example is a complete, compiling program (rule 1), so it carries scaffolding
the reader didn't come for — imports, a validation schema, a type declaration.
Wrap that scaffolding in a fold so the block opens on the focal code, with a
**Show full example** toggle to reveal the rest:

<!-- prettier-ignore -->
````md
```ts twoslash
// [!code fold:start]
import { stitch } from 'stitchapi';
import { z } from 'zod';

// [!code fold:end]
const getUser = stitch({
    baseUrl: 'https://api.example.com',
    path: '/users/{id}',
    output: z.object({ id: z.number(), name: z.string() }),
});
```
````

- **`// [!code fold:start]` … `// [!code fold:end]`** are whole-line markers; the
  lines between them collapse and the markers themselves never render. Put `:end`
  after the trailing blank line so the collapsed view opens cleanly on the code.
- **The folded code stays real.** It's still type-checked by Twoslash and still in
  the page source — this hides it, it doesn't cut it (contrast Twoslash's
  `// ---cut---`, which deletes setup from the output with no way back).
- **This is not a tab (rule 9).** Tabs are for _equivalent variants_ the reader
  chooses between (`pnpm`/`npm`, `String form`/`Config object`). A fold is one
  example at two zoom levels, so it stays out of the tab system: no `tabGroup`, no
  persisted bar. Fold _inside_ a tab freely — it's a property of one block.
- **Fold the boilerplate, not the lesson.** Collapse imports, schema setup, and
  type plumbing. Never fold the line the page is actually teaching.

The pipeline wiring (`transformerFold` in `source.config.ts` + the `pre` override
in `components/mdx.tsx`) is a one-time tooling task, separate from writing pages.

## Code variants — tabs

If a snippet has an equivalent alternative, show the alternatives as **tabs**
(rule 9). The reader chooses once and the choice persists across the whole site.
Three mechanisms, by case.

### Install commands → `package-install`

One fence tagged `package-install` becomes npm / pnpm / yarn / bun tabs,
auto-converted from the npm form. Write only the package name(s):

````md
```package-install
stitchapi
```
````

This is the **one** code block that isn't Twoslash (rule 1) — it's a shell
command, not TypeScript. The package-manager pick persists site-wide; that's
wired once in [`source.config.ts`](./source.config.ts) via
`remarkNpmOptions.persist`, so individual pages do nothing.

### Equivalent code → `tab=` on consecutive fences

Give each equivalent form its own `ts twoslash` fence, tagged with a `tab` label
and a shared `tabGroup`. Consecutive tagged fences merge into one tabbed block,
and every one still type-checks (rule 1):

````md
```ts twoslash tab="String form" tabGroup="definition-style"
import { stitch } from 'stitchapi';

const getUser = stitch('https://api.example.com/users/{id}');
```

```ts twoslash tab="Config object" tabGroup="definition-style"
import { stitch } from 'stitchapi';
import { z } from 'zod';

const getUser = stitch({
    path: 'https://api.example.com/users/{id}',
    output: z.object({ id: z.number(), name: z.string() }),
});
```
````

`tabGroup` is the **persistence key**: the same id on every page means a reader
who picks "Config object" once sees it everywhere. Drop `tabGroup` and the tabs
still render, but the choice won't stick.

### Code + prose per variant → `<Tabs>`

When a variant needs a sentence of explanation, not just code, use the component
and set `groupId` + `persist` so it persists like the fenced form:

````mdx
<Tabs groupId="runtime" persist items={['Programmatic', 'CLI']}>
  <Tab value="Programmatic">
    ```ts twoslash
    import { stitch } from 'stitchapi';

    const getUser = stitch('https://api.example.com/users/{id}');
    const user = await getUser({ params: { id: 7 } });
    ```

  </Tab>
  <Tab value="CLI">
    The same stitch, no app boot — flags map to `params` / `query` / `body`.
    ```bash
    stitch run getUser --id 7
    ```
  </Tab>
</Tabs>
````

### The canonical axes

Reuse these `tabGroup` ids and labels **exactly** — matching ids are what let a
choice persist from page to page. The first label is the default the reader
lands on, so make it the recommended form.

| `tabGroup`         | Use when                                | Labels — first is the default                           |
| ------------------ | --------------------------------------- | ------------------------------------------------------- |
| `package-manager`  | install / `npx` commands                | npm · pnpm · yarn · bun — _generated, don't hand-write_ |
| `definition-style` | a stitch is declared ≥2 equivalent ways | `String form` · `Config object`                         |
| `module`           | imports differ by module system         | `ESM` · `CommonJS`                                      |
| `consumption`      | how a stitch's result is consumed       | `await` · `Stream` · `.then()`                          |
| `runtime`          | the same operation in code vs the shell | `Programmatic` · `CLI`                                  |
| `approach`         | a stitch snippet vs the hand-rolled way | `StitchAPI` · `fetch`                                   |

Four rules keep it coherent:

- **Always set `tabGroup`.** It's the persistence key, not decoration.
- **Lead with the recommended form.** The first tab is where the reader lands.
- **Show 2–4 relevant variants, not all of them.** The `extends` page leads
  with the config-object tab; it doesn't parade all twelve call styles.
- **A new axis is a new row here first.** Don't coin ad-hoc `tabGroup` values
  inline — add the row above, then use it, so persistence stays consistent.

### `approach` — the "peek at the hand-rolled way" axis (blog)

`approach` is the one axis aimed squarely at blog posts. A post that is about a
**stitch-only feature** — one that has no fetch-vs-stitch prose "before" — stays
stitch-first, and offers the equivalent raw-`fetch` code as an on-demand second
tab on its **hero snippet**. The reader lands on `StitchAPI` and can switch to
`fetch` to see what the same outcome costs by hand; the choice persists site-wide.

Specific to this axis:

- **`StitchAPI` is always the default (first) tab.** The point is to stay
  stitch-first; the `fetch` tab is the comparison, not the lede.
- **The `fetch` tab must be an _honest_ equivalent of that hero snippet** — the
  naive hand-rolled version a reader would actually write, so the contrast is
  real (the boilerplate the stitch folds in is visibly present, or visibly
  absent). Don't gold-plate it and don't strawman it.
- **Hero snippet only, and only where an honest equivalent exists.** Don't tab
  every block, and skip it where there's no faithful `fetch` form (a `pipe()`
  composition, a CLI command, a conceptual essay with no single API call).
- **Both fences are `twoslash`** (the blog gate requires it — see "Blog
  posts"). The `StitchAPI` tab type-checks against the real `stitchapi` types
  like any other snippet. The `fetch` tab is a deliberately hand-rolled
  baseline that imports no `stitchapi`, so it carries an in-block `// @noErrors`
  — the gate's sanctioned escape hatch — keeping the fence uniform and the
  exception explicit:
  ` ```ts twoslash tab="fetch" tabGroup="approach" ` then `// @noErrors`.
- **Posts that already carry a fetch-vs-stitch prose "before" don't need this**
  — they've made the comparison already.

## Type tables — AutoTypeTable

Reference pages render option shapes from the **actual** TypeScript with
`fumadocs-typescript`:

<!-- prettier-ignore -->
```mdx
<AutoTypeTable path="../../packages/core/src/types.ts" name="StitchConfig" />
```

- `path` is relative to the MDX file; `name` is the exported type.
- Never hand-write a prop table — it will drift. If a field needs explanation,
  add TSDoc to the type (rule 8) and the table picks it up.
- Type tables belong in Reference only; guides link to them (rule 6).

## The error code registry

Errors & pitfalls is keyed to a registry of stable codes (`STITCH_VALIDATION`,
`STITCH_DRIFT`, `STITCH_AUTH_WALL`, `STITCH_TIMEOUT`, `STITCH_CIRCUIT_OPEN`,
`STITCH_GRAPHQL` — provisional until the runtime taxonomy refactor lands).

- One catalog page per code. The page **slug is the URL** the runtime will point
  to in a thrown error (`/errors/<slug>`).
- **Slugs are an API.** Once a page is published, never rename its slug — add a
  new page and redirect the old one.
- The registry of codes will live in `packages/core` and be the shared source of
  truth for both the runtime (which throws the code + url) and these pages.

---

## Scenarios

A scenario (`content/docs/scenarios`, `kind: guide` in the manifest) takes one
real integration problem from symptom to working shape. Where a **recipe** shows a
task with a known good answer and a **guide** teaches one feature, a scenario
covers a problem whose honest answer is a trade-off — so it crosses several
features, names the solutions the ecosystem converged on and what each costs, and
ends by stating plainly what StitchAPI does **not** solve there.

The page shape is the guide template plus two sections that are mandatory here:

- **The common solutions** — a table of the approaches people actually reach for
  and where each breaks. A scenario without this reads as marketing.
- **What StitchAPI does not solve here** — the numbered list of remaining work.
  This is the section that makes the page trustworthy; never trim it to look
  better.

**Every claim is measured, not read off the source.** A scenario's numbers come
from a runnable probe under `docs/scenarios/proofs/<slug>/`, and the finding
ledger (`docs/scenarios/LEDGER.md`) records what was filed and what fixed it. When
core behavior changes, re-run the probes before trusting a page — a scenario
describing behavior that has since been fixed is worse than no page.

**Every scenario needs an inbound link from outside the section.** A scenario is a
deep-dive hung off a primitive the docs already teach, so the page teaching that
primitive is what must point at it — inline, at the sentence where the limitation
comes up, never as a bare "see also" dump:

> `on` … defaults to `[429, 502, 503, 504]`. The predicate receives the status and
> nothing else, so a vendor that reports throttling in the body of a `200` is
> invisible to every policy you can write here —
> [rate limits priced in query cost](/docs/scenarios/cost-based-rate-limits) works
> that case through a surface instead.

`test/scenario-interlinking.spec.ts` is the gate: it fails on a scenario nothing
links to, on a dangling `/docs/scenarios/<slug>` link anywhere in `content`, and
on one host page hoarding the section's inbound links (which just rebuilds the
cul-de-sac a level up). Spread them — the right host is the page whose primitive
the scenario stresses.

**Writing a new scenario — the checklist:**

1. Write the probes first; the page reports what they measured.
2. Fill the template, including both mandatory sections above.
3. Add the page to `content.manifest.ts` and `content/docs/scenarios/meta.json`.
4. Add the inbound link from the guide/reference/post that teaches the primitive.
5. Add the scenario to the `<Cards>` grid on `scenarios/index.mdx`.
6. Run `pnpm test` in `apps/docs` — the interlinking gate must stay green.

---

## Blog posts

The blog (`content/blog`, served at `/blog`) is a separate fumadocs collection
from the docs tree — flat `.mdx` files, no `content.manifest.ts`, no `meta.json`,
no IA drift guard. A post is a dated essay aimed at a search query or a
positioning argument, not a reference page. Most docs rules above (Twoslash,
neutral naming, the canonical roster, anti-patterns inline) still apply; the
differences are below.

**Frontmatter.** Posts add `author`, `date` (an ISO `YYYY-MM-DD` string, quoted),
and an optional `tags` array, on top of the mandatory `title` + `description`.
Posts may also declare `prerequisites` — the upstream "Start here" pointer docs
pages use — most often aimed at a `/docs/concepts/*` page a cold reader needs first
(see [Prerequisites](#prerequisites--the-upstream-pointer)). The schema lives in
`source.config.ts` (the `blog` collection).

```yaml
---
title: 'How to Retry a Failed Fetch in TypeScript (the Right Way)'
description: A real, search-shaped sentence — the meta description and the agent's relevance signal.
author: Oleksandr Zhuravlov
date: '2026-06-28'
tags: [retry, fetch, typescript, resilience, http]
---
```

`tags` are not decorative: the "Related reading" footer under every post is
generated from tag overlap (`getRelatedPosts` in `lib/blog.ts`). Tag honestly —
share a tag with the posts a reader of this one should see next.

**Interlink in prose — this is the rule the product sells, applied to the blog.**
Every post must link to **sibling posts inline**, in the sentence where the
related idea comes up, with a descriptive anchor — never a bare "click here" and
never a detached "further reading" dump as the only connection. The automated
footer is a safety net, not a substitute: it catches the post a reader lands on,
but inline links are what carry a reader _mid-argument_ to the post that goes
deeper.

- **Link down to docs** for the canonical mechanism — the primitive, the guide,
  the reference, the error. `[the stitch](/docs/concepts/the-stitch)`.
- **Link across to sibling posts** for the adjacent argument or the next step —
  `([schema drift is a production bug](/blog/schema-drift-is-a-production-bug))`.
- **Anchor on the idea, not the URL.** The link text reads as part of the
  sentence: _"…shares one limiter across every stitch hitting that host
  ([proactive throttling beats reacting to 429s](/blog/proactive-throttling-vs-reactive-429s))."_

A good post threads two-to-four such links through its body and closes by pointing
at the obvious next read. A post that links to **no** sibling post fails
`test/blog-interlinking.spec.ts` (the no-orphans gate) — the same way a docs page
without `See also` strands its reader. Dangling `/blog/<slug>` links fail it too.

**Writing a new post — the interlinking checklist:**

1. Before drafting, skim `content/blog` for the two or three posts nearest your
   topic. Those are your inbound and outbound links.
2. As you write, link each sibling post **at the point its idea appears**, not in
   a trailer.
3. Add an inline link **back from** at least one of those existing posts to the
   new one, so the new post isn't a dead end others can't reach. (The footer
   surfaces it automatically once tags overlap, but an inbound prose link is
   stronger.)
4. Give the post `tags` that overlap its true neighbors so the "Related reading"
   footer resolves to the right posts.
5. Run `pnpm test` in `apps/docs` — the no-orphans gate must stay green.

---

## Definition of done (per page)

- [ ] Listed in `content.manifest.ts`; file path matches.
- [ ] `title` + `description` frontmatter; `description` is a real sentence.
- [ ] Uses the correct template for its `kind`; all `(required)` sections present.
- [ ] Every TypeScript code block is `ts twoslash` and builds clean (install,
      CLI, and CommonJS blocks are the exception — they aren't TypeScript).
- [ ] Equivalent forms (install, import, definition, consumption) are tabs with a
      canonical `tabGroup`, not prose alternatives.
- [ ] No hand-written type tables; shapes come from `AutoTypeTable`.
- [ ] Neutral names only; `api.example.com` for hosts. Examples come from the
      canonical roster (`getUser` / `listUsers` / `createUser` / `listOrders` /
      `events`), not a one-off domain.
- [ ] Reads correctly in isolation (imagine it as a lone `llms.mdx`).
- [ ] `See also` links neighbors, the Reference entry, and any catalog pages.
- [ ] If the opening assumes a foundational concept, `prerequisites` points
      upstream to it (hrefs that resolve); foundational pages declare none.
- [ ] Any tempting-but-wrong use is flagged with an inline **Anti-pattern**
      `<Callout type="warn">` at the point of temptation, not a separate
      section (rule 10) — omit only when the page has no such pitfall.
