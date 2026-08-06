#!/usr/bin/env node
// API meta-contract gate — see docs/CONTRACT.md.
//
// A RATCHET, not a hard gate. The pre-contract backlog (docs/CONTRACT.md §6) was worked
// down to ZERO by the GA hard-break sweep; the same-day P24 addition (§6/§7) then found
// one pre-existing real match (R8, @stitchapi/nest's seamConfig/seamToken) it did not fix
// and briefly baselined it. That match has since been converted — folded into
// `StitchFeatureOptions.seam: AtLeastOne<NestFeatureSeamOptions>` — so
// scripts/contract-violations.baseline.json is empty again and the gate fails on the
// FIRST new violation — exactly like the repo's ESLint-suppression ratchet at zero. The
// mechanism is kept (rather than hard-failing inline) so a deliberate, contract-aligned
// exception can still be baselined with a committed diff for review.
//
//   pnpm check:contract            # check working tree against the baseline (CI/hook mode)
//   node scripts/check-contract.mjs --list     # print every current violation, grouped
//   node scripts/check-contract.mjs --update    # rewrite the baseline to the current set
//
// Rules are intentionally HIGH-PRECISION source-text checks (no TS type info), so a flagged
// line is a real violation, not a guess.
//
// R6 now resolves an envelope across FILES (per package, plus core, since a peer's config
// types come from core) and through `extends` — including a NON-exported base, whose
// members are just as writable by a consumer as declared ones. It also tests EVERY arm of
// a member's union rather than a leading `boolean | X`: one assignable arm is what makes
// `{}` legal, wherever it sits. A 2026-07-31 audit found four real P20 slots that the
// narrower rule could not see — `Fn | Options` (sse-emit's `delta`/`error`),
// `Options | false` (elysia/fastify `errorHandler`) and an inherited member.
//
// R9 covers the AUTHORED half of duration/size conformance (P17/P25) without type info, by
// pairing a closed member vocabulary with P3's `*Options` = consumer-input signal. What it
// cannot see is the other half of that rule — whether the widened value actually reaches
// `parseDuration`/`parseBytes` before a sleep or comparison. A type that says `number | string`
// over an unparsed read site is the silent-collapse bug (#609), and catching it needs dataflow,
// not source text. The parse is pinned behaviourally instead, by tests that assert an elapsed
// floor and fail in milliseconds without it (`sse-reconnect.spec.ts`, `interpret-in-loop.spec.ts`).
//
// R6 also resolves ONE level of `type` ALIAS (#564 item 1): `type X = A | B` marks `X` as
// admitting `{}` when a bare-identifier arm is a known all-optional INTERFACE. One level only,
// and against interfaces only — an arm naming another alias does not resolve, so the pass is
// bounded and cannot chain. Arms are filtered by the same `unionArms()` the member check uses,
// so `AtLeastOne<Bag>` and `Bag[]` are not arms and the prescribed fix clears the finding by
// construction. Generic aliases (`type X<T> = …`) are skipped: whether they admit `{}` depends
// on the argument, which is the type-aware phase's problem.
//
// R10 covers the cap vocabulary (P4/D2). A count cap is a bare plural noun, so a `max` cap —
// bare or prefixed, since the P4 sweep record fixed both — on a consumer-input envelope is a
// violation unless it is a verified continuous MAGNITUDE ceiling on MAX_CAP_ALLOW; `*Threshold`
// gets no carve-out at all. It shares R6's container filter (now `isConsumerEnvelope()`,
// extracted so the two cannot drift), which is also the precision guarantee: P4 blesses `max*`
// on RESOLVED INTERNALS, and those live outside `*Options` by construction rather than on a
// skip list. Replayed over history it reproduces the 2026-07 sweep's own P4 list —
// CacheOptions.maxEntries, ReconnectOptions.maxAttempts, CircuitOptions.failureThreshold,
// DenoKvStoreOptions.maxIncrRetries, RetryOptions.maxMs/maxDelay.
//
// What it does NOT catch, stated here because it is the case that motivated the rule: the
// 2026-07-31 sweep's `LlmOptions.maxTokens` / `LlmRequest.maxTokens`. `LlmOptions` was a
// `type X = … & { … }` LITERAL, which no member rule scans (the same limit R8/R9 carry), and
// `LlmRequest` is an exported interface that is not `*Options`, so the container filter rejects
// it — the `MockRoute` blind spot of #564 item 2. R10 guards the interface-shaped `*Options`
// surface, where P4's whole resolved list lived; it is not a claim that class is now covered.
//
// Still deferred to a type-aware phase (needs the TS checker): shape-diffing (full P9 —
// R5's watch list is the by-name proxy), default-value inversion (P8), cross-PACKAGE parity
// of the same capability (P16), and the CONTAINER half of the alias gap — R6 scans only the
// `*Options` + blessed `*Config` family, so `MockRoute.respond: MockResponder` stays
// under-flagged even now that the alias resolves, because `MockRoute` is not an `*Options`
// (#564 item 2: widen the filter and take the noise, or rename the type). The same blind spot
// puts `SurfaceOutcome.after`, a union member, out of R9's reach.
// Under-flagging is deliberate: a ratchet that guesses is a ratchet nobody trusts.
import {
    existsSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = join(ROOT, 'packages');
const BASELINE = join(ROOT, 'scripts', 'contract-violations.baseline.json');

// ---- the published surface ------------------------------------------------
// Every packages/* whose manifest is not `private: true`. Those are the consumer-facing
// contracts the meta-contract governs; private tooling (eval-harness, sandbox-sim, …) is out.
function publishedPackages() {
    const out = [];
    for (const dir of readdirSync(PKGS)) {
        const manifest = join(PKGS, dir, 'package.json');
        if (!existsSync(manifest)) continue;
        let pkg;
        try {
            pkg = JSON.parse(readFileSync(manifest, 'utf8'));
        } catch {
            continue;
        }
        if (pkg.private === true) continue;
        if (!existsSync(join(PKGS, dir, 'src'))) continue;
        out.push({ dir, name: pkg.name });
    }
    return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

function tsFiles(root) {
    const out = [];
    const walk = (d) => {
        for (const e of readdirSync(d)) {
            const p = join(d, e);
            const s = statSync(p);
            if (s.isDirectory()) walk(p);
            else if (
                /\.tsx?$/.test(e) &&
                !/\.d\.ts$/.test(e) &&
                !/\.(spec|test)\.tsx?$/.test(e) &&
                !/\.generated\./.test(e)
            )
                out.push(p);
        }
    };
    walk(root);
    return out;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const rel = (p) => relative(ROOT, p);

// Brace-match an exported `interface Name { … }`; returns { name, body, index }.
function interfaceBlocks(src, { includeLocal = false } = {}) {
    const blocks = [];
    const re = includeLocal
        ? /\b(?:export\s+)?interface\s+([A-Za-z_]\w*)([^{]*)\{/g
        : /\bexport\s+interface\s+([A-Za-z_]\w*)([^{]*)\{/g;
    let m;
    while ((m = re.exec(src))) {
        let depth = 0;
        let j = m.index + m[0].length - 1; // sit on the opening brace
        const open = j;
        for (; j < src.length; j++) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}' && --depth === 0) {
                j++;
                break;
            }
        }
        blocks.push({
            name: m[1],
            body: src.slice(open + 1, j - 1),
            index: m.index,
            bodyStart: open + 1,
            // Bases named in `extends A, B` — a member inherited from one of them is just as
            // reachable to a consumer as a declared one, and the base is often NOT exported
            // (fastify's `FastifyStitchPluginCommon`), so it must be resolvable by name.
            bases: [...(m[2] ?? '').matchAll(/([A-Z]\w*)/g)]
                .map((b) => b[1])
                .filter((b) => b !== 'extends'),
        });
    }
    return blocks;
}

// The arms of a union type that are BARE type identifiers — `A | B[] | ((c) => D)` yields
// `[A]`. Shared by R6's member check and the alias pre-pass so the two can never drift.
//
// Bare-only is the precision guarantee, not a shortcut. `AtLeastOne<Bag>` is not an arm, so
// the fix R6 prescribes clears its own finding; `Bag[]` is not an arm, because an array does
// not accept `{}`. It also makes the naive `split('|')` safe: any nesting (`(A | Bag)`,
// `{ a?: A | Bag }`, `Map<K, A | Bag>`) leaves a bracket or paren welded to the token, so a
// `|` that was never a top-level separator cannot yield a bare identifier.
const unionArms = (type) =>
    type
        .split('|')
        .map((a) => a.trim())
        .filter((a) => /^[A-Z]\w*$/.test(a));

// Top-level `type X = …;` aliases in a file, with their right-hand side. NON-generic only:
// the `=` must follow the name directly, so `type X<T> = …` is skipped (see the header).
//
// The RHS runs to the first `;` at depth 0, counting only braces/parens/brackets — NOT angle
// brackets, whose `>` also closes an arrow (`=> string`) and would end the type early, the
// same convention depthAt() uses. A missing semicolon (ASI) would otherwise run to EOF and
// swallow the next declaration's body, where a stray `| Bag` would read as an arm of THIS
// alias — so the scan also stops at the next top-level declaration.
function typeAliases(src) {
    const out = [];
    const re = /(?:^|\n)\s*(?:export\s+)?type\s+([A-Za-z_]\w*)\s*=\s*/g;
    // \b matters: without it the `type` alternative also matches the `type` in a `typeof Foo`
    // arm sitting at the start of a continuation line, ending the RHS one line early.
    const NEXT_DECL =
        /^\n[ \t]*(?:(?:export|interface|type|class|const|let|function|declare|abstract|enum)\b|\/\*)/;
    let m;
    while ((m = re.exec(src))) {
        let depth = 0;
        let j = re.lastIndex;
        for (; j < src.length; j++) {
            const ch = src[j];
            if (ch === '{' || ch === '(' || ch === '[') depth++;
            else if (ch === '}' || ch === ')' || ch === ']') depth--;
            else if (depth === 0) {
                if (ch === ';') break;
                if (ch === '\n' && NEXT_DECL.test(src.slice(j, j + 24))) break;
            }
        }
        out.push({ name: m[1], rhs: src.slice(re.lastIndex, j).trim() });
    }
    return out;
}

// True when the declaration at `idx` is immediately preceded by a JSDoc block carrying
// `@deprecated`. Post-GA, a @deprecated marker is itself a violation (R7, amended P19) —
// R1–R4/R6 still skip deprecated declarations only so a hypothetical alias is reported
// ONCE (as R7's shim finding), not double-counted under the naming rules too.
function deprecatedBefore(src, idx) {
    let j = idx;
    while (j > 0 && /[\s{;,(]/.test(src[j - 1])) j--; // skip whitespace + the field anchor
    if (src.slice(j - 2, j) !== '*/') return false; // must sit right after a comment
    const open = src.lastIndexOf('/*', j - 2);
    return open !== -1 && /@deprecated/.test(src.slice(open, j));
}

// Index of the first `@deprecated` JSDoc TAG, or -1. A tag is the word at TAG POSITION — line
// start, after the block comment's optional leading `*` — inside a `/* … */` block. Prose that
// merely NAMES the marker is not one: a `//` line comment explaining that a deprecated alias
// exists (core's `stripFns` note on `key`/`keyOf`), or a mid-sentence mention inside a JSDoc,
// is documentation about the surface, not a shim on it. A raw `indexOf('@deprecated')` cannot
// tell those apart and flagged the explanatory comment as a violation.
function deprecatedTagIndex(src) {
    let open = src.indexOf('/*');
    while (open !== -1) {
        const close = src.indexOf('*/', open + 2);
        if (close === -1) return -1; // unterminated block: nothing further is a comment
        const m = /^[ \t]*\*?[ \t]*@deprecated\b/m.exec(
            src.slice(open + 2, close),
        );
        if (m) return open + 2 + m.index;
        open = src.indexOf('/*', close + 2);
    }
    return -1;
}

// True when every TOP-LEVEL member of an interface body is optional (`?`) — so the bag is
// `{}`-constructible and would accept the opaque empty object at a config slot (P20). Tracks
// brace/paren depth so a nested object-literal field type doesn't read as a required member.
function isAllOptional(body) {
    let depth = 0;
    for (const line of body.split('\n')) {
        if (depth === 0) {
            const m = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*(\??)\s*[:(]/.exec(
                line,
            );
            if (m && m[2] !== '?') return false; // a required member at depth 0
        }
        for (const ch of line) {
            if (ch === '{' || ch === '(') depth++;
            else if (ch === '}' || ch === ')') depth--;
        }
    }
    return true;
}

// Names declared-and-exported in a file (declaration sites; not re-export resolution).
function exportedDeclNames(src) {
    const names = [];
    const re =
        /\bexport\s+(?:abstract\s+)?(interface|type|class|function|const)\s+([A-Za-z_]\w*)/g;
    let m;
    while ((m = re.exec(src)))
        names.push({ kind: m[1], name: m[2], index: m.index });
    return names;
}

// Identifiers a package's index.ts puts on its PUBLIC surface (direct decls + `export {…}`
// blocks, taking the post-`as` alias). `export * from` is not expanded — a known gap noted
// in CONTRACT.md §7; the watch-list (R5) is curated so this gap doesn't hide a real clash.
function indexExports(indexPath) {
    if (!existsSync(indexPath)) return new Set();
    const src = readFileSync(indexPath, 'utf8');
    const names = new Set(exportedDeclNames(src).map((d) => d.name));
    const block = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;
    let m;
    while ((m = block.exec(src))) {
        for (let part of m[1].split(',')) {
            part = part.trim().replace(/^type\s+/, '');
            if (!part) continue;
            const as = part.split(/\s+as\s+/);
            const id = (as[1] ?? as[0]).trim();
            if (/^[A-Za-z_]\w*$/.test(id)) names.add(id);
        }
    }
    return names;
}

// ---- rules ----------------------------------------------------------------
// P3 — banned type-name suffix. Consumer-input side: *Opts/*Info/*Params/*Config (the
// envelope suffix is *Options). Produced-shape side: *Return/*State (the result suffix
// is *Result — this is what would have caught `UseStitchReturn`; *Response/*Info are
// also banned by P3 but *Response is left to the type-aware phase — too many legitimate
// mirrors of the platform `Response` family for a source-text check). Carve-outs: the
// well-known StitchConfig authoring family, and any *Like* duck-type (P18: an adapter
// mirror keeps its upstream spelling). Verified before adding Return/State: no exported
// declaration in packages/*/src carries either suffix post-sweep (the only `AppState` is
// a react-native ambient .d.ts mirror, which tsFiles() already excludes).
const BANNED_SUFFIX = /(Opts|Info|Params|Config|Return|State)$/;
const SUFFIX_CARVEOUT = new Set([
    'StitchConfig',
    'ResolvedStitchConfig',
    'RedactedStitchConfig',
    'SeamConfig',
    'OpenApiInfo', // mirrors the OpenAPI spec's InfoObject (P18: keep the upstream spelling)
]);
const isLike = (n) => /Like/.test(n);

// The CONSUMER-INPUT envelope family — P3's own line between what a caller AUTHORS and what the
// engine hands back: `*Options`, plus the blessed `*Config` authoring types, minus any `*Like`
// foreign duck-type (P18). Shared by R6 and R10 so the two can never drift, the same reason
// `unionArms()` was extracted. Scanning every exported interface instead floods both rules with
// resolved views (`ResolvedNormalizations`), spec mirrors (`OpenApiDocument`, JSON Schema's
// `SchemaNode`) and duck-types (`PinoLoggerLike`) — none of which a consumer ever writes.
const isConsumerEnvelope = (name) =>
    (/Options$/.test(name) || SUFFIX_CARVEOUT.has(name)) && !isLike(name);

// P9/P16 — identifiers that MUST be unique-by-shape across packages (a curated watch list;
// full shape-diff is the deferred type-aware phase). Flagged when ≥2 packages export one.
const UNIQUE_WATCH = new Set([
    'StitchStore',
    // Declared (not re-exported) by BOTH react and vue from their sole public entry, with
    // mutually unassignable shapes: react's `extends StitchQueryResult<T>` carries raw
    // values, vue's wraps every state field in `ComputedRef<…>`. That is the exact case
    // `SolidStitchStore`/`SvelteStitchStore` were framework-qualified to fix (ADR 0012
    // rule 6), so the divergent side qualifies too → `VueUseStitchResult`.
    'UseStitchResult',
    'StitchError',
    // De-listed names (post-sweep surface — each verified against the real ≥2-package
    // export map, one line of rationale each):
    //  - StitchLike + QueryOutput + QueryInput: blessed two-tier duck-types (P9) —
    //    query-core's RICH canonical (awaitable + streamable), re-exported by the
    //    TanStack-family bindings, plus a deliberate MINIMAL await-only redeclaration in
    //    the stream-less adapters (swr/rtk-query/vercel-ai), which never call `.stream()`.
    //  - StreamableStitchLike: rtk-query's streaming tier of the same blessed family.
    //  - StreamStitchSseOptions + StitchErrorOptions: intentionally IDENTICAL option
    //    envelopes per host adapter (elysia/hono/express/fastify/nest/next) — one
    //    structural contract, same-name-same-shape by design (P9). StreamStitchSseOptions
    //    is identical BY CONSTRUCTION: every host derives it from core's single
    //    `SseEmitOptions` (five `extends`, nest aliases), so the de-listing rests on a
    //    shared declaration rather than on six shapes that happen to agree today.
    //  - StitchEventSource: core-owned; host adapters re-export core's type verbatim.
    //  - StitchQueryOptions / stitchQueryOptions / deriveQueryKey / nameOf / keyInputFor
    //    (and the rest of the query family): query-core-owned canonicals re-exported
    //    verbatim by the framework bindings — one declaration site, many surfaces.
    //  - StitchErrorLike: the hosts' uniform error duck-type (`Error & { status? }`) —
    //    one structural contract across all six adapters (P9).
    // Stale watch entries removed: bare `RequestSeam`, `StitchHost`, and `queryOptions`
    // were deleted from the surface entirely by the hard-break sweep — nothing left to watch.
]);

// P24 — a shared leading-word prefix across ≥2 flat members of one exported interface is an
// envelope candidate. Two carve-outs are STRUCTURAL (excluded before grouping, never guessed at
// per-symbol): `on*`/`is*` handler/guard verbs, and a percentile family (`…P50`/`…P95`/`…P99`, or
// a bare `p50`/`p95`/`p99`). Everything else is checked against a curated allow-list below — each
// entry is a verified non-match (a foreign-SDK/standard mirror, a discriminated-union pair, a
// derived/internal read-view, or a plugin-extension-hook bag), one rationale per entry, exactly
// like the R5 UNIQUE_WATCH de-listed names above.
const CONVENTIONAL_MEMBER = /^(?:on|is)[A-Z]|^[Pp]\d+$/;

// Split on camelCase word boundaries; the group key is the lowercased leading word.
const splitCamel = (name) =>
    name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ');
const leadingWord = (name) => splitCamel(name)[0].toLowerCase();

// Keyed `InterfaceName.prefix` — one entry per verified exemption, never a blanket interface- or
// package-level skip, so a NEW group in an already-allow-listed interface still gets flagged.
const PREFIX_GROUP_ALLOW = new Map([
    // (a) Foreign-SDK/standard mirrors (P18/P22) — the pair IS the mirrored contract's own
    // vocabulary, not house-coined, so there is nothing to fold:
    [
        'OAuth2Options.client',
        'clientId/clientSecret/clientAuth mirror RFC 6749 (P18/P22)',
    ],
    [
        'StitchQueryOptions.query',
        "queryKey/queryFn mirror TanStack's own queryOptions() vocabulary (P3/P18/P22) — this rule's own motivating example is itself exempt",
    ],
    [
        'DocSearchHit.page',
        'pageUrl/pageTitle mirror the persisted Orama index document schema (P18)',
    ],
    ['XhrLike.response', 'responseType/response mirror the XHR API (P18)'],
    [
        'RnStreamingXhr.response',
        'responseType/responseText mirror the XHR API (P18)',
    ],
    [
        'CacheLifecycleApi.cache',
        'cacheDataLoaded/cacheEntryRemoved mirror RTK Query lifecycle names (P18)',
    ],
    // Discriminated-union pairs — mutually exclusive by `X?: never` on the sibling variant, so
    // the two never co-exist and there is no envelope to nest:
    [
        'FastifyStitchPluginSeamOptions.seam',
        'seam/seamConfig are an XOR pair (seamConfig?: never) — the prebuilt-seam variant, not two co-options',
    ],
    [
        'FastifyStitchPluginConfigOptions.seam',
        'seamConfig/seam are the same XOR pair from the build-a-seam variant (seam?: never)',
    ],
    // Off the published surface, or a derived/internal read-view rather than an authored config:
    [
        'ParsedRequest.body',
        'body/bodyType (payload + discriminator tag, carve-out (b)) on the CLI-internal from-curl parser type — off the published surface; the P1 bodyKind→bodyType rename landed 2026-08-01',
    ],
    [
        'FingerprintInput.transform',
        'transform/transformVersion/transformTrust is a derived read-view that FLATTENS the authored cache.fingerprint.transform envelope (version/trust) back alongside the top-level StitchConfig.transform closure for the hash — the envelope P24 asks for is the authored one; re-nesting it here would only re-wrap what the resolver reads flat',
    ],
    [
        'CliIO.write',
        'write/writeErr/writeFile are independent I/O primitives (stdout/stderr/filesystem) on a host-capability interface, not sub-options of one capability',
    ],
    [
        'CliIO.load',
        'load/loadModule are independent verbs (registry loader vs. generic import), not sub-options of one capability',
    ],
    [
        'Surface.resume',
        "resumeToken/resumeRetry are independent P21 plugin-extension hooks — resumeToken's documented pairing is with applyResume (a different prefix); nesting only these two would fragment that pairing without simplifying anything",
    ],
    // (b) P12 dominant-field carve-out — the second member is a discriminator/tag for the
    // dominant field, not an independent option:
    [
        'AdapterRequest.body',
        'bodyType is a discriminator tag for the dominant body payload, not a second option — carve-out (b), the canonical case',
    ],
    // Coincidental prefix collision — a house field plus an unrelated field that happens to
    // mirror a foreign standard's naming:
    [
        'WindowChannelOptions.target',
        "targetOrigin mirrors window.postMessage()'s own parameter name (P22); target (the destination handle) is unrelated — coincidental collision, not a group",
    ],
    [
        'CookieSessionOptions.login',
        'login (the required, dominant login Stitch) and loginInput (an unrelated input-resolver callback) are different value-kinds, not two knobs of one capability',
    ],
]);

// P4/D2 — the ONE cap vocabulary. A **count** upper bound is a bare plural noun (`attempts`,
// `entries`, `pages`, `failures`, `concurrency`, `tokens`) — never `max`-prefixed, never a bare
// `max`, never `*Threshold`. `max` survives only where it bounds a continuous **magnitude** and a
// bare noun would be ambiguous, so every `max` cap on a consumer-input envelope has to be a
// VERIFIED magnitude. That verification is what this allow-list records — keyed
// `Interface.member`, one rationale per entry, the same idiom as R5's de-listed UNIQUE_WATCH names
// and R8's PREFIX_GROUP_ALLOW. A new `max` cap therefore forces a written judgement (magnitude or
// count?) instead of passing by resemblance to the three below.
//
// Keyed on the DECLARING interface, which is where the rename would go — not on the exported
// envelope a member may be reached through by `extends`.
const MAX_CAP_ALLOW = new Map([
    [
        'BackoffOptions.max',
        'the retry delay ceiling — a DURATION, the continuous magnitude D2 explicitly leaves `max`; it sits beside `base` (the first-step delay), where a bare noun would name neither end',
    ],
    [
        'ServeBodyOptions.max',
        'ceiling on the buffered request body in BYTES — a magnitude, not a count of units; unsuffixed because bytes are the house size unit (P25) and a body off the socket is natively bytes, unlike the `chars` caps (trace.body.chars, stream.buffer.chars) which ARE counts and are spelled as such',
    ],
    [
        'ShellBufferOptions.max',
        "ceiling on the buffered subprocess stdout/stderr in BYTES — the size analogue of BackoffOptions.max, one thing to measure (P1) and a magnitude; the dimension execFile's own `maxBuffer` bounds",
    ],
]);

// A `max` cap: bare `max`, or `max`-prefixed. Both are P4's target — the sweep record fixed
// `ReconnectOptions.maxAttempts`/`CacheOptions.maxEntries`/`LlmOptions.maxTokens` (prefixed) AND
// `paginate.max` (bare) to plural nouns, so a rule that read only `/max[A-Z]/` would miss the
// second half of the vocabulary and, worse, would give the allow-list nothing to verify: every
// legitimate magnitude ceiling on today's surface is a BARE `max`. `maximum` does not match —
// the prefix must end a camel word.
const isMaxCap = (name) => /^max(?:$|[A-Z0-9])/.test(name);
// `*Threshold` gets no allow-list because P4 grants it no carve-out: it is a count word by
// construction, whatever it counts. `CircuitOptions.failureThreshold` → `failures` was the real
// instance, fixed in the 2026-07 sweep.
const isThresholdCap = (name) => /Threshold$/.test(name);

// P17/P25 — the house duration + byte-size member vocabulary. A value a consumer AUTHORS in one
// of these positions must take `number | string` ("if it accepts a duration/size at all, it also
// accepts a string"); a bare `number` is the violation R9 reports.
//
// A CLOSED, curated list, derived from the two parsers' call sites rather than from a name PATTERN,
// because the failure mode to avoid is flagging a COUNT: P4 spells every count as a bare plural
// (`attempts`, `entries`, `pages`, `failures`, `concurrency`, `tokens`) and P25 spells a code-unit
// cap `chars` — all of which MUST stay bare `number`, and none of which appear below. `base`/`max`
// are safe to list precisely because P4 reserves `max` for a MAGNITUDE ceiling and forbids it on a
// count, so every `max` on an authoring surface is a duration or a byte size, whichever its
// envelope names — and both dimensions take the same widening, so the rule never has to tell them
// apart. Adding a name here is a contract decision; adding a regex would be a guess.
const WIDENED_MEMBER = new Set([
    'after', // SurfaceOutcome's body-aware retry wait (ADR 0022 D5)
    'base', // BackoffOptions — first-step delay
    'cooldown', // CircuitOptions — fast-fail window
    'delay', // ReconnectOptions / MockResponse
    'interval', // any polling cadence
    'lease', // ThrottleOptions — how long a fleet-wide concurrency slot is held
    'max', // BackoffOptions (delay ceiling) | ServeBodyOptions/ShellBufferOptions (byte cap)
    'perAttempt', // TimeoutOptions
    'resumeRetry', // Surface — the server-suggested reconnect backoff (returned by the seam)
    'since', // CLI/query time window
    'skew', // OAuth2RefreshOptions — refresh lead time
    'timeout',
    'total', // TimeoutOptions — whole-call deadline
    'ttl', // CacheOptions / CookieSessionOptions / verifyStoreContract's knob
]);

// The counterpoint (P25): a CODE-UNIT cap is not a size in P25's sense, so it must NOT grow a
// string arm — `'64kb'` on decoded text is a category error the type is supposed to reject. R9
// checks this direction too, so the Bytes/Chars contrast is gated from both sides.
const COUNT_MEMBER = new Set(['chars']);

// Where a consumer AUTHORS a value. `*Options` IS the consumer-input envelope by P3, which is what
// makes R9 high-precision without type info: the produced shapes (`*Result`, `*Response`,
// `*Event`, and the resolved internals) are excluded BY NAME, so P17/P25's emitted complement —
// a raw-ms/raw-byte `number` that MUST NOT take a string — can never be flagged. Plus the
// consumer-implemented seams (P21), where the authored value is a RETURN rather than a field:
// that is the position the 2026-07 sweep missed, since its checklist was end-user config.
const AUTHORED_SEAM = new Set([
    'Surface',
    'Adapter',
    'TraceSink',
    'AuthStrategy',
]);
const isAuthoringSurface = (name) =>
    /Options$/.test(name) || AUTHORED_SEAM.has(name);

// Depth of `idx` within `body`, counting only braces/parens/brackets — NOT angle brackets, whose
// `>` also closes an arrow (`=> number`) and would truncate a function-typed member's type.
function depthAt(body, idx) {
    let d = 0;
    for (let i = 0; i < idx; i++) {
        const ch = body[i];
        if (ch === '{' || ch === '(' || ch === '[') d++;
        else if (ch === '}' || ch === ')' || ch === ']') d--;
    }
    return d;
}

// Top-level members WITH their declared type text — the shape R9 needs, where the other member
// rules only need a name. The type runs from the `:` to the terminating `;` at the member's own
// depth, so a union wrapped across lines reads as one type.
function topLevelMembersTyped(body) {
    const out = [];
    const re =
        /(?:^|\n)[ \t]*(?:readonly[ \t]+)?([A-Za-z_]\w*)[ \t]*\??[ \t]*:/g;
    let m;
    while ((m = re.exec(body))) {
        const nameAt = m.index + m[0].indexOf(m[1]);
        if (depthAt(body, nameAt) !== 0) continue; // a member of a NESTED object-literal type
        let d = 0;
        let j = re.lastIndex;
        for (; j < body.length; j++) {
            const ch = body[j];
            if (ch === '{' || ch === '(' || ch === '[') d++;
            else if (ch === '}' || ch === ')' || ch === ']') {
                if (d === 0) break;
                d--;
            } else if (ch === ';' && d === 0) break;
        }
        out.push({
            name: m[1],
            type: body.slice(re.lastIndex, j).trim(),
            index: nameAt,
        });
    }
    return out;
}

// Top-level (depth-0) field/method names of an interface body, in source order, deduped by name
// (an overloaded method — `set(...)` declared twice — is one field, not two).
function topLevelFieldNames(body) {
    const out = [];
    const seen = new Set();
    let depth = 0;
    let offset = 0;
    for (const line of body.split('\n')) {
        if (depth === 0) {
            const m = /^\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*\??\s*[:(]/.exec(
                line,
            );
            if (m && !seen.has(m[1])) {
                seen.add(m[1]);
                out.push({ name: m[1], index: offset + m.index });
            }
        }
        for (const ch of line) {
            if (ch === '{' || ch === '(') depth++;
            else if (ch === '}' || ch === ')') depth--;
        }
        offset += line.length + 1;
    }
    return out;
}

function collect() {
    const violations = [];
    const add = (rule, file, symbol, detail, line) =>
        violations.push({
            rule,
            file: rel(file),
            symbol,
            detail,
            line: line ?? null,
            key: `${rule}|${rel(file)}|${symbol}`,
        });

    const packages = publishedPackages();
    const exportsByName = new Map(); // identifier -> Set(dir)
    const seenR6 = new Set(); // declaration sites already reported (see R6)
    const seenR10 = new Set(); // ditto for R10 — a separate set, so neither rule mutes the other

    // PRE-PASS — every all-optional interface name, per package. R6 used to resolve only
    // against declarations in the SAME file, so an envelope imported from a sibling module
    // (elysia's `StitchErrorOptions`, declared in `./error.ts`) was invisible and the slot
    // went unflagged. A peer package's config types also come from core, so each package
    // resolves against its own names PLUS core's. Still name-based, not type-aware: two
    // packages declaring the same name is itself a P9 finding (R5), not this rule's problem.
    const allOptionalByPkg = new Map(); // dir -> Set(interface name)
    const ifaceByPkg = new Map(); // dir -> Map(name -> block, incl. non-exported bases)
    const aliasByPkg = new Map(); // dir -> [{ name, rhs }] (non-generic `type X = …`)
    for (const { dir } of packages) {
        const names = new Set();
        const byName = new Map();
        const aliases = [];
        for (const file of tsFiles(join(PKGS, dir, 'src'))) {
            const src = readFileSync(file, 'utf8');
            for (const blk of interfaceBlocks(src, { includeLocal: true })) {
                if (isAllOptional(blk.body)) names.add(blk.name);
                byName.set(blk.name, { ...blk, file, src });
            }
            aliases.push(...typeAliases(src));
        }
        allOptionalByPkg.set(dir, names);
        ifaceByPkg.set(dir, byName);
        aliasByPkg.set(dir, aliases);
    }

    // ALIAS PASS (#564 item 1) — one level, interfaces only. `type X = A | Bag` makes `X`
    // admit `{}` just as surely as the bag itself does, but an alias is not an interface
    // block, so the pre-pass above cannot see it.
    //
    // The candidate set is SNAPSHOTTED from the interface pass before any alias is added, and
    // core's snapshot is a copy. That is what bounds this to one level: an arm naming another
    // alias is never in the snapshot, so aliases cannot chain, in either resolution order.
    // Anything deeper is the type-aware phase's job.
    const aliasBagByPkg = new Map(); // dir -> Map(alias name -> the bag it resolves through)
    {
        const coreIfaceOnly = new Set(allOptionalByPkg.get('core') ?? []);
        for (const { dir } of packages) {
            const resolvable = new Set([
                ...(allOptionalByPkg.get(dir) ?? []),
                ...coreIfaceOnly,
            ]);
            const bags = new Map();
            for (const { name, rhs } of aliasByPkg.get(dir) ?? []) {
                const bag = unionArms(rhs).find((a) => resolvable.has(a));
                if (!bag) continue;
                bags.set(name, bag);
                allOptionalByPkg.get(dir)?.add(name);
            }
            aliasBagByPkg.set(dir, bags);
        }
    }

    const coreAllOptional = allOptionalByPkg.get('core') ?? new Set();
    const coreIfaces = ifaceByPkg.get('core') ?? new Map();
    const coreAliasBags = aliasBagByPkg.get('core') ?? new Map();

    for (const { dir } of packages) {
        const srcRoot = join(PKGS, dir, 'src');
        const allOptional = new Set([
            ...(allOptionalByPkg.get(dir) ?? []),
            ...coreAllOptional,
        ]);
        const ifaces = new Map([
            ...coreIfaces,
            ...(ifaceByPkg.get(dir) ?? new Map()),
        ]);
        // Which of the names in `allOptional` got there through an alias, and the bag each
        // resolves through — the fix goes on the bag ARM inside the alias, not on the alias.
        const aliasBags = new Map([
            ...coreAliasBags,
            ...(aliasBagByPkg.get(dir) ?? new Map()),
        ]);
        // An envelope plus every interface it extends, transitively — the members a consumer
        // can actually write at that slot. `seen` guards a cyclic `extends`.
        const withBases = (blk) => {
            const out = [];
            const seen = new Set();
            const walk = (b) => {
                if (!b || seen.has(b.name)) return;
                seen.add(b.name);
                out.push(b);
                for (const base of b.bases ?? []) walk(ifaces.get(base));
            };
            walk(blk);
            return out;
        };
        for (const file of tsFiles(srcRoot)) {
            const src = readFileSync(file, 'utf8');

            // R1 — banned type-name suffix (P3). Type declarations only — a `function`/`const`
            // ending in Config (redactConfig, the ADR-0012 fromNestConfig constructor) is not
            // a consumer-input type and is out of scope.
            for (const { kind, name, index } of exportedDeclNames(src)) {
                if (kind !== 'interface' && kind !== 'type' && kind !== 'class')
                    continue;
                if (
                    BANNED_SUFFIX.test(name) &&
                    !SUFFIX_CARVEOUT.has(name) &&
                    !isLike(name) &&
                    !deprecatedBefore(src, index)
                ) {
                    add(
                        'R1',
                        file,
                        name,
                        /(Return|State)$/.test(name)
                            ? `banned suffix on produced shape → *Result (P3)`
                            : `banned suffix on consumer type → *Options (P3)`,
                        lineOf(src, index),
                    );
                }
            }

            // R2 — ANY field carrying the `Ms` suffix (P17: ms is the house unit, so the
            // suffix is dropped EVERYWHERE — input and emitted; the unit lives in JSDoc).
            // File-level scan so it catches type-union / class fields (StitchEvent,
            // RateLimitError), not only interface bags. Anchored to a declaration position
            // ([\n{;,(] then `name?:`) so prose mentions of `…Ms` in JSDoc don't match.
            // Deduped by field name per file.
            {
                const fre = /(?:^|[\n{;,(])\s*([A-Za-z_]\w*Ms)\s*\??:/g;
                const seen = new Set();
                let f;
                while ((f = fre.exec(src))) {
                    // Carve-out: an epoch *timestamp* (`*UnixMs`) keeps its unit — Unix time is
                    // conventionally SECONDS, so a bare `startUnix` would be misleading, and these
                    // mirror OTLP's `*Unix*` fields (P18). The rule targets DURATIONS, not instants.
                    if (/Unix(Ms|Nano|Seconds)$/.test(f[1])) continue;
                    if (deprecatedBefore(src, f.index)) continue; // a renamed-under-alias field
                    if (seen.has(f[1])) continue;
                    seen.add(f[1]);
                    add(
                        'R2',
                        file,
                        f[1],
                        `duration field carries Ms suffix → drop it (ms is the house unit; P17)`,
                        lineOf(src, f.index),
                    );
                }
            }

            const blocks = interfaceBlocks(src);
            for (const blk of blocks) {
                // R3 — function-typed `key` (P6: a derivation fn must be `keyOf`)
                const keyM = /(^|\n)\s*key\s*\??:\s*\(/.exec(blk.body);
                if (
                    keyM &&
                    !deprecatedBefore(src, blk.bodyStart + keyM.index)
                ) {
                    add(
                        'R3',
                        file,
                        `${blk.name}.key`,
                        `function-typed key → rename keyOf (P6)`,
                        lineOf(src, blk.bodyStart + keyM.index),
                    );
                }
                // R4 — `scope: 'stitch'|'host'` overloads the tenancy word (P2: rename to pool)
                const scopeM = /(^|\n)\s*scope\s*\??:\s*'(stitch|host)'/.exec(
                    blk.body,
                );
                if (
                    scopeM &&
                    !deprecatedBefore(src, blk.bodyStart + scopeM.index)
                ) {
                    add(
                        'R4',
                        file,
                        `${blk.name}.scope`,
                        `pool axis named scope → rename pool (P2)`,
                        lineOf(src, blk.bodyStart + scopeM.index),
                    );
                }
                // R9 — a duration/byte-size a consumer AUTHORS that does not take the canonical
                // `number | string` (P17/P25: "if it accepts a duration or a size at all, it must
                // also accept a string"). Scoped to the authoring surfaces above, so the emitted
                // complement — which must stay a bare ms/byte `number` — is out of range by
                // construction rather than by guesswork. The reverse direction is checked too: a
                // `chars` code-unit cap that grew a string arm is the same rule's category error.
                if (isAuthoringSurface(blk.name)) {
                    for (const { name, type, index } of topLevelMembersTyped(
                        blk.body,
                    )) {
                        if (deprecatedBefore(src, blk.bodyStart + index))
                            continue;
                        const at = lineOf(src, blk.bodyStart + index);
                        const takesNumber = /\bnumber\b/.test(type);
                        const takesString = /\bstring\b/.test(type);
                        if (
                            WIDENED_MEMBER.has(name) &&
                            takesNumber &&
                            !takesString
                        )
                            add(
                                'R9',
                                file,
                                `${blk.name}.${name}`,
                                `authored duration/size takes number only → widen to number | string and read it through parseDuration/parseBytes (P17/P25)`,
                                at,
                            );
                        if (COUNT_MEMBER.has(name) && takesString)
                            add(
                                'R9',
                                file,
                                `${blk.name}.${name}`,
                                `code-unit cap takes a string → a size token on decoded text is a category error; keep it a bare number (P25)`,
                                at,
                            );
                    }
                }
            }

            // R6 — a config slot that accepts the opaque empty object `{}` (P20). Two envelope
            // tiers are covered, both resolved against SAME-FILE declarations only (cross-file
            // resolution is the deferred type-aware phase — see the header):
            //   (a) a StitchConfig capability slot typed as a bare all-optional bag
            //       → fix: `Scalar | AtLeastOne<Options>` so all-defaults is a scalar;
            //   (b) a NESTED option-envelope toggle (the SseOptions.reconnect class): a member
            //       of an exported `*Options` interface typed `boolean | X` where X is an
            //       all-optional bag, or typed as a bare all-optional `*Options` bag
            //       → fix: `boolean | AtLeastOne<X>` (the AtLeastOne wrapper naturally clears
            //       the finding — `AtLeastOne` is never an all-optional local interface).
            const cfgBlock = blocks.find((b) => b.name === 'StitchConfig');
            if (cfgBlock) {
                const fre = /(?:^|\n)\s*([A-Za-z_]\w*)\??:\s*([A-Z]\w*)\s*;/g;
                let f6;
                while ((f6 = fre.exec(cfgBlock.body))) {
                    if (allOptional.has(f6[2]))
                        add(
                            'R6',
                            file,
                            `StitchConfig.${f6[1]}`,
                            `all-optional ${f6[2]} accepts {} → Scalar|AtLeastOne<${f6[2]}> (P20)`,
                            lineOf(src, cfgBlock.bodyStart),
                        );
                }
            }
            // (b) ANY member of an exported interface whose type has an all-optional bag in
            // ANY arm of its union. The old check only matched a bare `X` or a leading
            // `boolean | X`, which is not what makes `{}` legal — one assignable arm is, in
            // any position. That blind spot hid `delta?: DeltaShaper | DeltaFrameOptions`
            // (function first) and `errorHandler?: StitchErrorOptions | false` (bag first,
            // non-boolean second). The bag may now also be reached through one level of `type`
            // alias (#564 item 1) — resolved in the alias pass above, reported against the bag
            // the alias unions in. `AtLeastOne<X>` is never an all-optional interface name and
            // is never a bare arm, so the canonical fix clears the finding by construction.
            for (const blk of blocks) {
                // Only CONSUMER-INPUT envelopes — P20 governs what a caller authors, not what
                // the engine hands back. P3 already draws that line, so reuse it: `*Options`
                // plus the blessed `*Config` authoring family, minus `*Like` duck-types. See
                // isConsumerEnvelope() for why a wider net floods the rule.
                if (!isConsumerEnvelope(blk.name)) continue;
                for (const owner of withBases(blk)) {
                    const mre =
                        /(?:^|\n)\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*\??:\s*([^;\n]+);/g;
                    let m6;
                    while ((m6 = mre.exec(owner.body))) {
                        // Arms of the union, minus generic payloads — `AtLeastOne<Foo>` must not
                        // read as bare `Foo`, or the prescribed fix would flag itself.
                        const bag = unionArms(m6[2]).find((a) =>
                            allOptional.has(a),
                        );
                        if (!bag) continue;
                        const at = owner.bodyStart + m6.index;
                        if (deprecatedBefore(owner.src ?? src, at)) continue;
                        // Report the DECLARATION site, not every descendant that inherits
                        // it: `SseEmitOptions.delta` is ONE edit reachable through three
                        // exported envelopes, and three findings for one fix would only
                        // inflate the baseline.
                        const site = `${owner.file ?? file}|${at}`;
                        if (seenR6.has(site)) continue;
                        seenR6.add(site);
                        // Through an alias, the edit belongs on the bag ARM inside the alias
                        // (`type R = AtLeastOne<Bag> | …`), not on the alias name — wrapping a
                        // union that also carries a function arm would be nonsense.
                        const via = aliasBags.get(bag);
                        add(
                            'R6',
                            owner.file ?? file,
                            `${owner.name}.${m6[1]}`,
                            via
                                ? `all-optional ${via} via alias ${bag} — {} type-checks → AtLeastOne<${via}> inside ${bag} (P20)`
                                : `all-optional ${bag} in the union — {} type-checks → AtLeastOne<${bag}> (P20)`,
                            lineOf(owner.src ?? src, at),
                        );
                    }
                }
            }

            // R10 — the cap vocabulary on a consumer-input envelope (P4/D2). A COUNT upper
            // bound is a bare plural noun; `max` is reserved for a continuous MAGNITUDE
            // ceiling and must be verified on MAX_CAP_ALLOW; `*Threshold` is banned outright.
            //
            // The container filter is R6's, and it is what makes the rule high-precision:
            // P4 governs the AUTHORING surface, and P4 itself blesses `max*` on the resolved
            // internals — engine.ts's reconnect policy, shell's `ShellDefaults.maxBuffer`,
            // the `maxBufferChars` parameters — which name a computed value no consumer
            // writes. Those are outside `*Options` by construction, so they are excluded by
            // name rather than by a hand-kept skip list.
            //
            // Inherited members count: a base's member is as writable at the slot as a
            // declared one (R6's reason for walking `extends`), so the scan walks bases and
            // reports the DECLARATION site once, deduped — one rename, one finding.
            for (const blk of blocks) {
                if (!isConsumerEnvelope(blk.name)) continue;
                for (const owner of withBases(blk)) {
                    // A `*Like` BASE keeps its upstream spelling too (P18) — the same
                    // exclusion the top-level filter applies, applied down the chain.
                    if (isLike(owner.name)) continue;
                    for (const { name, index } of topLevelMembersTyped(
                        owner.body,
                    )) {
                        const max = isMaxCap(name);
                        const threshold = isThresholdCap(name);
                        if (!max && !threshold) continue;
                        if (max && MAX_CAP_ALLOW.has(`${owner.name}.${name}`))
                            continue;
                        const at = owner.bodyStart + index;
                        const osrc = owner.src ?? src;
                        if (deprecatedBefore(osrc, at)) continue;
                        const site = `${owner.file ?? file}|${at}`;
                        if (seenR10.has(site)) continue;
                        seenR10.add(site);
                        add(
                            'R10',
                            owner.file ?? file,
                            `${owner.name}.${name}`,
                            threshold
                                ? `*Threshold names a count cap → a bare plural noun (failureThreshold → failures); P4 leaves it no carve-out (P4/D2)`
                                : `\`${name}\` caps a consumer-input envelope → if it counts, spell it a bare plural (attempts/entries/pages/tokens); if it is a verified MAGNITUDE ceiling, add it to MAX_CAP_ALLOW with the reason (P4/D2)`,
                            lineOf(osrc, at),
                        );
                    }
                }
            }

            // R8 — a shared leading-word prefix across ≥2 flat members of the SAME exported
            // interface, not on the curated allow-list (P24). The conventional on*/is*/percentile
            // prefixes are excluded from grouping entirely (never even reach the allow-list); a
            // deprecated declaration is skipped like R1/R3/R4/R6 (a hypothetical alias is R7's
            // finding, not double-counted here).
            for (const blk of blocks) {
                if (deprecatedBefore(src, blk.index)) continue;
                const fields = topLevelFieldNames(blk.body).filter(
                    (f) => !CONVENTIONAL_MEMBER.test(f.name),
                );
                const groups = new Map(); // leading word -> field entries
                for (const f of fields) {
                    const word = leadingWord(f.name);
                    (groups.get(word) ?? groups.set(word, []).get(word)).push(
                        f,
                    );
                }
                for (const [word, members] of groups) {
                    if (members.length < 2) continue;
                    if (PREFIX_GROUP_ALLOW.has(`${blk.name}.${word}`)) continue;
                    add(
                        'R8',
                        file,
                        `${blk.name}.${word}`,
                        `${members.map((m) => m.name).join('/')} share the "${word}" prefix → fold into one envelope (P24)`,
                        lineOf(src, blk.bodyStart + members[0].index),
                    );
                }
            }

            // R7 — a `@deprecated` JSDoc TAG in a published package's src (amended P19).
            // The GA hard-break sweep removed every pre-GA migration shim; post-GA policy is
            // that deprecation aliases do not accumulate on the surface — a removal is a
            // semver-major, not a shim. One finding per file (first occurrence) keeps the
            // baseline key stable if a stray marker gains siblings before it's purged.
            {
                const d = deprecatedTagIndex(src);
                if (d !== -1)
                    add(
                        'R7',
                        file,
                        '@deprecated',
                        `deprecated shim on the published surface — remove, don't alias (amended P19: GA shipped shim-free)`,
                        lineOf(src, d),
                    );
            }
        }

        for (const id of indexExports(join(srcRoot, 'index.ts'))) {
            if (!exportsByName.has(id)) exportsByName.set(id, new Set());
            exportsByName.get(id).add(dir);
        }
    }

    // R5 — watch-listed identifier exported by ≥2 published packages (P9/P16)
    for (const [id, dirs] of exportsByName) {
        if (UNIQUE_WATCH.has(id) && dirs.size > 1) {
            add(
                'R5',
                join(PKGS, '<multiple>'),
                id,
                `exported by ${[...dirs].sort().join(', ')} — must be unique-by-shape (P9/P16)`,
                null,
            );
        }
    }

    return violations.sort((a, b) => a.key.localeCompare(b.key));
}

// ---- ratchet --------------------------------------------------------------
const args = new Set(process.argv.slice(2));
const current = collect();
const currentKeys = new Set(current.map((v) => v.key));

if (args.has('--list')) {
    const byRule = {};
    for (const v of current) (byRule[v.rule] ??= []).push(v);
    for (const rule of Object.keys(byRule).sort()) {
        console.log(`\n${rule} (${byRule[rule].length}):`);
        for (const v of byRule[rule])
            console.log(
                `  ${v.file}${v.line ? `:${v.line}` : ''}  ${v.symbol} — ${v.detail}`,
            );
    }
    console.log(`\nTotal: ${current.length} violations.`);
    process.exit(0);
}

if (args.has('--update')) {
    writeFileSync(
        BASELINE,
        JSON.stringify(
            {
                generatedBy: 'scripts/check-contract.mjs --update',
                count: current.length,
                violations: current,
            },
            null,
            4,
        ) + '\n',
    );
    console.log(`✓ Baseline rewritten: ${current.length} known violations.`);
    process.exit(0);
}

if (!existsSync(BASELINE)) {
    console.error(
        '✗ No baseline found. Run `node scripts/check-contract.mjs --update` to create it.',
    );
    process.exit(1);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const baseKeys = new Set((baseline.violations ?? []).map((v) => v.key));

const added = current.filter((v) => !baseKeys.has(v.key));
const fixed = [...baseKeys].filter((k) => !currentKeys.has(k));

if (fixed.length) {
    console.log(
        `\n✓ ${fixed.length} baseline violation(s) fixed — shrink the baseline with ` +
            '`node scripts/check-contract.mjs --update`:',
    );
    for (const k of fixed.sort()) console.log(`    ${k}`);
}

if (added.length) {
    console.error(
        `\n✗ ${added.length} NEW API meta-contract violation(s) (docs/CONTRACT.md):`,
    );
    for (const v of added)
        console.error(
            `    [${v.rule}] ${v.file}${v.line ? `:${v.line}` : ''}  ${v.symbol} — ${v.detail}`,
        );
    console.error(
        '\n  Fix it, or — if this is an intentional, contract-aligned change — refresh the ' +
            'baseline with `node scripts/check-contract.mjs --update` and commit it.',
    );
    process.exit(1);
}

console.log(
    `✓ API meta-contract: no new violations (${baseKeys.size} known, baselined).`,
);
