# ADR 0021 — Auth strategies move to `stitchapi/auth`; descriptors are withdrawn

- **Status:** Accepted and implemented (2026-07-31) across [#485](https://github.com/rejifald/StitchAPI/pull/485), [#544](https://github.com/rejifald/StitchAPI/pull/544) and this PR — see _Rollout_. **Supersedes [ADR 0020](./0020-declarative-auth-descriptors.md)** — the declarative `AuthDescriptor` intake is withdrawn before implementation. Salvages 0020's Q7 (`auth` as an atomic `extends` slot) as an independent bug fix, and keeps [#485](https://github.com/rejifald/StitchAPI/pull/485)'s symmetric `apiKey({ in, name, value })` unchanged.
- **Date:** 2026-07-31
- **Tags:** auth, subpath, bundle-frugal, api-surface, breaking, P16-parity, P19-pre-GA

> [!NOTE]
>
> This **removes** the auth surface from the `stitchapi` root entry and gives it
> its own subpath. `auth` goes back to accepting exactly one thing — an
> `AuthStrategy` built by a factory — and you import that factory from
> `stitchapi/auth`. Pre-GA hard break (rc channel, CONTRACT D5/P19); the
> migration is mechanical and one line per call site.

## Context

ADR 0020 proposed a second intake for `auth`: a declarative `AuthDescriptor`
(`auth: { strategy: 'apiKey', in: 'cookie', name: 'sid', value: env('KEY') }`)
resolved internally to the matching factory. [#487](https://github.com/rejifald/StitchAPI/pull/487)
implemented it across core, docs and `from-curl`.

**A descriptor is inert data, so something has to map `strategy: 'oauth2'` to the
`oauth2()` factory.** Whatever holds that map references all five factories, and
it has to be reachable from `stitch()` — which is the lean path every consumer
pays for. Measured against `lib/` built at `main` (`d0f8f12`), that is the whole
auth surface landing on `import { stitch }`:

| scenario                                                       | min          | gzip         |
| -------------------------------------------------------------- | ------------ | ------------ |
| `import { stitch }` today                                      | 55.86 KB     | **20.14 KB** |
| `import { stitch }` + everything a descriptor resolver reaches | 62.24 KB     | **22.46 KB** |
| **descriptor tax**                                             | **+6.38 KB** | **+2.33 KB** |

Paid by every consumer, including the ones with no `auth` at all. That is 2.33 KB
over a 20.25 KB budget the gate holds to ~0.2 KB of headroom — not a budget bump,
a different bundle.

#487 did find an escape: a **resolver seam** (`src/auth-registry.ts`) holding
detection plus an empty slot, armed by `auth.ts` as a side effect of the secret
resolvers (`env`/`secretsFile`/`secretFrom`) running — deliberately not at module
load, because esbuild would keep that and re-bloat the path. It works, and it buys
the bytes back. It also means a descriptor with a **literal** secret and no auth
import throws at construction (pinned by that PR's own
`auth-descriptor-unarmed.spec.ts`): whether a config is valid depends on which
unrelated module happened to execute first. A config-shaped API cannot have that
cliff. The mechanism is the tell — the feature does not fit the bundle model, and
the workaround is load-bearing enough to need its own test.

So descriptors are withdrawn. The remaining question is the one 0020 opened and
answered badly: **auth is the only config slot that costs bytes to _reach_, and
the root entry makes everyone reach it.**

## Decision

### 1. `auth` accepts an `AuthStrategy`. Only.

`StitchConfig.auth: AuthStrategy` — reverted to today's shape. No `AuthDescriptor`,
no `AuthConfig` union, no `auth-registry.ts`, no detection branch. 0020's Q3 already
conceded the load-bearing point: the factory form is required regardless, because a
closed descriptor union cannot express a custom `apply`. One intake, not two.

### 2. The auth surface moves to `stitchapi/auth`

```ts
import { stitch } from 'stitchapi';
import { bearer, env } from 'stitchapi/auth';

export const me = stitch({
    url: 'https://api.github.com/user',
    auth: bearer(env('GITHUB_TOKEN')),
});
```

`src/auth.ts` becomes its own tsup entry and its own export condition, exactly like
`cache` (ADR 0003 §11), the non-`http` surfaces (ADR 0005 Decision 10), `testing`,
`fingerprint`, `postmessage`, `llm`, `pipe` and `xhr`. It is the ninth application
of a rule the package already lives by: **a capability the core path does not need
is reached through its own import.** `auth.ts` is imported by nothing in `src/`
except `index.ts`, so the split is a clean cut, not a refactor.

| symbol                                                            | today       | after            |
| ----------------------------------------------------------------- | ----------- | ---------------- |
| `bearer` `apiKey` `basic` `oauth2` `cookieSession`                | `stitchapi` | `stitchapi/auth` |
| `env` `optionalEnv` `secretsFile` `secretFrom`                    | `stitchapi` | `stitchapi/auth` |
| `BasicOptions` `SecretSource` `AuthFailureResult` `RefreshResult` | `stitchapi` | `stitchapi/auth` |
| `Secret` `OptionalSecret`                                         | — (private) | `stitchapi/auth` |
| `AuthStrategy` `AuthContext` `SecurityScheme`                     | `stitchapi` | **both**         |
| `registerSecretKey` `isSecretKey` `redactSecretsDeep`             | `stitchapi` | `stitchapi`      |

> [!NOTE]
>
> **Spelling amendment (post-decision).** The last row's three functions are now
> exported from the root as the single `secrets` namespace — `secrets.register` /
> `secrets.has` / `secrets.redact`. The **placement** decision this ADR records is
> unchanged: they stay on `stitchapi`, not `stitchapi/auth`, for the reason given
> below. Only the spelling moved.

Three notes on that table:

- **`AuthStrategy`/`AuthContext`/`SecurityScheme` stay declared on the root** —
  they are part of the `StitchConfig` contract, and a BYO strategy is a value you
  hand to `stitch()`. `stitchapi/auth` **re-exports them as types** so a custom-
  strategy author writes one import, not two. Type re-exports cost zero bytes;
  splitting the type from the values would reintroduce exactly the two-import
  annoyance this ADR removes.
- **The secret resolvers move with the factories.** Every use of `env()` in the
  repo, the docs and the peer packages is a credential — including
  `@stitchapi/aws-sigv4`'s `accessKeyId: env('AWS_ACCESS_KEY_ID')`. Leaving them
  on the root would put two imports on every auth example for no conceptual gain,
  and costs 0.27 KB gzip on the root entry (22.93 vs 22.66 as simulated).
- **`Secret`/`OptionalSecret` become public.** They are already exported from
  `auth.ts` but unreachable. `@stitchapi/aws-sigv4` currently **hand-mirrors**
  `Secret` (`export type Secret = string | (() => string)` with a comment saying
  it is structurally identical to core's) — the drift class the house rule about
  peer packages reusing core's types exists to prevent. Publishing it lets that
  mirror be deleted (follow-up, not a gate).

### 3. Hard break — no root re-export

`stitchapi` is at `1.0.0-rc.6`. CONTRACT D5/P19 scopes the alias obligation to the
GA channel, and #485 already takes a hard break on `apiKey({ header })` on the same
grounds. A compatibility re-export from the root would forfeit **the entire measured
win** — the whole entry stays at 25.10 KB either way, because the root barrel would
still reference the factories.

The break is loud and mechanical: `Module '"stitchapi"' has no exported member
'bearer'` at the import line, fixed by moving the name to a second import. Covered
by an entry in `getting-started/migration-notes.mdx`.

### 4. `auth` becomes an atomic `extends` slot

Salvaged verbatim from 0020's Q7, and independent of everything above — this was a **live
bug on `main`**, fixed in [#544](https://github.com/rejifald/StitchAPI/pull/544) ahead of the
move. `auth` flowed through `deepMerge`, which blends two strategies field-by-field.
Verified against the built `lib/` before the fix:

```ts
const base = stitch({ url: '…', auth: oauth2({ tokenUrl: 'https://auth.example.com/token', … }) });
const child = stitch({ extends: base, url: '…', auth: bearer(env('TOK')) });
```

`child`'s resolved strategy is a chimera:

```
name          : 'bearer'
apply         : bearer's        ← attaches the plain env token
shouldRefresh : oauth2's        ← bearer has none
refresh       : oauth2's        ← bearer has none
scheme        : { type: 'http', flows: { clientCredentials: {…} }, scheme: 'bearer' }
```

Two real failures, not one. A 401 fires **oauth2's** `refresh` — a live
`client_credentials` POST to a token endpoint the child never declared, with the
inherited client secret — and then retries with the bearer header anyway. And the
blended `scheme` is not a valid OpenAPI security scheme (an `http` scheme has no
`flows`), so it poisons `__config.authScheme` and `stitch export --openapi`.

Fix: `auth` joins `hooks`/`store`/`kind` as an atomic **last-writer-wins** slot,
lifted out before `deepMerge` — the treatment ADR 0005 Decision 2 gives a Surface,
for the same reason (merging two live objects corrupts their identity).

### 5. Generated code emits two imports

`from-curl` and `@stitchapi/openapi`'s `deriveAuth` split their import list by
module: `stitchapi` for `stitch`/`graphql`, `stitchapi/auth` for the strategy and
its resolver. 0020's Q8 wanted descriptors here to spare the ejected client an
import; the client already imports `stitch`, so the saving was one line.

## Why — the measurement

`scripts/bundle-size.mjs` at this branch's merge base (`0728cd5`) and at the implemented
split. The subpath rows use the same harness (esbuild + gzip -9) against the real
`lib/auth.mjs`:

| scenario                            | min      | gzip         | note                        |
| ----------------------------------- | -------- | ------------ | --------------------------- |
| `stitchapi` whole entry — before    | 70.17 KB | **25.10 KB** | budget 25.15, headroom 0.05 |
| `stitchapi` whole entry — after     | 63.46 KB | **22.69 KB** | **−2.41 KB**, budget 22.90  |
| `import { stitch }` — before        | 55.90 KB | **20.15 KB** |                             |
| `import { stitch }` — after         | 55.91 KB | **20.17 KB** | +0.02, chunk-boundary noise |
| `stitchapi/auth` — whole surface    | 13.35 KB | 5.14 KB      | new scenario, budget 5.35   |
| `stitchapi/auth` — `bearer` + `env` | 0.67 KB  | 0.39 KB      |                             |
| `stitchapi/auth` — `apiKey` + `env` | 1.80 KB  | 0.90 KB      |                             |
| `stitchapi/auth` — `oauth2` + `env` | 7.69 KB  | 3.22 KB      |                             |

The auth surface weighs ~2.4 KB gzip. Descriptors force it onto everyone's lean path
(+2.33 KB measured at `d0f8f12` — a slightly different figure because from that direction
the code lands in different chunks); the subpath takes it off everyone's whole entry. Same
bytes, opposite sign.

`import { stitch }` does not move because the root barrel is already tree-shaken —
which is the point worth being precise about. **The subpath does not make auth
cheaper to use; it makes it structurally impossible to pay for by accident.** Today
the property "you only pay for the strategy you import" is a tree-shaking outcome,
contingent on `sideEffects: false`, ESM, and a bundler that does its job. After the
move it is a module-graph fact that holds for CJS, for a naive bundler, and for
anyone reading the import list. The whole-entry figure — the one the READMEs
advertise — is what that difference is worth, and it is 2.41 KB.

Headroom also stops being a problem. The gate holds ~0.2 KB; #524 squeezed it to 0.11,
#485 to 0.02, and #544 could only clear a **one-byte** overflow with a 0.05 KB step. Both
new ceilings land at 0.21 KB — the gate's normal step, restored rather than borrowed.

## Consequences

**Advertised size drops `~25 kB` → `~23 kB`** (`Math.round(22.69)`); `import { stitch }`
stays `~20 kB`. That is 7 tethered sites (`README.md`, `packages/core/README.md`,
`installation.mdx`, `principles.mdx`, `metrics.tsx`, `lib/source.ts`, and the
`bundle-size.mjs --json` command site) under the yakir `bundle-advertised-size`
tether, plus the badge in `README.md`.

> [!NOTE]
>
> That tether was drifted on `main` — baseline `19, 24` against a live `20, 25`.
> **#485 fixed it** (that was the surviving half of its second commit), so it now
> sits at `20, 25`. Step 3 re-baselines it once more to `20, 23`. Re-baseline
> deliberately from a fresh `bundle-size.mjs --json`, never by hand.

**Budgets move down**, and a third scenario appears:

| scenario            | budget now | budget after                 |
| ------------------- | ---------- | ---------------------------- |
| whole entry         | 25.15 KB   | **22.90 KB** (0.21 headroom) |
| `import { stitch }` | 20.25 KB   | 20.25 KB (unchanged)         |
| `stitchapi/auth`    | —          | **5.35 KB** (0.21 headroom)  |

**Call-site churn: ~100 files** — 47 in `apps/docs`, 37 in `packages/core` (mostly
tests), plus `packages/nest` (`bridges.ts` imports `secretFrom`), `packages/openapi`,
`packages/eval-harness`, the ADRs and the top-level design docs. Mechanical, and a
codemod-shaped edit: split one import line in two.

**`@stitchapi/nest`, `@stitchapi/openapi` and `@stitchapi/aws-sigv4`** are the peer
packages that touch the auth surface. All three are ours; `build:typed-deps` gates
the monorepo.

**What does not change:** wire behaviour, the vault, tenancy, redaction,
`__config.authScheme`, `stitch export --openapi`, or any strategy's options. This
ADR moves where a factory is imported from and fixes how two of them merge. It does
not touch what they do.

## Gates

- `check:size` — all three scenarios inside the new budgets, measured after the real
  tsup split (chunking may shift a few bytes from the simulation above; re-measure,
  do not copy these numbers into the script as fact).
- `check:exports` (`attw --pack .`) — the new `./auth` condition resolves in ESM,
  CJS and `browser`. `secretsFile` reaches `node:fs` through `nodeFs()`, which
  guards on `globalThis.process`, so `/auth` keeps the root's `browser` condition
  and the browser-bundle gate still passes.
- `check:contract` — baseline 0.
- `pnpm -r check:types` (incl. docs twoslash), `check:types-d`, core `test`,
  `build:typed-deps`.
- The `extends` fix ships with a regression test pinning that a child `auth` clears
  the parent's `shouldRefresh`/`refresh`/`scheme` — the chimera above, asserted.

## Rollout — one PR per step, stop between

1. ~~**Land #485** (rebase).~~ **Done** — merged 2026-07-31 as
   [`d19abf7`](https://github.com/rejifald/StitchAPI/commit/d19abf7). Symmetric
   `apiKey({ in, name, value })` + the cookie arm, the openapi cookie mapping, and the
   `only`/`tags` P7 widening. (The `scope`→`pool` emitted comment and the `~24`→`~25 kB`
   copy had landed on `main` independently and dropped out of the rebase; what survived
   of that slice is the yakir re-baseline noted under _Consequences_ — so that tether is
   **no longer drifted**, and step 3 re-baselines it once more for `~23`.)

    It lands with the entry at **25.08 KB** gzip against a 25.10 KB budget — **0.02 KB of
    headroom**, deliberately not bought with a budget bump, because step 3 is what pays it
    back. The next PR to touch the root entry breaks `check:size` until then.

2. ~~**`auth` as an atomic `extends` slot** + regression test.~~ **Done** — merged as
   [`0728cd5`](https://github.com/rejifald/StitchAPI/commit/0728cd5) (#544), ahead of the move
   because it is a security fix and should not wait behind a 100-file refactor. It cleared a
   one-byte budget overflow with a 0.05 KB step, which this PR gives back many times over.
3. **The subpath move — this PR.** tsup entry, exports map, `index.ts` removal, the
   repo-wide import rewrite, budgets down (25.15 → 22.90, plus a 5.35 KB ceiling on the new
   subpath), advertised sizes `~25` → `~23 kB`, the yakir re-baseline, and the
   migration-notes entry. Steps 4 and 5 folded in rather than trailing as their own PRs:
   splitting them would have left `main` briefly emitting scaffolds that do not compile.
4. ~~**Codegen + docs.**~~ **Folded into step 3** — `from-curl` and `deriveAuth` emit the
   two-import form (an unauthenticated client emits no `stitchapi/auth` import at all), and
   the auth guides, reference and blog fences moved with them.
5. ~~**Close out.**~~ **Folded into step 3** for the ADR 0020 supersede banner. Still open:
   close [#487](https://github.com/rejifald/StitchAPI/pull/487) with a pointer here, and the
   `@stitchapi/aws-sigv4` `Secret` de-mirror below.

Follow-up, not a gate: delete `@stitchapi/aws-sigv4`'s hand-mirrored `Secret` in
favour of the now-public one.

## Alternatives considered

- **Keep descriptors behind the #487 resolver seam.** Rejected — the arming
  mechanism makes validity depend on module execution order, and a literal-secret
  descriptor with no auth import throws at construction. A declarative config form
  whose validity is not decidable from the config is worse than no declarative form.
- **Descriptors for `apiKey` only** (the one strategy whose options are pure data).
  Rejected by 0020's own Q2 on P16 parity, and it does not shrink the resolver
  problem enough to matter — one factory reachable from the core path is still a
  factory reachable from the core path.
- **Move only the five factories; keep `env`/`secretsFile`/`secretFrom` on the root.**
  Costs 0.27 KB gzip (22.93 vs 22.66, simulated) and puts two imports from two modules on every
  auth example. The resolvers are credential-only in every use in the tree.
- **Root re-exports, deprecated for one rc cycle.** Zero size win (the barrel still
  references the factories), so it would be pure deprecation ceremony on a
  pre-GA channel where P19 does not ask for it.
- **Status quo — auth stays on the root, no descriptors.** The honest fallback: it
  costs nothing and breaks nothing. It also leaves the advertised entry 2.33 KB
  heavier than it needs to be, and leaves "you only pay for what you import" as a
  tree-shaking promise rather than a structural one — for the one surface where the
  thing you are not paying for is an OAuth2 client and a cookie-session state
  machine.

## Revisit if

- A strategy needs to be reachable from the core path (nothing does today — `auth.ts`
  has exactly one importer in `src/`).
- The `~23 kB` entry grows back past `~25 kB` from elsewhere, making the win moot.
- A real, repeated demand for JSON-authored auth appears from the agent/registry
  surfaces — in which case the answer is a **loader** that reads JSON and calls the
  factories, living on `stitchapi/auth` or `stitchapi/registry` where the factories
  already are, never a resolver on the core path.
