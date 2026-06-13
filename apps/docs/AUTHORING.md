# Authoring StitchAPI documentation

This is the contract for writing docs pages. Read it before you write one.

It matters more than a usual style guide because the first content pass ships
the **structure only** — every page starts life as a generated stub. There is no
finished page to copy yet, so **this guide plus [`content.manifest.ts`](./content.manifest.ts)
_are_ the exemplar.**

Audience: human writers **and** agents. Every rule below is chosen so a page
works equally well rendered in a browser and pulled out of context as a
machine-readable `llms.mdx`.

---

## How the site is built

-   **Engine:** Fumadocs (Next.js App Router). Pages are MDX with frontmatter under
    `content/docs/`.
-   **Structure is data:** [`content.manifest.ts`](./content.manifest.ts) is the
    source of truth for the information architecture — every page (path, title,
    description, kind) and every sidebar group. The skeleton generator reads it to
    emit folders, each `meta.json`, and a stub `.mdx` per page.
    **A page that isn't in the manifest doesn't exist; a manifest entry with no
    file is a bug.** Don't reorganize the tree by hand — change the manifest.
-   **Machine-readable output is automatic:** Fumadocs emits `llms.txt`,
    `llms-full.txt`, and a per-page `llms.mdx` from your content. You never write
    these — but [rule 5](#authoring-rules) exists because of them.

## Information architecture

Seven top-level groups, ordered for a first read:

**Getting started → Concepts → Guides → Surfaces → For agents → Reference →
Errors & pitfalls.**

Guides are **fine-grained** — one page per feature — grouped into capability
subfolders (`authoring`, `auth`, `resilience`, `data`, `validation`,
`observability`, `state`). Fine-grained is deliberate: one page per feature means
one focused `llms.mdx` per feature, so an agent pulls just the `cookieSession`
page into context, not the whole auth manual.

---

## The four templates

Pick the template by the page's `kind` in the manifest. Copy the skeleton
verbatim, then fill it. Required sections are marked `(required)` — don't drop
them; don't add a fifth top-level section without a reason.

> **Frontmatter:** the current schema (`pageSchema`) allows `title`,
> `description`, and `icon` only. `kind` and `code` live in the manifest, not the
> frontmatter, until we extend the schema in `source.config.ts` (a tracked
> tooling task). Keep frontmatter to `title` + `description`.

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
import { stitch, cookieSession, env } from 'stitchapi';

const me = stitch({
    url: 'https://api.example.com/me',
    auth: cookieSession({
        login: {
            url: 'https://api.example.com/login',
            body: { user: env('USER'), pass: env('PASS') },
        },
        refreshOn: 401,
    }),
});
```

## Options {/* (required) */}

{/* Only the options that matter here, with defaults. Link to Reference for the
exhaustive table — never paste a full type table into a guide (rule 6). */}
`refreshOn` re-runs the login on a status code; `refreshWhen` re-runs it on a
content predicate (for soft 200 walls). See
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

## Authoring rules

1. **Examples are Twoslash, always.** Every code block is type-checked against
   the real `stitchapi` at build time. A snippet that calls a renamed
   option fails the build. See [Code examples](#code-examples--twoslash).
2. **Frontmatter is `title` + `description`, both mandatory.** `description` is a
   real sentence — it's the search result, the `llms.txt` line, and the agent's
   relevance signal. No placeholders, no fragments.
3. **Neutral naming.** No real third-party service names. Use archetypes — "the
   SaaS", "the aggregator" — and the canonical placeholder host
   **`api.example.com`**. (This is a locked project convention, not a docs-only
   rule.)
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

-   Imports must resolve to published entry points (`stitchapi`), not deep
    paths.
-   To intentionally show an error, use Twoslash's `// @errors:` directive — don't
    ship an un-annotated broken snippet.
-   One-time pipeline wiring (the `fumadocs-twoslash` transformer in
    `source.config.ts`) is a tooling task, separate from writing pages.

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
```ts twoslash tab="Config object" tabGroup="definition-style"
import { stitch } from 'stitchapi';
import { z } from 'zod';

const getUser = stitch({
    path: 'https://api.example.com/users/{id}',
    output: z.object({ id: z.number(), name: z.string() }),
});
```

```ts twoslash tab="Fluent builder" tabGroup="definition-style"
import { stitch } from 'stitchapi';
import { z } from 'zod';

const getUser = stitch
    .get('https://api.example.com/users/{id}')
    .returns(z.object({ id: z.number(), name: z.string() }));
```
````

`tabGroup` is the **persistence key**: the same id on every page means a reader
who picks "Fluent builder" once sees it everywhere. Drop `tabGroup` and the tabs
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
| `definition-style` | a stitch is declared ≥2 equivalent ways | `Config object` · `Fluent builder` · `defineStitch`     |
| `module`           | imports differ by module system         | `ESM` · `CommonJS`                                      |
| `consumption`      | how a stitch's result is consumed       | `await` · `Stream` · `.then()`                          |
| `runtime`          | the same operation in code vs the shell | `Programmatic` · `CLI`                                  |

Four rules keep it coherent:

-   **Always set `tabGroup`.** It's the persistence key, not decoration.
-   **Lead with the recommended form.** The first tab is where the reader lands.
-   **Show 2–4 relevant variants, not all of them.** The `defineStitch` page
    leads with the `defineStitch` tab; it doesn't parade all twelve call styles.
-   **A new axis is a new row here first.** Don't coin ad-hoc `tabGroup` values
    inline — add the row above, then use it, so persistence stays consistent.

## Type tables — AutoTypeTable

Reference pages render option shapes from the **actual** TypeScript with
`fumadocs-typescript`:

<!-- prettier-ignore -->
```mdx
<AutoTypeTable path="../../packages/core/src/types.ts" name="StitchConfig" />
```

-   `path` is relative to the MDX file; `name` is the exported type.
-   Never hand-write a prop table — it will drift. If a field needs explanation,
    add TSDoc to the type (rule 8) and the table picks it up.
-   Type tables belong in Reference only; guides link to them (rule 6).

## The error code registry

Errors & pitfalls is keyed to a registry of stable codes (`STITCH_VALIDATION`,
`STITCH_DRIFT`, `STITCH_AUTH_WALL`, `STITCH_TIMEOUT`, `STITCH_CIRCUIT_OPEN`,
`STITCH_GRAPHQL` — provisional until the runtime taxonomy refactor lands).

-   One catalog page per code. The page **slug is the URL** the runtime will point
    to in a thrown error (`/errors/<slug>`).
-   **Slugs are an API.** Once a page is published, never rename its slug — add a
    new page and redirect the old one.
-   The registry of codes will live in `packages/core` and be the shared source of
    truth for both the runtime (which throws the code + url) and these pages.

---

## Definition of done (per page)

-   [ ] Listed in `content.manifest.ts`; file path matches.
-   [ ] `title` + `description` frontmatter; `description` is a real sentence.
-   [ ] Uses the correct template for its `kind`; all `(required)` sections present.
-   [ ] Every TypeScript code block is `ts twoslash` and builds clean (install,
        CLI, and CommonJS blocks are the exception — they aren't TypeScript).
-   [ ] Equivalent forms (install, import, definition, consumption) are tabs with a
        canonical `tabGroup`, not prose alternatives.
-   [ ] No hand-written type tables; shapes come from `AutoTypeTable`.
-   [ ] Neutral names only; `api.example.com` for hosts.
-   [ ] Reads correctly in isolation (imagine it as a lone `llms.mdx`).
-   [ ] `See also` links neighbors, the Reference entry, and any catalog pages.
-   [ ] Any tempting-but-wrong use is flagged with an inline **Anti-pattern**
        `<Callout type="warn">` at the point of temptation, not a separate
        section (rule 10) — omit only when the page has no such pitfall.
