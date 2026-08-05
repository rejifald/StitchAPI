// Shared vocabulary for the prototype. Leaf modules (resilience, trace, http-adapter,
// auth, mock-server) and the engine all code against these types.
import type {
    NormalizedSlot,
    RedactedSlot,
    ResolvedNormalizations,
} from './config-anatomy';
import type {
    AnyLayer,
    Args,
    InferOutput,
    InputOf,
    Layers,
    RelaxKeys,
    ResolveOutput,
    SchemaLike,
} from './infer';
import type { Surface } from './surface';
import type { Validator } from './validator';

/**
 * A value with **at least one** property of `T` set. The empty object `{}` satisfies none of the
 * per-key-required variants, so it is a type error — used so an all-optional options envelope's
 * object form requires real customization while the enable-with-defaults case stays a scalar
 * (`true`), never the opaque `{}` (CONTRACT.md P20).
 */
export type AtLeastOne<T, K extends keyof T = keyof T> = {
    // `-?` is load-bearing. This mapped type is HOMOMORPHIC (`P in K` where `K extends keyof T`),
    // so without it the `?` of every source property is preserved — and since the envelopes this
    // wraps are all-optional by construction, indexing `[K]` then yields `… | undefined`. The
    // resulting type still rejects `{}`, so P20 held, but the stray `undefined` leaked into every
    // consumer that narrowed one of these unions (it surfaced on `MockResponder`).
    [P in K]-?: Required<Pick<T, P>> & Partial<Omit<T, P>>;
}[K];

export interface StitchInput {
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: unknown;
    headers?: Record<string, string>;
    variables?: Record<string, unknown>; // GraphQL variables (kind: 'graphql')
    /**
     * Per-call cancellation (ADR 0005 Decision 8). The engine threads it onto the request and
     * links it with the per-attempt timeout, so aborting it cancels the in-flight call. Runtime-
     * only — never serialised, never on `__config`.
     */
    signal?: AbortSignal;
    /**
     * Per-call byte-progress callback (ADR 0005 Decision 9), threaded onto the request — fires as
     * the request body is sent (`'upload'`, needs `xhrAdapter`) / the response arrives
     * (`'download'`). The `download` surface's natural progress channel. Runtime-only.
     */
    onProgress?: (progress: AdapterProgress) => void;
}

// ---- Drift ----------------------------------------------------------------
/**
 * Severity of a finding. `error` is reserved for a hard validation failure (`change: 'invalid'`),
 * which fails the call; soft drift is non-fatal — `warn` / `info` / `verbose` (quietest), see
 * {@link DriftSeverity}.
 */
export type DriftLevel = 'error' | 'warn' | 'info' | 'verbose';
/**
 * What a finding reports. The three **soft** kinds come from diffing the raw response against the
 * validated value (ADR 0015): `undeclared` (a key the schema stripped), `coerced` (a value the
 * schema coerced — a hidden wire-type shift), `defaulted` (a `.default()` fired because the field
 * was absent). `invalid` is the **hard** validation failure (missing-required / incompatible) that
 * throws.
 */
export type DriftChange = 'undeclared' | 'coerced' | 'defaulted' | 'invalid';
/** The soft (diff-derived) drift kinds — the ones whose severity is configurable. */
export type SoftDriftChange = Exclude<DriftChange, 'invalid'>;
/** Non-fatal severities a soft drift finding can carry. (Fatality is the schema's job — make the field required.) */
export type DriftSeverity = 'warn' | 'info' | 'verbose';
export interface DriftFinding {
    level: DriftLevel;
    path: string;
    change: DriftChange;
    detail?: string;
    /** Concrete-index path for the first occurrence of this finding within an array summary (e.g. `"items[3].x"`). Present only on array-collapsed findings (ADR 0017). */
    sample?: string;
}
export interface DriftOptions {
    /**
     * Paths whose soft drift is suppressed — the acknowledged-but-unconsumed surface of the API, kept
     * out of the typed schema so the contract stays tight (ADR 0015). A narrow consumer schema means
     * an undeclared field is usually one you already know about, not a true addition; `ignore` is the
     * curated, path-only "known surface" (no typed baseline, so no variance false positives).
     *
     * The grammar mirrors the finding path: nested keys join with `.`, an **array element** is `[]`
     * (so `items[].meta` matches every element's `meta`), and a pattern matches by exact path, a
     * single-segment `*` wildcard, or as a prefix (`meta` ignores `meta` and everything beneath it).
     * A bare string is shorthand for a one-element list (CONTRACT.md P7).
     *
     * @example `ignore: ['meta', '_links', 'debug.*']`
     */
    ignore?: string | string[];
    /**
     * How soft drift is leveled / filtered. Three shapes (ADR 0015):
     * - a **single level** or a **bare list** of levels — an _allowlist_ of which severities to
     *   surface (others are dropped), keeping the per-kind defaults below. `'warn'` ≡ `['warn']`.
     * - a **map** of soft-change kind → severity — _re-levels_ a kind (all kinds still surface).
     *
     * Per-kind defaults: `undeclared` → `info`, `coerced` → `warn`, `defaulted` → `verbose`.
     * Omitted ⇒ every soft drift surfaces at its default level. Soft drift is always non-fatal;
     * to fail on a change, make the field required/strict in the schema (it becomes `invalid`).
     *
     * @example severity: 'warn'                         // surface only warn-level drift
     * @example severity: ['info', 'warn']               // surface info and warn (drop verbose)
     * @example severity: { coerced: 'info', defaulted: 'info' } // re-level two kinds
     */
    severity?:
        | DriftSeverity
        | DriftSeverity[]
        | Partial<Record<SoftDriftChange, DriftSeverity>>;
}
export interface DriftSpec<T = unknown> {
    __kind: 'drift';
    schema: Validator<T>;
    options: DriftOptions;
}

// ---- Adapter (HTTP kind) --------------------------------------------------
/** How to read the response body. Default (unset) = auto: JSON when the content-type is json-ish, else text. */
export type ResponseType = 'json' | 'text' | 'arrayBuffer' | 'blob';
/**
 * How a multipart body serialises nested objects/arrays into field names (ADR 0005 Decision 6).
 * - `'bracket'` (default) — `parent[child][0]` keys (PHP/Rails convention; broadest compatibility).
 * - `'dot'` — `parent.child.0` keys.
 * - `'json'` — non-file data is one JSON part; each file leaf is hoisted to its own path-keyed part.
 * - `'none'` — top-level keys only (legacy; a nested object stringifies to `[object Object]`).
 */
export type MultipartNesting = 'bracket' | 'dot' | 'json' | 'none';
export interface MultipartOptions {
    /** Nesting strategy for nested objects/arrays in a multipart body. Default `'bracket'`. */
    nesting?: MultipartNesting;
}
/**
 * How arrays are serialised on the two `application/x-www-form-urlencoded` surfaces — the query
 * string and a `wire.body: 'form'` body. Both run the same walker, so one {@link WireOptions.array}
 * governs both. Nested objects always expand `qs`-style to `a[b]=c`; this selects only the array
 * axis.
 */
export type ArrayFormat = 'indices' | 'brackets' | 'repeat';
/** Request body wire format. Default `'json'`. */
export type BodyEncoding = 'json' | 'form' | 'multipart';
/**
 * Wire-format options — how values are framed on their way out and read on their way back
 * (CONTRACT.md P24 carve-out (a)/(b)). The envelope groups by **category**, not by request/response
 * phase: every member is a wire-format choice, so the name is exhaustive over its contents. A phase
 * envelope could not be — `request` would hold two of the ~15 request-shaping slots while
 * `headers`, `method`, and `body` stayed outside — and no body-scoped container could hold
 * {@link WireOptions.array} truthfully, since it governs the query string as well as the body.
 *
 * Parallels {@link InputSchemas}: `input: { body: schema }` is the body's contract,
 * `wire: { body: 'form' }` is its encoding. Like `input`, no single field dominates, so there is no
 * P12 scalar shorthand — and the opaque `wire: {}` is rejected (P20).
 */
/**
 * What counts as success — the declarative input to **stage 4, the surface's `interpret`**
 * (ADR 0022 Decision 3). `interpret` renders the verdict; this is what it reads.
 *
 * It replaces the flat `acceptStatus` root slot, which had no stage in the config anatomy while
 * every other pipeline slot did — the tell that it was doing a pipeline stage's job while being
 * invisible in the pipeline. Both members are plain JSON (P0), and both move the verdict in exactly
 * ONE direction: `accept` can only turn a failure into a success, `flag` only a success into a
 * failure. Neither invents a verdict from absence. That symmetry is what makes the envelope
 * teachable, and it is the same discipline `acceptStatus` already documented — additive, never a
 * blanket "ignore failures".
 *
 * No P12 scalar shorthand: `verdict: [404]` would not tell a reader what the list means (`wire` and
 * `input` set the same precedent), and the opaque `verdict: {}` is rejected (P20).
 */
export interface VerdictOptions {
    /**
     * Status(es) that are a NORMAL result rather than an error — a number, a list, or a predicate
     * (CONTRACT.md P7). An accepted non-2xx flows through interpret → transform → pick → validate
     * exactly like a 2xx (the response body becomes the result), instead of throwing a
     * {@link StitchError}. Use this when an endpoint treats e.g. `404`/`400` as expected control
     * flow (resource-gone → fall back to a broader call) so the happy path no longer runs through a
     * `catch`.
     *
     * `retry.on` still wins while attempts remain: a status listed in BOTH is retried until attempts
     * are exhausted, then accepted (returned) on the final attempt. Orthogonal to
     * `throttle.delegate`, which surfaces a {@link RateLimitError} on rate-limit statuses earlier.
     */
    accept?: StatusMatch;
    /**
     * Dot-path to a body flag that is EXPLICITLY falsy on failure — the `{ ok: false, code }`
     * envelope common in older APIs, turned into declarative data instead of a hand-authored
     * surface. Same shape as `pick`.
     *
     * **Three-state, and only one state is a verdict:**
     *
     * | at the path                       | verdict                                             |
     * | --------------------------------- | --------------------------------------------------- |
     * | present, truthy                   | success — the flag confirms it                      |
     * | present, falsy (`false` `0` `''`) | **failure** — the flag says so. The feature.        |
     * | `null`                            | **no signal** — see below                           |
     * | absent (`undefined`)              | **no signal** — falls through to the status verdict |
     *
     * So it can only ever turn a would-be success into a failure **when it explicitly says so**. It
     * cannot manufacture a failure out of silence, and a `200` carrying no flag is still a `200`.
     * That matters because a server sends what it sends: the same endpoint returns
     * `{ meta: { success: true }, data }` on Tuesday and a bare `{ data }` on Wednesday — a
     * different version, a cache tier, a partial rollout. This library exists to survive that.
     *
     * `null` sits with absence rather than with `false` because APIs spell "not applicable" and
     * "unknown" as `null` constantly, and JS truthiness would read that as a declaration of failure
     * it never made.
     *
     * An absent path still emits an `info` **drift finding** (ADR 0015/0016) alongside `undeclared`,
     * so a typo — or an API that quietly dropped its envelope — shows up in `.inspect()` and the
     * drift report without anyone's call failing. If the envelope is genuinely guaranteed, declare
     * the field in `output` and let validation enforce it: that is what the schema is for, it
     * produces a real error with a real path, and it means `flag` needs no strict mode.
     */
    flag?: string;
}

export interface WireOptions {
    /**
     * Request body encoding. Default `'json'`.
     * - `'json'` — `JSON.stringify`, `Content-Type: application/json`.
     * - `'form'` — `application/x-www-form-urlencoded`; nests `qs`-style and honours
     *   {@link WireOptions.array}.
     * - `'multipart'` — `multipart/form-data`; the boundary is set by the transport, and nesting is
     *   governed by {@link WireOptions.multipart} rather than by `array`.
     */
    body?: BodyEncoding;
    /**
     * How the response body is read. Maps onto `AdapterRequest.responseType`, which keeps the
     * XHR/fetch spelling at the transport boundary (P22 — follow the standard that governs each
     * layer, and convert at the edge).
     */
    response?: ResponseType;
    /**
     * Array serialisation on BOTH urlencoded surfaces — the query string and a `body: 'form'` body,
     * which run the same walker (ADR 0005 Decision 6). Nested objects always expand `qs`-style to
     * `a[b]=c`; this selects the array axis only. Default `'indices'`.
     *
     * The two surfaces differ only in how a space is spelled — `%20` in a query string
     * (`encodeURIComponent`), `+` in a form body (`URLSearchParams`). Both round-trip.
     */
    array?: ArrayFormat;
    /**
     * Multipart serialisation options (ADR 0005 Decision 6) — how nested objects/arrays become
     * field names. Only meaningful with `body: 'multipart'`, and a compile error otherwise
     * ({@link MultipartOnlyOnMultipartBody}). Default nesting `'bracket'`. A bare
     * {@link MultipartNesting} string is shorthand for the object form — `multipart: 'dot'` ≡
     * `multipart: { nesting: 'dot' }` (P12); the opaque `multipart: {}` is rejected (P20).
     */
    multipart?: MultipartNesting | AtLeastOne<MultipartOptions>;
}
/**
 * Carries a human-readable explanation into a type error. Intersecting an offending slot with this
 * makes the slot unsatisfiable — so the config is still rejected — while keeping the message
 * legible: TypeScript prints the brand, and the brand IS the sentence. A bare `?: never` rejects
 * just as hard but reduces the whole surrounding object to `never`, which reports every unrelated
 * property as an error and never names the real one.
 */
export interface ConfigError<Message extends string> {
    readonly __stitchConfigError: Message;
}
/**
 * Compile-time guard: reject a key on an authored option bag that is not a slot of `Allowed`.
 * `What` names the bag in the error message, so each surface reports against its own vocabulary.
 *
 * Every authoring surface here infers `const C` from its argument so {@link InputOf} can read
 * path-template vars off the literal (Phase 2c). That inference is also what SUPPRESSES
 * TypeScript's excess-property check: the literal is compared against `C`, which was just inferred
 * from it, so it matches exactly and no property is ever "excess". The `C extends …` constraint is
 * then verified by ordinary assignability, which ignores freshness. Net effect without this guard:
 * `stitch({ path: '/x', timeut: 500 })` typechecks, and a REMOVED or RENAMED slot keeps typechecking
 * at every call site that still authors it.
 *
 * TypeScript's WEAK-TYPE detection gives partial cover for free, since these bags are all-optional:
 * a literal sharing NO property with the target is rejected regardless of freshness. It is only
 * partial — add one valid sibling key and the unknown one rides along, which is the case this guard
 * exists for and the reason every `expectError` in the type tests carries a valid sibling.
 *
 * That gap is why {@link LlmOptions}'s parameter USED to be non-generic: excess-property checking
 * was the only thing rejecting the removed `maxTokens` spelling (P4), and keeping it meant giving up
 * `const C` inference entirely. This guard supplies the rejection instead, so `llm` is now generic
 * and gets call-argument inference too — the trade is gone.
 *
 * Mechanism: intersecting the bag with a mapped type over `Exclude<keyof C, keyof Allowed>` makes
 * exactly the unknown keys unsatisfiable, so the error lands on the offending property with a
 * {@link ConfigError} brand that NAMES it. Known keys are untouched, and when there are none the
 * guard is `unknown` and intersects away.
 *
 * Cheaper than the sibling guards on purpose: one `keyof` and one `Exclude` per call site, with no
 * {@link Layers} walk. Unknown keys are a per-layer spelling concern, not a cross-layer pairing, so
 * a fragment reached through `extends` is not this guard's business — see the residual limit below,
 * which is the honest version of a claim this comment used to make.
 *
 * Scoped to the TOP level. The same suppression applies at every depth — `const C` is inferred from
 * the whole config object, so a nested envelope is no longer a fresh literal either — and that layer
 * is {@link NoUnknownNestedKeys}'s job, on the house envelopes it lists.
 *
 * STRONGER than excess-property checking in one respect, and the reason a rename is now caught
 * repo-wide: EPC only fires on a fresh literal, so a config hoisted into a `const` binding escapes
 * it. `keyof C` reads the binding's INFERRED type, so the hoisted spelling is rejected too.
 *
 * NOT applied to `Stitch.with` — the one surface whose RETURN type reads `keyof P`, which makes an
 * intersected parameter degrade the public `Stitch` type. The reasoning is recorded on `with` itself.
 *
 * RESIDUAL LIMITS:
 * - Fail-open: an unknown key inside an `extends` fragment carrying at least one real slot is not
 *   reported — INLINE or hoisted. This comment used to say the inline case was covered by EPC on the
 *   declared `Partial<StitchConfig> | Stitch`; it is not, for the same reason the top level is not.
 *   `C` is inferred from the whole config, so the fragment is not fresh either, and the real slot
 *   satisfies weak-type detection. A fragment of ONLY unknown keys IS still rejected, by weak-type
 *   detection. Both pinned in `unknown-config-keys.test-d.ts`. Closing it needs the {@link Layers}
 *   walk this guard declines; the fragment's own declaration site is the natural place to type it.
 * - Fail-open by design: a config whose static type is already `Partial<StitchConfig>` (or the loose
 *   `string | Partial<StitchConfig>` escape hatch) has no unknown keys to find. Its declaration site
 *   is where the spelling was checked, and that site had EPC.
 * - An index-signature config (`Record<string, unknown>`) is rejected, since every key is unknown.
 *   It never satisfied `Partial<StitchConfig>` usefully; pinned so the behaviour is deliberate.
 */
export type NoUnknownKeys<C, Allowed, What extends string> = C extends string
    ? unknown
    : [Exclude<keyof C, keyof Allowed>] extends [never]
      ? unknown
      : {
            [
                K in Exclude<keyof C, keyof Allowed>
            ]: ConfigError<`\`${Extract<K, string>}\` is not a ${What} slot — check the spelling`>;
        };
/**
 * {@link NoUnknownKeys} bound to {@link StitchConfig} — the `stitch` / `Seam.stitch` /
 * `Seam.graphql` / `graphql` / `download` / `sse` / `stream` authoring surfaces. The other option
 * bags reached through an inferred generic bind their own allowed set the same way:
 * `LlmOptions` (`stitchapi/llm`) and `RequestOptions` / `EmitOptions` / `EventsOptions`
 * (`stitchapi/postmessage`).
 */
export type NoUnknownConfigKeys<C> = NoUnknownKeys<
    C,
    StitchConfig,
    'StitchConfig'
>;
/**
 * The HOUSE envelopes {@link NoUnknownNestedKeys} descends into, as
 * `slot: [bag, its exported name, its own children]`.
 *
 * Explicit rather than derived from `StitchConfig[K]`, and that is a CORRECTNESS requirement, not a
 * cost tweak: several slots hold FOREIGN objects whose extra keys are the point. `output` takes a
 * `SchemaLike`, whose Zod arm is the phantom `{ _output: unknown }` — a real `z.object(…)` carries
 * ~40 keys beyond it, so a derived walk reports `safeParse` as a misspelling and every schema in
 * every config stops compiling. Same for `adapter` / `store` / `clock` / `trace` / `kind` / `auth`:
 * pluggable seams (P21), where an unknown key is an implementation detail, not a typo.
 */
interface NestedEnvelopes {
    wire: [
        WireOptions,
        'WireOptions',
        { multipart: [MultipartOptions, 'MultipartOptions', object] },
    ];
    stream: [
        StreamOptions,
        'StreamOptions',
        { buffer: [StreamBufferOptions, 'StreamBufferOptions', object] },
    ];
    sse: [
        SseOptions,
        'SseOptions',
        { reconnect: [ReconnectOptions, 'ReconnectOptions', object] },
    ];
    retry: [
        RetryOptions,
        'RetryOptions',
        { backoff: [BackoffOptions, 'BackoffOptions', object] },
    ];
    input: [InputSchemas, 'InputSchemas', object];
    verdict: [VerdictOptions, 'VerdictOptions', object];
    throttle: [ThrottleOptions, 'ThrottleOptions', object];
    timeout: [TimeoutOptions, 'TimeoutOptions', object];
    circuit: [CircuitOptions, 'CircuitOptions', object];
    idempotency: [IdempotencyOptions, 'IdempotencyOptions', object];
    cache: [
        CacheOptions,
        'CacheOptions',
        {
            fingerprint: [
                CacheFingerprintOptions,
                'CacheFingerprintOptions',
                {
                    transform: [
                        CacheTransformOptions,
                        'CacheTransformOptions',
                        object,
                    ];
                },
            ];
        },
    ];
    hooks: [Hooks, 'Hooks', object];
    paginate: [PaginateOptions, 'PaginateOptions', object];
}
/**
 * One envelope's worth of {@link NoUnknownNestedKeys}: brand the unknown keys of `V` against
 * `Allowed`, then recurse into whichever of `V`'s keys name a child envelope.
 *
 * The array/function arm is what keeps the scalar and positional shorthands legal — `retry: 3`
 * never reaches the object arm, and `circuit: [5, '30s']` is an ARRAY, whose `keyof` is
 * `length`/`push`/… and would otherwise read as 30-odd unknown keys.
 */
type EnvelopeGuard<V, E> = E extends [
    infer Allowed,
    infer What extends string,
    infer Kids,
]
    ? V extends readonly unknown[] | ((...args: never[]) => unknown)
        ? unknown
        : V extends object
          ? ([Exclude<keyof V, keyof Allowed>] extends [never]
                ? unknown
                : {
                      [
                          K in Exclude<keyof V, keyof Allowed>
                      ]: ConfigError<`\`${Extract<K, string>}\` is not a ${What} slot — check the spelling`>;
                  }) & {
                [K in keyof V & keyof Kids]?: EnvelopeGuard<V[K], Kids[K]>;
            }
          : unknown
    : unknown;
/**
 * Compile-time guard: the same rejection {@link NoUnknownKeys} gives a config's TOP-LEVEL keys,
 * one and two layers down, for the house envelopes listed in {@link NestedEnvelopes}.
 *
 * Needed for the same reason and by the same mechanism: `const C` is inferred from the WHOLE config
 * object, so the envelope is no longer a fresh literal by the time it is compared against
 * `AtLeastOne<CircuitOptions>` — excess-property checking is suppressed at every depth, not just at
 * the root. `stitch({ circuit: { failures: 1, cooldown: '30s', totalNonsense: 1 } })` type-checks
 * without this, and so does every call site still authoring a REMOVED nested slot. The gap read as
 * closed for a long time because the type test pinning it carried no valid sibling, so weak-type
 * detection did the rejecting and got the credit — see `unknown-config-keys.test-d.ts`.
 *
 * The key set is `keyof NestedEnvelopes`, NOT `keyof C & keyof NestedEnvelopes`, and that is
 * load-bearing rather than stylistic. Keying it on `C` makes the guard's own SHAPE depend on the
 * type still being inferred, which defers the parameter type past the point where a
 * context-sensitive argument draws its contextual type: the callback slots — `adapter: (req) => …`,
 * `transform: (b) => …` — lose theirs and report TS7006 `implicitly has an 'any' type`. Six sites
 * in the suite caught it. The fixed key set costs one `K extends keyof C` per envelope and keeps
 * inference intact.
 *
 * RESIDUAL LIMITS:
 * - Scoped to the {@link NestedEnvelopes} table, which is explicit BY NECESSITY: `output` holds a
 *   {@link SchemaLike}, and a walk derived from `StitchConfig[K]` reports `safeParse` on a real
 *   `z.object(…)` as a misspelling. Unknown-key rejection is correct only for closed house
 *   vocabularies, never for the pluggable seams. `scripts/check-unknown-keys.mjs` fails the build
 *   when a new house envelope is added without a table entry.
 * - Fail-open through `extends`, exactly as {@link NoUnknownKeys} is: this reads the literal's own
 *   slots, so a fragment's nested keys are the `Layers` axis and not its business.
 * - Fail-open on an already-typed envelope: `circuit: someCircuitOptions` has no unknown keys left
 *   to find, and that binding's declaration site had ordinary excess-property checking.
 */
export type NoUnknownNestedKeys<C> = C extends string
    ? unknown
    : {
          [K in keyof NestedEnvelopes]?: K extends keyof C
              ? EnvelopeGuard<C[K], NestedEnvelopes[K]>
              : unknown;
      };
/**
 * Compile-time guard: {@link WireOptions.multipart} is read ONLY when `wire.body` is
 * `'multipart'`, so pairing it with a `json`/`form` body (or omitting `body`, which defaults to
 * `json`) is silently dead config. Intersecting a config with this makes the nested `multipart`
 * slot unsatisfiable in exactly those cases, turning the dead pairing into a compile error at the
 * authoring site.
 *
 * This is the mutual-exclusion shape CONTRACT.md's R8 allow-list recognises (a pair made exclusive
 * through the type system rather than through nesting), and it is why `wire.body` + `wire.multipart`
 * stay flat WITHIN the envelope rather than splitting into a per-encoding union: the illegal
 * combinations are unrepresentable without it. The three body encodings are not symmetric — `json`
 * has no options at all, and `form` has none of its own, since array serialisation
 * ({@link WireOptions.array}) is shared with the query string — so a three-arm union would carry
 * two empty arms and duplicate a query concern.
 *
 * Reads the COMPOSED config via {@link Layers}, so an enabler inherited through `extends` counts —
 * `stitch({ extends: [{ wire: { body: 'multipart' } }], wire: { multipart: 'dot' } })` is legal.
 *
 * RESIDUAL LIMITS, shared with {@link GraphqlOnlyOnGraphqlSurface}:
 * - Fail-open: the error is surfaced by intersecting onto the config LITERAL, so a violation
 *   living entirely in a fragment — the offending slot in one layer, no enabler in any — is not
 *   reported. The literal-level case, which is the one people write, still errors precisely.
 * - Fail-open: a fragment typed as `Partial<StitchConfig>` rather than inferred from its literal
 *   has optional properties, which satisfy neither probe, so it reads as supplying nothing.
 * - Fail-CLOSED, and inherited from {@link Layers} rather than added here: the flattener
 *   destructures a tuple, so an `extends` list TypeScript widened to `Frag[]` (what a `const`
 *   binding does without `as const`) reads as empty, as does the P7 single-fragment spelling
 *   (`extends: frag`). `InputOf` has read `extends` the same way since #76. Widening it is a
 *   change to call-argument inference for every consumer, not a guard change.
 */
/**
 * Every dot-path contained in `T`, to a bounded depth (ADR 0022 Decision 3 / Q5).
 *
 * The depth cap is not a convenience — it is what keeps this affordable. An uncapped "every path in
 * `T`" union is a known `tsc` blow-up on deep or self-referential response types, and this repo
 * typechecks the docs' twoslash blocks on every run. Four levels covers the realistic envelope
 * (`meta.success`, `result.status.code`); past that the guard yields `string` and stops constraining
 * rather than costing seconds.
 *
 * Arrays are indexed through their ELEMENT (`items.id`, not `items.0.id`) — a flag lives on a
 * record, not at a numeric index — which also stops a tuple from fanning the union out by length.
 */
type PathsIn<
    T,
    Depth extends readonly unknown[] = [],
> = Depth['length'] extends 4
    ? never
    : T extends readonly (infer E)[]
      ? PathsIn<E, [...Depth, unknown]>
      : T extends object
        ? {
              [K in keyof T & string]:
                  K | `${K}.${PathsIn<T[K], [...Depth, unknown]> & string}`;
          }[keyof T & string]
        : never;

/**
 * Compile-time guard: {@link VerdictOptions.flag} is a dot-path into the RESPONSE BODY, and a typo
 * (`meta.succes`) is the realistic failure. It is also silent — the path resolves to `undefined`,
 * which `flag` reads as "no signal", so the flag is inert and every response quietly stops being
 * checked. The `output` schema already describes the response, so the authoring site can catch it.
 *
 * **The rule is containment, not position.** The path must exist SOMEWHERE in the inferred type, not
 * at a fixed place — and that looseness is required for soundness, not convenience, because `output`
 * describes a DIFFERENT value than `flag` indexes:
 *
 * ```
 * interpret (stage 4) → transform → pick (stage 6) → output validation (stage 7)
 *       ▲                                                    ▲
 *    flag reads the RAW body here        output describes the value AFTER both
 * ```
 *
 * With no `transform` and no `pick` the two coincide. With `pick: 'data.items'`, `output` describes
 * a narrow slice and a perfectly valid `flag: 'meta.success'` sits outside it. With `transform` the
 * relationship is an arbitrary function and nothing can be concluded — so the constraint applies
 * only when `output` is a schema and `transform` is absent, and relaxes to `string` otherwise. Same
 * conditional-guard shape as {@link MultipartOnlyOnMultipartBody}.
 *
 * Runtime cannot help here and that is a hard constraint, not an omission: after `compose()` the
 * schemas are opaque Standard Schema validators, and core is zero-dep, so nothing can walk one. This
 * is an authoring-time check only — which is why an inert `flag` still emits an `info` drift finding.
 */
export type FlagPathInOutput<C> = C extends {
    verdict: { flag: infer F };
    output: infer S;
}
    ? C extends { transform: unknown }
        ? unknown // transform makes the relationship arbitrary — nothing can be concluded
        : [PathsIn<InferOutput<S>>] extends [never]
          ? unknown // the schema yielded no walkable shape (an opaque validator) — stay out of the way
          : F extends PathsIn<InferOutput<S>>
            ? unknown
            : {
                  verdict?: {
                      flag?: ConfigError<'`verdict.flag` is a dot-path that does not exist in the `output` type — check for a typo. The path may sit anywhere in the type; it is only constrained when `output` is a schema and `transform` is absent'>;
                  };
              }
    : unknown;

export type MultipartOnlyOnMultipartBody<C> =
    AnyLayer<Layers<C>, { wire: { multipart: unknown } }> extends true
        ? AnyLayer<Layers<C>, { wire: { body: 'multipart' } }> extends true
            ? unknown
            : {
                  wire?: {
                      multipart?: ConfigError<'`wire.multipart` requires `wire.body: "multipart"` — it is ignored on a json or form body'>;
                  };
              }
        : unknown;
/**
 * Compile-time guard: `document` and `operationName` are read ONLY by the graphql surface's
 * `buildRequest` (`surface.ts`), so authoring either without selecting that surface is silently
 * dead config — the document is dropped and a plain request goes out. Intersecting a config with
 * this makes the offending slot unsatisfiable in exactly that case (CONTRACT.md P24 carve-out (b),
 * which requires a flat group to make its dead combinations unrepresentable).
 *
 * Applied to `stitch` / `Seam.stitch` only. `graphql()` and `Seam.graphql()` select the surface
 * themselves and REQUIRE `document`, so the guard would be wrong there.
 *
 * Reads the COMPOSED config via {@link Layers}, so a surface inherited through `extends` counts —
 * `stitch({ extends: [gqlBase], document })` is legal when `gqlBase` supplies `kind`.
 */
export type GraphqlOnlyOnGraphqlSurface<C> =
    AnyLayer<Layers<C>, { document: unknown }> extends true
        ? GraphqlSurfaceSomewhere<C>
        : AnyLayer<Layers<C>, { operationName: unknown }> extends true
          ? GraphqlSurfaceSomewhere<C>
          : unknown;

/** Shared tail of {@link GraphqlOnlyOnGraphqlSurface}: allow iff some layer selects the surface. */
type GraphqlSurfaceSomewhere<C> =
    AnyLayer<Layers<C>, { kind: { id: 'graphql' } }> extends true
        ? unknown
        : {
              document?: ConfigError<'`document` requires the graphql surface — use `graphql({ … })`, or set `kind: graphqlSurface`. It is ignored on every other surface'>;
              operationName?: ConfigError<'`operationName` requires the graphql surface — use `graphql({ … })`, or set `kind: graphqlSurface`. It is ignored on every other surface'>;
          };
/**
 * Compile-time guard: the `graphql` surface OWNS its body encoding. Its `buildRequest` packs
 * `{ query, variables, operationName? }` and sends it as JSON unconditionally (ADR 0005 Decision 1
 * — a surface owns *shaping*), so a {@link WireOptions.body} authored alongside it is never read.
 * Intersecting a graphql config with this makes the nested `wire.body` slot unsatisfiable, turning
 * the dead pairing into a compile error at the authoring site.
 *
 * This also makes {@link WireOptions.multipart} unreachable on graphql without a second guard:
 * {@link MultipartOnlyOnMultipartBody} already requires `wire.body: 'multipart'` before
 * `wire.multipart` is legal, and that spelling is exactly what this rejects. One guard closes both
 * dead pairings — `wire: { multipart }` alone trips the multipart guard, and the `wire.body` that
 * would satisfy it trips this one.
 *
 * `wire.body: 'multipart'` is the interesting arm — a GraphQL file upload is a real thing, but it
 * is NOT "the JSON body, multipart-encoded". It is the separate `operations`/`map`/file-part
 * envelope of the GraphQL multipart request spec, which this surface does not implement. Rejecting
 * the spelling is what keeps that gap honest instead of silently sending a JSON body; supporting
 * uploads later means teaching `graphqlSurface.buildRequest` the envelope and relaxing this guard,
 * which is a non-breaking change.
 *
 * The sibling wire slots stay legal: {@link WireOptions.response} and {@link WireOptions.array}
 * are not body encodings, and graphql fixes only the body.
 *
 * Reads the COMPOSED config via {@link Layers}, like the sibling guards. Applied where the surface
 * is graphql by construction (`graphql()`, `Seam.graphql`), so there is no surface probe here and
 * no polarity concern — see {@link WireBodyFixedByGraphql} for the `stitch({ kind })` path.
 *
 * RESIDUAL LIMITS, shared with {@link MultipartOnlyOnMultipartBody}:
 * - Fail-open: the error is surfaced by intersecting onto the config LITERAL, so a `wire.body`
 *   living entirely in a fragment is not reported. The literal-level case, which is the one people
 *   write, still errors precisely.
 * - Fail-open: a fragment typed as `Partial<StitchConfig>` rather than inferred from its literal
 *   has optional properties, which satisfy no probe, so it reads as supplying nothing.
 * - Fail-CLOSED, inherited from {@link Layers}: an `extends` list widened to `Frag[]` (a `const`
 *   binding without `as const`) reads as empty, as does the P7 single-fragment spelling
 *   (`extends: frag`). Pinned in `graphql-body-encoding.test-d.ts` rather than fixed.
 */
export type NoWireBodyOnGraphql<C> =
    AnyLayer<Layers<C>, { wire: { body: unknown } }> extends true
        ? {
              wire?: {
                  body?: ConfigError<'the `graphql` surface always sends a JSON `{ query, variables }` body — `wire.body` is ignored (GraphQL file uploads need the multipart request spec, which this surface does not implement)'>;
              };
          }
        : unknown;
/**
 * {@link NoWireBodyOnGraphql}, applied where graphql is only one possible `kind` — the generic
 * `stitch({ kind: graphqlSurface, … })` path. Keys off the surface's literal `id`, which is why
 * `graphqlSurface` is declared with `id: 'graphql'` rather than the widened `string` of `Surface`.
 *
 * Reads the COMPOSED config via {@link Layers}, so a surface inherited through `extends` counts —
 * `stitch({ extends: [gqlBase], wire: { body: 'form' } })` is rejected when `gqlBase` supplies
 * `kind`. Reading the literal alone missed exactly that case.
 *
 * POLARITY NOTE — this guard's surface probe is an INHIBITOR, not an enabler, so the existential
 * scan lands on the opposite side of {@link AnyLayer}'s bias from the sibling guards. For
 * `MultipartOnlyOnMultipartBody` and `GraphqlOnlyOnGraphqlSurface`, finding the surface/enabler on
 * some layer makes a config LEGAL, so an existential scan can only fail open. Here, finding it
 * makes a config ILLEGAL, so the same scan can fail CLOSED: a config that inherits graphql and then
 * overrides `kind` back to a non-graphql surface
 * (`stitch({ extends: [gqlBase], kind: httpSurface, wire: { body: 'form' } })`) has a live
 * `wire.body` and is nonetheless rejected. Accepted rather than resolved: distinguishing it needs
 * last-wins resolution of `kind`, which is the complexity {@link AnyLayer} exists to avoid, and the
 * config it costs — inherit a GraphQL base, then make it not GraphQL — is a perverse one with an
 * obvious workaround (drop `extends`, or set the encoding on the layer that owns the surface).
 * Pinned in `graphql-body-encoding.test-d.ts` so the tradeoff is visible rather than latent.
 */
export type WireBodyFixedByGraphql<C> =
    AnyLayer<Layers<C>, { kind: { id: 'graphql' } }> extends true
        ? NoWireBodyOnGraphql<C>
        : unknown;

/**
 * Compile-time guard: the `download` surface OWNS the request shape its result depends on. Its
 * `buildRequest` forces `method: 'GET'` and a blob response unconditionally (ADR 0005 Decision 1 —
 * a surface owns *shaping*), so either field authored alongside it is never read. Intersecting a
 * download config with this makes the offending slot unsatisfiable, turning the dead pairing into a
 * compile error at the authoring site.
 *
 * The two halves sit at different depths because the fields do: `method` is still a flat
 * {@link StitchConfig} slot, while the response decoding moved into the `wire` envelope as
 * {@link WireOptions.response}. The guard mirrors the authoring shape, so the nested arm rejects
 * `wire.response` without collapsing the rest of `wire` — `wire.array` and `wire.multipart` are
 * untouched and stay authorable on a download stitch.
 *
 * Both fields are load-bearing for what `download` promises, which is why neither is a knob:
 * `wire.response: 'blob'` is what makes the buffered body a `Blob` at all — the surface's
 * `interpret` casts `res.body` to one and hands back `{ blob, filename }`, so any other response
 * type would make that cast a lie. The `GET` is the weaker of the two (a POST-then-download is a
 * real pattern), but honouring `method` alone would still leave the surface's own name for it —
 * `download` — describing only half the request. Either way the escape hatch is the same and costs
 * one line: a plain `stitch()` with `wire: { response: 'blob' }`, which gives up only the
 * `Content-Disposition` filename parsing. Relaxing `method` later is non-breaking.
 *
 * Only the AUTHORING slot moves under `wire`. `downloadSurface.buildRequest` still returns a flat
 * `responseType: 'blob'` on its `AdapterRequest`, which is the transport contract and is unchanged
 * (P22 — the XHR spelling belongs to the layer that meets XHR).
 *
 * Reads the COMPOSED config via {@link Layers}, so a `method` or `wire.response` inherited through
 * `extends` is seen. {@link AnyLayer} takes each depth's shape as-is, which is why the flat and
 * nested probes read the same way despite sitting at different depths. Residual limits are shared
 * with {@link MultipartOnlyOnMultipartBody} and documented there.
 */
export type NoRequestShapeOnDownload<C> = (AnyLayer<
    Layers<C>,
    { method: unknown }
> extends true
    ? {
          method?: ConfigError<'the `download` surface always issues a GET — `method` is ignored (for a POST that returns a file, use a plain `stitch()` with `wire: { response: "blob" }`)'>;
      }
    : unknown) &
    (AnyLayer<Layers<C>, { wire: { response: unknown } }> extends true
        ? {
              wire?: {
                  response?: ConfigError<'the `download` surface always reads the body as a Blob — `wire.response` is ignored (it is what makes the result `{ blob, filename }`; use a plain `stitch()` to choose another response type)'>;
              };
          }
        : unknown);
/**
 * {@link NoRequestShapeOnDownload}, applied where download is only one possible `kind` — the generic
 * `stitch({ kind: downloadSurface, … })` path. Keys off the surface's literal `id`, which is why
 * `downloadSurface` is declared with `id: 'download'` rather than the widened `string` of `Surface`.
 *
 * Reads the COMPOSED config, so `stitch({ extends: [dlBase], method: 'POST' })` is rejected when
 * `dlBase` supplies `kind: downloadSurface` — the surface is found through the fragment.
 */
export type RequestShapeFixedByDownload<C> =
    AnyLayer<Layers<C>, { kind: { id: 'download' } }> extends true
        ? NoRequestShapeOnDownload<C>
        : unknown;
/**
 * Compile-time guard: the `download()` PRESET selects the surface itself — both authoring paths
 * build their config as `{ ...config, kind: downloadSurface }`, spreading the caller's `kind` in and
 * overwriting it on the next line. A `kind` authored on the preset is therefore never read: the
 * stitch is a download either way, and a caller who wrote `kind: graphqlSurface` silently got a
 * download. Same class as {@link NoRequestShapeOnDownload} (`method`, `wire.response`) and
 * {@link NoBodyTypeOnGraphql} (`wire.body`) — a field the surface claims, rejected at the authoring
 * site rather than ignored at runtime.
 *
 * DELIBERATELY SEPARATE from {@link NoRequestShapeOnDownload} rather than a third arm of it, and the
 * split is load-bearing. That type is shared with {@link RequestShapeFixedByDownload}, which guards
 * the generic `stitch({ kind: downloadSurface, … })` path — and on THAT path `kind` is not dead
 * config, it is the very thing selecting the surface. Folding this in would make the guard reject
 * the config that triggers it, so the two must not share a type.
 *
 * Applied ONLY where the preset fixes the surface by construction: `download()` / `download.stitch`
 * and `DownloadSeamApi['stitch']` (which `bindSeam`'s member is cast to, so it inherits this). The
 * probe is `{ kind: unknown }`, not keyed to a surface id, so even the redundant
 * `kind: downloadSurface` is rejected — the same reasoning that makes `method: 'GET'` an error on a
 * surface that sends exactly that. Authoring the slot implies it is read; it is not.
 *
 * The asymmetry with `llm` is a difference in parameter shape, not intent. `LlmOptions` (llm.ts)
 * closes the identical hole structurally — `Partial<Omit<StitchConfig, 'kind'>>` — and that works
 * because `llm()`'s parameter is deliberately NON-generic, so excess-property checking on the object
 * literal turns a stray `kind` into an error. This preset captures a `const C` to infer its
 * call-argument type from `config.input` (`InputOf<C>`), and a generic CONSTRAINT does not do
 * excess-property checking — `Omit` would simply be satisfied by a config carrying extra keys. Hence
 * a `ConfigError` guard here and a structural `Omit` there, for one rule.
 *
 * Reads the COMPOSED config via {@link Layers}, like every other guard here. The fail direction is
 * INVERTED relative to {@link GraphqlOnlyOnGraphqlSurface}: `kind` is the OFFENDING slot here, not
 * the enabler, so a layer the flattener cannot see (an `extends` widened to `Frag[]`, the P7
 * single-fragment spelling) merely fails to reject dead config rather than rejecting valid code —
 * fail-OPEN, the direction #597 biases toward. Residual limits are otherwise shared with
 * {@link MultipartOnlyOnMultipartBody} and documented there.
 */
export type NoKindOnDownload<C> =
    AnyLayer<Layers<C>, { kind: unknown }> extends true
        ? {
              kind?: ConfigError<'the `download` preset always selects the download surface — `kind` is ignored (use a plain `stitch({ kind })` to choose another surface)'>;
          }
        : unknown;
/**
 * Compile-time guard: the `llm` surface OWNS how it frames a chat completion. The live surface's
 * `buildRequest` forces `method: 'POST'` and a JSON body unconditionally and replaces the body with
 * `provider.buildBody(...)`, so either field authored on an `llm()` config is never read. Same
 * class as {@link NoWireBodyOnGraphql} (`wire.body`) and {@link NoRequestShapeOnDownload}
 * (`method`) — this surface simply fixes one of each.
 *
 * As on graphql, this makes {@link WireOptions.multipart} unreachable for free:
 * {@link MultipartOnlyOnMultipartBody} requires `wire.body: 'multipart'` first, and that spelling
 * is exactly what this rejects. {@link WireOptions.response} is deliberately NOT guarded —
 * `buildRequest` leaves it alone, so it still reaches the adapter and is a live knob here. That is
 * also why the `wire` arm names `body` alone rather than replacing the envelope: the other three
 * members stay authorable.
 *
 * There is no `…FixedByLlm<C>` sibling keyed off `kind`, and that asymmetry is deliberate: the
 * exported `llmSurface` is only the redaction/inspection IDENTITY (ADR 0005 Decision 11) and carries
 * no `buildRequest`. A `stitch({ kind: llmSurface, method: 'PUT' })` therefore keeps its `PUT` — the
 * field is live on that path, and guarding it off the `id` would reject config that is honoured. The
 * overriding surface is built per stitch by `makeLlmSurface`, reachable only through `llm()` /
 * `llm.bind(seam).stitch`, which is exactly where this guard is applied.
 *
 * Unlike its graphql/download siblings this is a plain object type, not a conditional over `C`, and
 * that difference is load-bearing rather than cosmetic. Those two guard authoring helpers that
 * capture a `const C` to infer the call-argument type from `config.input` (`InputOf<C>`), so the
 * guard has to be conditional to stay a no-op on the configs it does not touch. `llm()` infers
 * nothing — it returns a flat `Stitch<LlmResult>` — so its parameter can stay NON-generic, and
 * keeping it that way is what preserves excess-property checking on the object literal. That check
 * is load-bearing here: it is what makes the removed `maxTokens` spelling a compile error (P4,
 * pinned by a test in llm.spec.ts). Making the parameter generic to fit the conditional idiom would
 * have silently traded that guarantee away for this one.
 *
 * Only the AUTHORING slot moves under `wire`. `makeLlmSurface`'s `buildRequest` still sets a flat
 * `bodyType: 'json'` on its `AdapterRequest`, which is the transport contract and is unchanged.
 *
 * NOT converted to the {@link AnyLayer}/{@link Layers} composed read its siblings use, and there is
 * nothing here to convert: those guards are conditionals over a captured `C`, and the layer walk is
 * what lets them ask "is this slot set ANYWHERE in the chain?". This one has no `C` — the parameter
 * is non-generic, for the excess-property reason above — so it intersects UNCONDITIONALLY and
 * rejects the literal slot every time, which is strictly stronger than a conditional at the literal
 * level. What it cannot do is see a violation living entirely inside an `extends` fragment
 * (`llm({ provider, extends: [{ wire: { body: 'form' } }] })` compiles). That is the SAME fail-open
 * the composed guards document as their first residual limit — the literal-level case, which is
 * the one people write, errors precisely — so converting would buy nothing and cost the
 * `maxTokens` guarantee. Pinned as a tsd expectation so it stays a decision on record.
 */
export interface NoRequestShapeOnLlm {
    method?: ConfigError<'the `llm` surface always POSTs to the provider — `method` is ignored'>;
    wire?: {
        body?: ConfigError<'the `llm` surface always sends a JSON body built by the provider — `wire.body` is ignored'>;
    };
}
/**
/**
 * How the `stream` surface decodes each chunk of a live response body (ADR 0005 Decision 5).
 * - `'bytes'` (default) — raw `Uint8Array` chunks, lossless, no encoding assumed.
 * - `'lines'` — UTF-8, split on `\n`; each `delta` chunk is a `string`.
 * - `'ndjson'` — `'lines'` + `JSON.parse` per non-blank line; each chunk a parsed value.
 * - `'json'` — a STRUCTURAL streaming-JSON decoder (issue #111): emits each complete JSON value
 *   (and each top-level array element) as its own `delta`, tolerant of pretty-printed records with
 *   internal newlines and of concatenated values with no separator. Distinct from `'ndjson'`
 *   (newline-FRAMED): `'json'` is unframed and follows JSON structure (nesting/strings/escapes).
 */
export type StreamDecode = 'bytes' | 'lines' | 'ndjson' | 'json';
export interface StreamOptions {
    /** Decoder for a `stream` surface body. Default `'bytes'` (total + lossless). */
    decode?: StreamDecode;
    /**
     * How the decoder's working buffer is bounded — {@link StreamBufferOptions}, or its dominant
     * field's scalar (CONTRACT.md P12): `buffer: 4_000_000` ≡ `buffer: { chars: 4_000_000 }`.
     * The same envelope word as `@stitchapi/shell`'s `buffer` slot (P16) — there the buffered
     * thing is subprocess bytes, so its ceiling is `max` (a size); here it is DECODED TEXT, so the
     * ceiling is `chars` (a count) and no byte token is accepted (P25: a chars cap never reads a
     * `'1mb'`-style size).
     */
    buffer?: number | AtLeastOne<StreamBufferOptions>;
}
/**
 * Bounds on what a streaming decoder may buffer. An envelope rather than a bare cap key so the
 * next buffering control (an overflow policy, say) lands inside it instead of adding a top-level
 * word (P21) — the same reasoning as `@stitchapi/shell`'s `ShellBufferOptions`.
 */
export interface StreamBufferOptions {
    /**
     * Max characters buffered for a single un-terminated unit before throwing (the engine turns
     * the throw into an `error` event). Counts characters of the DECODED text — UTF-16 code
     * units, so an astral character costs 2 — not bytes off the socket. Guards every un-framed /
     * never-closing case against growing client memory without limit (an OOM DoS):
     *   - `'json'` — a single in-progress value (e.g. an unclosed `[`).
     *   - `'lines'` / `'ndjson'` — a single un-terminated line (a run of text with no `\n`).
     *   - the `sse` surface — one un-dispatched event's `data:` payload (a frame with no blank line).
     * Default ~8M characters (see `json-stream.ts`). Not meaningful for `decode: 'bytes'` (raw,
     * unbuffered).
     */
    chars?: number;
}
/**
 * Tuning for resumable SSE reconnection (issue #71). When enabled, the engine reopens a dropped
 * `text/event-stream` body and replays the last seen `id:` as the `Last-Event-ID` request header so
 * the stream continues from where it broke. Plain data only — no functions — so it round-trips as
 * JSON (the contract-not-dependency gate). Only meaningful for the `sse` surface.
 */
export interface ReconnectOptions {
    /**
     * Total reconnect attempts after the first connection drops, before the stream gives up and
     * ends/errors exactly as today. Default 3. A ceiling, not a quota: a stream that finishes
     * cleanly, or that has no `id:` to resume from, spends none of it.
     */
    attempts?: number;
    /**
     * Fallback reconnect delay when the server has NOT sent a `retry:` field on the dropped
     * connection — `1000`, `'1s'`. When omitted, the stitch's `retry.backoff` supplies it. A
     * server-sent `retry:` on the connection always wins over both.
     *
     * Named `delay`, not `backoff`: this is a flat duration, while `retry.backoff` is a curve
     * policy. One token, one value-space (P1/P2).
     */
    delay?: number | string;
}
/**
 * Resumable SSE (issue #71) — how the `sse` surface recovers from a dropped stream. **Off by
 * default**: with no `sse.reconnect` block the engine opens the body exactly once (today's
 * behaviour, byte-identical). When enabled the engine tracks the last `id:` seen and replays it as
 * `Last-Event-ID` on each reconnect, honours a server-sent `retry:` as the backoff (falling back to
 * `reconnect.delay` / the stitch's `retry` policy), and caps reconnects at `attempts`.
 *
 * `true` = enabled with sane defaults; the object form tunes the cap / fallback backoff (the opaque
 * `{}` is rejected — CONTRACT.md P20). Plain JSON (the contract gate). Only the `sse` surface acts
 * on this; other surfaces ignore it.
 *
 * It reopens a **dropped** body only, and only one it can resume: a stream that ran out cleanly has
 * finished, and a stream whose frames carry no `id:` has no resume point, so neither is reopened
 * (issue #640). That matters for OpenAI-shaped completions — `data: {…}` frames with no `id:`,
 * terminated by `[DONE]` — where a reopened request could only ask for the whole completion again.
 * Turning this on for such a feed is a no-op, not a replay.
 */
export interface SseOptions {
    /**
     * Reopen a dropped `text/event-stream` body and resume from the last seen `id:`. `true` enables
     * it with defaults; the object form tunes the attempt cap and fallback delay (the opaque `{}` is
     * rejected — P20). Omitted means off: the engine opens the body exactly once.
     *
     * Needs a server that emits `id:` and honours `Last-Event-ID`; without one there is nothing to
     * resume from and the body is never reopened. A body that ends cleanly is never reopened either.
     */
    reconnect?: boolean | AtLeastOne<ReconnectOptions>;
}
/**
 * Byte-transfer progress for a single request (ADR 0005 Decision 9). Reported through
 * {@link AdapterRequest.onProgress}, tagged by direction: `'upload'` as the request body is
 * sent, `'download'` as the response body arrives. `total` is the content length when known.
 */
export interface AdapterProgress {
    /**
     * Which phase this tick reports: `'upload'` as the request body is sent, `'download'` as the
     * response body arrives. Not every adapter reports both — see the transport guides.
     */
    direction: 'upload' | 'download';
    /** Bytes transferred so far in this direction. */
    loaded: number;
    /** Total bytes, when the content length is known. Absent for a chunked or unknown-length body. */
    total?: number;
}
export interface AdapterRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
    bodyType?: 'json' | 'form' | 'multipart';
    /** Multipart serialisation options (nesting); only read when `bodyType: 'multipart'`. */
    multipart?: MultipartOptions;
    /**
     * Array serialisation for the urlencoded body; only read when `bodyType: 'form'` (the query
     * string is already serialised into `url` by the time a request reaches the transport).
     * Defaults to `'indices'` — the same default the query string uses, so one authored
     * {@link WireOptions.array} means one thing on both urlencoded surfaces.
     */
    arrayFormat?: ArrayFormat;
    responseType?: ResponseType;
    /**
     * Ask the transport NOT to buffer/parse the response — hand back the live body instead
     * (ADR 0005 Decision 9 / Q1). When set, {@link AdapterResponse.body} is a
     * `ReadableStream<Uint8Array>`. Only `fetch` honours it; buffered-only adapters (axios, xhr)
     * reject the request.
     */
    stream?: boolean;
    /**
     * Byte-progress callback (ADR 0005 Decision 9). Fires with `direction: 'download'` as the
     * response is read, and `direction: 'upload'` as the request body is sent (upload progress needs
     * `xhrAdapter` — `fetch` cannot report it). Orthogonal to {@link AdapterRequest.stream}.
     */
    onProgress?: (progress: AdapterProgress) => void;
    signal?: AbortSignal;
}
export interface AdapterResponse {
    status: number;
    headers: Record<string, string>;
    // Parsed JSON when possible, else text — OR a `ReadableStream<Uint8Array>` when `stream` was set.
    body: unknown;
    /**
     * The final response URL (after redirects), when the transport exposes it (`fetchAdapter` sets
     * it from `response.url`). The `download` surface uses it for the filename fallback (ADR 0005
     * Decision 8); other readers may ignore it.
     */
    url?: string;
}
/**
 * An optional transport feature an adapter can declare it supports:
 *
 * -   `'stream'` — honours {@link AdapterRequest.stream}, handing back a live `ReadableStream`
 *     instead of rejecting it. `fetch` only among the built-ins (`xhr`/axios buffer and reject it).
 * -   `'uploadProgress'` — reports `direction: 'upload'` byte progress through
 *     {@link AdapterRequest.onProgress}. `xhr` and axios can; `fetch` cannot (it leaves the upload
 *     phase silent).
 * -   `'downloadProgress'` — reports `direction: 'download'` byte progress through
 *     {@link AdapterRequest.onProgress} as the response arrives. `fetch`, `xhr`, and axios all can.
 */
export type AdapterCapability =
    'stream' | 'uploadProgress' | 'downloadProgress';
/**
 * What a transport supports, declared on the adapter itself (ADR 0005 Decision 9). An adapter is
 * still just a function — this is an OPTIONAL hint hung off it. A descriptor lists the features the
 * transport HAS in `supports`; anything not listed, it can't do. Built-in adapters declare one so
 * the engine can turn a silent no-op into a teaching note: a call that asks for `direction: 'upload'`
 * progress on a transport whose `supports` omits `'uploadProgress'` (`fetch`, axios) gets an `info`
 * event pointing at `xhrAdapter`, instead of an upload bar that never moves. A custom adapter that
 * declares nothing is treated as unknown — no checks, the open contract stands.
 *
 * Diagnostics only; never part of `__config`, never serialised.
 */
export interface AdapterCapabilities {
    /** Human label for diagnostics, e.g. `'fetchAdapter'`. */
    name?: string;
    /** The optional features this transport supports. Anything NOT listed, it cannot do. */
    supports: AdapterCapability[];
}
/**
 * A transport: take a request, return a response, never throw on a non-2xx (ADR 0005). The optional
 * {@link AdapterCapabilities} is hung off the function so a plain `(req) => Promise<res>` still
 * satisfies the type — declaring capabilities is opt-in.
 */
export type Adapter = ((req: AdapterRequest) => Promise<AdapterResponse>) & {
    capabilities?: AdapterCapabilities;
};

// ---- Resilience options ---------------------------------------------------
/**
 * A status-match field (CONTRACT.md P7): a single status, a list, or a predicate. Every reader
 * normalizes through the shared `acceptsStatus` matcher, so the three spellings are equivalent
 * (`on: 429` ≡ `on: [429]`).
 */
export type StatusMatch = number | number[] | ((status: number) => boolean);
/** The delay curve a backoff walks. The dominant field of {@link BackoffOptions} (P12). */
export type BackoffCurve = 'expo' | 'expo-jitter' | 'fixed';
/**
 * How the wait between attempts grows (CONTRACT.md P24). The curve and the two bounds
 * that shape it are one concept, so they are one envelope rather than three sibling
 * fields sharing a `Delay` suffix. Inside it `base` and `max` need no suffix — there is
 * only one thing here to measure (P1), and `max` bounds a **magnitude**, which is the
 * case P4 leaves it.
 */
export interface BackoffOptions {
    /** Delay curve. Default `'expo-jitter'`. */
    curve?: BackoffCurve;
    /** Delay before the first retry — `100`, `'100ms'`, `'1s'`. Default 100ms. */
    base?: number | string;
    /** Ceiling the computed delay is clamped to — `10_000`, `'10s'`. Default 10s. */
    max?: number | string;
}
export interface RetryOptions {
    /**
     * **Total** attempts including the first call, so `attempts: 3` means up to two retries.
     * Default `1`, which disables retry.
     */
    attempts?: number;
    /**
     * Status(es) — or a predicate `(status) => boolean` — that trigger a retry. A bare number is
     * shorthand for a one-element list (`on: 429` ≡ `on: [429]`). Default `[429, 502, 503, 504]`,
     * the usual transient set.
     */
    on?: StatusMatch;
    /**
     * Backoff policy. A bare curve is the P12 shorthand for `{ curve }`
     * (`backoff: 'fixed'` ≡ `backoff: { curve: 'fixed' }`); the envelope adds `base`/`max`.
     */
    backoff?: BackoffCurve | AtLeastOne<BackoffOptions>;
    /**
     * Respect a `Retry-After` header on the failing response — delta-seconds OR an HTTP-date —
     * using the server's stated wait in place of the computed `backoff`. **Default `true`**: the
     * default `on` set (`[429, 502, 503, 504]`) is the statuses RFC 9110 defines the header for, so
     * ignoring it means guessing at a number the server already told us. Set `false` to force the
     * computed curve regardless.
     *
     * There is deliberately NO ceiling on the honored wait — `timeout.total` already bounds every
     * sleep in the attempt loop (one patience budget, not two), and the wait aborts with the
     * request signal. A stitch with no `timeout.total` waits as long as the server asks.
     */
    respect?: boolean;
}
export interface ThrottleOptions {
    /**
     * Target pace as a `"count/interval"` string — `'2/s'`, `'1000/h'`, `'100/15m'`, `'2/500ms'`.
     * A minimum spacing between successive calls (`interval / count`, applied before any request
     * leaves), not a token bucket. The dominant field: a bare string is the P12 shorthand for
     * `{ rate }` (`throttle: '2/s'` ≡ `throttle: { rate: '2/s' }`). The grammar is
     * `<count>/<duration>` with a POSITIVE INTEGER count and any {@link parseDuration} token for
     * the denominator, where a bare unit means one of that unit (`'2/s'` ≡ `'2/1s'`) — read by
     * the shared {@link parseRate}.
     *
     * Because it paces rather than buckets, the only thing it reads is the **ratio**: `'2/500ms'`,
     * `'4/s'` and `'240/m'` all declare a 250ms gap and are the same limiter, in-process and
     * store-backed alike. Window length is a way of spelling the ratio, not a burst allowance —
     * there is no capacity for a longer window to grant. Where a real quota needs spending the
     * way the vendor accounts for it, hand the backoff to an outer gate with `delegate`.
     *
     * A **string and only a string**, deliberately. A duration or a byte cap also accepts a bare
     * number because each is a magnitude over a house unit — ms, bytes — so `5_000` and `4096`
     * already denote something (CONTRACT.md P17/P25). A rate is two quantities, so a bare `2`
     * would have to invent a default window to mean anything, and that invisible default is what
     * P15/P20 exist to reject. `'2/s'` is not the sugar form of a number here; it IS the value.
     *
     * An unparseable token **throws** at construction rather than falling back to "no limit" —
     * the one place a house parser fails loud, for the reason spelled out on {@link parseRate}.
     * That covers both degenerate ends of the range too, since each would also mean no limit: a
     * zero count, and a spacing past the ~24.8-day timer ceiling.
     */
    rate?: string;
    /**
     * Cap on simultaneous in-flight calls. Independent of `rate` — either may be set on its own.
     *
     * Per-process by default. It becomes **fleet-wide** when the `store` implements the lease
     * verbs (ADR 0025) — `memoryStore`, `@stitchapi/redis`, `@stitchapi/deno-kv` — with no config
     * change: `concurrency: 10` then means ten in flight across every worker on that store, not
     * ten each. See {@link ThrottleOptions.lease} for the one knob that comes with it.
     */
    concurrency?: number;
    /**
     * How long a fleet-wide concurrency slot is held before it lapses — `30_000`, `'30s'`.
     * Default 30s. Only read when `concurrency` is set AND the store leases (ADR 0025); ignored
     * by the per-process limiter, which needs no expiry because a process that dies takes its
     * own bookkeeping with it.
     *
     * **Size it above your slowest call, and think of it as a crash timer, not a call timer.** A
     * holder that crashes or partitions never gives its slot back, so the lease lapsing is what
     * returns it — set it too long and a dead worker's slots stay stranded that long. Set it too
     * SHORT and the opposite failure appears, which is the one that actually hurts: a call still
     * running at `lease` has already lost its slot to the next caller, so the fleet briefly runs
     * over `concurrency`. Streaming never holds a slot at all (ADR 0005 Decision 12), so the
     * calls this bounds are the buffered ones, which `timeout` already bounds — a `lease`
     * comfortably above `timeout.total` cannot be outlived.
     */
    lease?: number | string;
    /**
     * Where the limiter's counter is pooled: `'stitch'` (default) keeps a per-stitch
     * budget; `'host'` shares one budget across every stitch hitting the same host.
     */
    pool?: 'stitch' | 'host';
    /**
     * Delegate rate-limit handling to the host (CONTRACT.md P14). When `true`, a rate-limit
     * response (status matched by `on`, default `[429]`) is **not** retried or throttled
     * internally — self-pacing (`rate`/`concurrency`) is bypassed and the outcome surfaces as a
     * {@link RateLimitError}. Use it when an OUTER gate owns the backoff.
     */
    delegate?: boolean;
    /** Status(es) that count as a rate-limit signal under `delegate` — a number, list, or predicate. Default `[429]`. */
    on?: StatusMatch;
}
/**
 * Options for one throttle `acquire`. `rateOnly` charges the rate limiter but takes NO concurrency
 * slot — for streaming surfaces (`sse`/`stream`), whose long-lived connection must not pin a slot
 * (ADR 0005 Decision 12). A rate-only acquire is NOT paired with a `release` (nothing was held).
 */
export interface AcquireOptions {
    rateOnly?: boolean;
}
export interface TimeoutOptions {
    /**
     * Bounds the **entire call** across every retry, including the backoff waits between them —
     * `10_000`, `'10s'`. The dominant field: a bare number or duration string is the P12 shorthand
     * for `{ total }` (`timeout: '5s'` ≡ `timeout: { total: '5s' }`).
     */
    total?: number | string;
    /**
     * Bounds each individual attempt — `3000`, `'3s'`. With `retry` enabled this alone does NOT cap
     * the call: N attempts plus their backoff waits can overrun it many times over. Pair it with
     * `total` for a real deadline.
     *
     * Named for the scope it bounds, not the thing it counts: `timeout` already names the subject,
     * so the member carries only the scope (P24/P25), and P4 reserves `attempt`/`attempts` for the
     * current index and the running count.
     */
    each?: number | string;
}
export interface CircuitOptions {
    /**
     * Consecutive failures that trip the breaker OPEN. Required by design — a breaker with an
     * invisible threshold fails silently (CONTRACT.md P15); `createCircuit` throws when `failures`
     * or `cooldown` is missing. Optional at the type level only so the object form can be built up
     * incrementally; the positional `[failures, cooldown]` shorthand supplies both.
     */
    failures?: number;
    /**
     * Fast-fail window after opening — `30_000`, `'30s'`. When it elapses the breaker goes
     * half-open and admits one trial call, so this is the **single** open→half-open boundary:
     * fast-fail and probe cannot run on different clocks, because a call is either rejected or
     * admitted (CONTRACT.md P1). Required by design (P15); `createCircuit` throws when missing.
     */
    cooldown?: number | string;
    /** Store namespace to share a breaker across stitches (default: stitch/host key). */
    key?: string;
}
/**
 * Inject an idempotency token on writes so a server can collapse a duplicate. The default key is a
 * random uuid minted **once per logical call** and reused across that call's retries — it makes a
 * {@link RetryOptions | retry} safe to attempt. Because the random key only dedupes a replay of the
 * *same* request, it pairs with `retry` (the retry is the duplicate it absorbs); declaring it on a
 * write with **no** `retry` logs a one-time construction nudge, since it usually has nothing to
 * collapse. It isn't strictly useless without one — a proxy or the transport resending the request
 * below the stitch carries the same key for a server to dedupe — so the nudge has an out: set
 * `warn: false` to silence it.
 *
 * To collapse two *separate* submissions of the same write — a double-clicked button — give `keyOf`
 * and derive the token from something the duplicates share. A derived key dedupes submissions
 * server-side without any retry, so it stands on its own (and is never nudged).
 *
 * `header` renames the idempotency key — the value the server *dedupes* on. It is not a place to
 * set a correlation/trace header like `traceparent` or `X-Request-Id`; those identify a request
 * for logs and spans and belong to tracing, not dedupe.
 *
 * The key is sent on **writes only**; setting `idempotency` on a read (GET/HEAD) drops it and logs
 * a construction nudge — almost always a missing `method: 'POST'`. Both nudges fire only on the
 * default HTTP surface and are silenced by `warn: false`.
 */
export interface IdempotencyOptions {
    /**
     * Header name the key rides on. Default `'Idempotency-Key'`; set it when a server expects a
     * vendor spelling (e.g. `'X-Idempotency-Key'`).
     */
    header?: string;
    /** Derive a stable key per logical call (default: a random uuid). CONTRACT.md P6: `key` is a string; a derivation fn is `keyOf`. */
    keyOf?: (input: StitchInput) => string;
    /** false silences the "idempotency without retry" / "idempotency on a read" construction nudge. */
    warn?: boolean;
}

// ---- Cache (ADR 0003) -----------------------------------------------------
/**
 * The cache's stance on a `transform` (ADR 0004 rung 2) — one envelope for the two ways to clear
 * the transform gate, because a `transform` is a closure core cannot soundly hash: by default a
 * stitch that has one refuses to cache, since re-validation cannot detect a transform change (a
 * stale value still satisfies an unchanged schema).
 *
 * The version tag lives here rather than beside the closure it versions because it must round-trip
 * as JSON (CONTRACT.md P0) while `transform` itself is function sugar on `__rawConfig`.
 *
 * `version` is the strong form and **wins when both are set** — once the tag is sound, `trust`
 * has nothing left to relax.
 */
export interface CacheTransformOptions {
    /**
     * Version tag for the transform — the sound form. It folds into the fingerprint, so bumping it
     * whenever the transform's behaviour changes moves the cache generation and makes every entry
     * written by the old transform unreachable.
     */
    version?: string | number;
    /**
     * Cache despite an un-versioned transform, trusting its output is stable for the `ttl`. Weaker
     * than {@link CacheTransformOptions.version} — a transform change is invisible, bounded only by
     * TTL — so prefer naming a version whenever you can.
     */
    trust?: boolean;
}

/**
 * How the cache detects that a stored value has gone stale against its contract — the whole of
 * [ADR 0004](../../../docs/adr/0004-standard-schema-fingerprint-for-cache-invalidation.md)'s
 * fallback ladder in one envelope. Every member is a rung of that ladder, so the name is
 * exhaustive over its contents the way `wire`'s is (CONTRACT.md P24/P25); `ttl`, `tenancy`,
 * `vary`, `methods` and the rest of {@link CacheOptions} answer a different question — what the
 * key is and how long an entry lives — and stay outside.
 *
 * Nothing here is required: with no `fingerprint` block a registered `@stitchapi/fingerprint-*`
 * strategy makes `output` changes self-invalidate, and an un-fingerprintable schema refuses to
 * cache (fail closed). The members are the three ways to override that.
 */
export interface CacheFingerprintOptions {
    /**
     * Opaque schema/version tag — the **authoritative** rung: setting it pins the contract and
     * takes the **no-revalidate** fast path (you promise `output`/`transform`/`pick` are unchanged
     * for this tag). A bare `string | number` at the slot is the P12 shorthand for this field.
     */
    version?: string | number;
    /**
     * What the cache knows about an opaque `transform` (rung 2). A `transform` is a closure that
     * cannot be soundly hashed, so a stitch carrying one **refuses to cache** until one of
     * {@link CacheTransformOptions}' two declarations clears the gate. A bare `string | number` is
     * the P12 shorthand for the dominant field — `transform: 3` ≡ `transform: { version: 3 }`.
     */
    transform?: string | number | AtLeastOne<CacheTransformOptions>;
    /**
     * Where the ladder lands when an `output` schema is present but cannot be soundly fingerprinted
     * (no `@stitchapi/fingerprint-*` registered for its vendor, a non-Standard-Schema validator, or
     * the strategy abstained). `'refuse'` (default, **fail-closed**) does not cache — and nudges you
     * to register the vendor package or set `version`. `'revalidate'` caches but **re-validates the
     * stored value on every hit** against the current schema (saves the network, still safe; sound
     * only for pure validators with no coercion/transform inside the schema).
     */
    fallback?: 'refuse' | 'revalidate';
}

/**
 * Transport-level response cache + in-process request coalescing (ADR 0003). The key is
 * **derived** from the resolved request — no caller-authored keys — so it cannot drift from
 * what it names. Off by default: no `cache` block ⇒ no caching and no hot-path cost. The engine
 * ships behind its own `stitchapi/cache` subpath, so `import { stitch }` pulls none of it.
 *
 * Every field round-trips as JSON; `keyOf` is **sugar** (a function override) that does not — it
 * lives on the non-enumerable `__rawConfig` only (CONTRACT.md P0).
 */
export interface CacheOptions {
    /** Time-to-live for a cached entry — `30_000`, `'30s'`, `'5m'`. Bounds staleness/drift. */
    ttl: number | string;
    /**
     * Whose responses an entry may be served to. `'principal'` (default, **fail-closed**) folds
     * the bound principal into the key so user A can never be served user B's cached response;
     * `'app'` shares one entry across callers — correct only for public, unauthenticated data.
     *
     * Spelled `tenancy`, matching `OAuth2Options.tenancy` / `CookieSessionOptions.tenancy` — the
     * identical `'principal' | 'app'` axis. It was `scope`, which P2 already freed for the OAuth
     * permission string (`OAuth2Options.scope`); the cache slot was the last holdout, so one word
     * still meant two things.
     */
    tenancy?: 'principal' | 'app';
    /**
     * Request header(s) whose values vary the response and so must be part of the key (e.g.
     * `'accept-language'` or a list). An explicit allowlist **overrides** the default of honouring
     * the response's `Vary`. Volatile/secret headers (authorization, cookie, traceparent, …) are
     * never keyed. A bare string is shorthand for a one-element list (CONTRACT.md P7).
     */
    vary?: string | string[];
    /**
     * Cacheable HTTP method(s). Default `['GET','HEAD']`. A GraphQL **query** opts in by listing
     * its method (`'POST'`) — a POST's read-vs-mutate intent cannot be inferred, so it is
     * explicit. Coalescing applies to exactly this set; mutations are never cached. A bare string
     * is shorthand for a one-element list (CONTRACT.md P7).
     */
    methods?: string | string[];
    /** In-process LRU cap on live entries (the store stays dumb). Default 1000. */
    entries?: number;
    /**
     * Request coalescing mode. `'process'` (v1 default) collapses concurrent identical in-flight
     * callers in one process onto a single shared run; `false` disables it. `'cluster'` is
     * reserved for the deferred cross-process protocol and behaves as `'process'` in v1.
     */
    coalesce?: 'process' | 'cluster' | false;
    /**
     * How a stored value is detected as stale against its contract — the ADR 0004 ladder, whose
     * rungs are {@link CacheFingerprintOptions}' three members. Unset is the automatic path: a
     * registered `@stitchapi/fingerprint-*` strategy makes `output` changes self-invalidate, and an
     * un-fingerprintable schema refuses to cache (fail-closed). A bare `string | number` is the P12
     * shorthand for the dominant field — `fingerprint: 3` ≡ `fingerprint: { version: 3 }`, the
     * always-available manual override.
     */
    fingerprint?: string | number | AtLeastOne<CacheFingerprintOptions>;
    /** Sugar: author the key seed from the input instead of deriving it from the request (CONTRACT.md P6). */
    keyOf?: (input: StitchInput) => string;
}

// ---- Auth -----------------------------------------------------------------
export interface AuthContext {
    store: StitchStore; // throttle/session state — in-memory by default, shareable when configured
    /**
     * Secret namespace for auth tokens/sessions: off `__config`, redacted from traces, read
     * only by auth strategies (ADR 0002 §4). Defaults to a reserved prefix over `store`; a
     * seam may back it with a hardened `secretStore`. Sessions are keyed by scope here.
     */
    vault: StitchStore;
    /**
     * The principal this call is bound to, threaded from `seam.as(principal)` — `undefined`
     * when no seam binds one. Set by trusted code; NEVER readable from `StitchInput`, so a
     * caller cannot name (and impersonate) another principal (ADR 0002 §2).
     */
    principal?: string;
    /**
     * The current run (ADR 0007), threaded per-call by the engine. A strategy that spawns a
     * sub-call — `cookieSession`'s login — runs it as a CHILD of this run so it appears in the
     * trace/span tree under the call that triggered it. `undefined` outside a traced run.
     */
    run?: RunContext;
    /**
     * The stitch's resolved {@link Clock} (ADR 0010), threaded by the engine — `systemClock`
     * unless one was injected as `clock`. A strategy whose CONTROL FLOW is time-driven reads it
     * instead of the wall clock, so a `manualClock()` drives it: `oauth2` decides token freshness
     * (`expires_in` minus `refresh.skew`) on this, which is what makes "does my client refresh
     * before expiry" testable without real waiting. Optional so a hand-built context (a unit test
     * of a custom strategy) still type-checks; fall back to the system clock when it is absent.
     */
    clock?: Clock;
    /**
     * Announce an `info` StitchEvent onto the run's event stream — a strategy reporting a
     * decision it made (e.g. which env var a `bearer` token resolved from via `optionalEnv`, or
     * that `oauth2` fetched a token). NEVER carries the secret itself. The engine buffers these
     * during `apply`/`refresh` and yields them; outside a run it is a no-op.
     */
    emit: (topic: string, detail?: string) => void;
}
/**
 * A non-secret, declarative description of an auth strategy's wire shape — the OpenAPI 3.1
 * "Security Scheme Object", minus any credential material. A built-in strategy exposes one via
 * {@link AuthStrategy.scheme}; redaction then projects it onto the public `__config` as
 * `authScheme` (the live, secret-bearing `auth` is stripped), so a stitch's auth round-trips as
 * JSON (the contract gate) and `stitch export --openapi` can emit `components.securitySchemes`. It
 * NEVER carries a token, key value, or password — only the scheme's type and the parameter
 * names/URLs that are public in any OpenAPI document.
 */
export type SecurityScheme =
    | { type: 'http'; scheme: 'bearer' | 'basic'; bearerFormat?: string }
    | { type: 'apiKey'; in: 'header' | 'query' | 'cookie'; name: string }
    | {
          type: 'oauth2';
          flows: { clientCredentials?: OAuth2ClientCredentialsFlow };
      };
/**
 * The client-credentials arm of a {@link SecurityScheme}'s `flows` — OpenAPI 3.1's "OAuth Flow
 * Object", spelled exactly as the spec spells it (`tokenUrl`/`scopes`/`refreshUrl`, CONTRACT.md
 * P22) so `stitch export --openapi` emits it as an identity mapping. Named and exported per P14 —
 * the shape mirrors the standard, the name is ours. (`flows` itself stays inline: a single
 * optional member is not a multi-field sub-object.)
 */
export interface OAuth2ClientCredentialsFlow {
    tokenUrl: string;
    scopes: Record<string, string>;
    refreshUrl?: string;
}
export interface AuthStrategy {
    name?: string;
    /**
     * A non-secret {@link SecurityScheme} describing this strategy's wire shape. Redaction surfaces
     * it onto the public `__config.authScheme` (the live strategy itself is stripped) so the auth
     * round-trips as JSON and feeds `stitch export --openapi`. Built-ins set it; omit it in a
     * custom strategy whose scheme cannot be described, and the exporter simply leaves it
     * unannotated.
     */
    scheme?: SecurityScheme;
    apply: (req: AdapterRequest, ctx: AuthContext) => void | Promise<void>;
    shouldRefresh?: (res: AdapterResponse) => boolean;
    refresh?: (ctx: AuthContext) => void | Promise<void>;
}

// ---- Hooks ----------------------------------------------------------------
export interface HookContext {
    name: string;
    attempt: number;
    req?: AdapterRequest;
    res?: AdapterResponse;
    error?: unknown;
}
export interface Hooks {
    onRequest?: (ctx: HookContext) => void | Promise<void>;
    onResponse?: (ctx: HookContext) => void | Promise<void>;
    onError?: (ctx: HookContext) => void | Promise<void>;
    onRetry?: (ctx: HookContext) => void | Promise<void>;
}

// ---- Events (the streaming spine) -----------------------------------------
export type ProgressPhase =
    | 'auth'
    | 'request'
    | 'throttled'
    | 'retry'
    // A resumable-SSE reconnect (issue #71): emitted before the engine waits the backoff and
    // reopens a dropped `text/event-stream` body with the last `id:` replayed as `Last-Event-ID`.
    // Reuses the `progress` event (its `attempt` is the reconnect count, `waited` the backoff)
    // rather than minting a new StitchEvent type — same shape as the `retry` phase.
    | 'reconnect'
    | 'paginate'
    | 'circuit'
    | 'cache';
export type StitchEvent<T = unknown> =
    | {
          type: 'start';
          name: string;
          method: string;
          url: string;
          input: StitchInput;
          at: number;
          // Run identity (ADR 0007) — also delivered on the {@link TraceContext} ctx. Stamped
          // here too so a non-sink `.stream()` consumer can read a run's identity off its first
          // event. Optional: a `start` event built by hand (tests) may omit them.
          spanId?: string;
          traceId?: string;
          parentSpanId?: string;
      }
    | {
          type: 'progress';
          phase: ProgressPhase;
          attempt: number;
          detail?: string;
          /** How long the engine waited before this step (ms): throttle pacing or retry/reconnect backoff. */
          waited?: number;
          at: number;
      }
    // A strategy-level announcement (auth decisions, inference). Non-progress; carries no secret.
    | { type: 'info'; topic: string; detail?: string; at: number }
    | { type: 'drift'; finding: DriftFinding; at: number }
    | { type: 'delta'; chunk: unknown; at: number }
    | {
          type: 'result';
          /** The terminal/aggregated result payload (aligns with `SafeResult.data`; CONTRACT.md P5/D1). */
          data: T;
          status: number;
          attempts: number;
          at: number;
      }
    | {
          type: 'error';
          name: string;
          message: string;
          status?: number;
          // Set only on a delegate-backoff rate-limit outcome (`throttle.delegate`): the ms parsed
          // from `Retry-After` (delta-seconds OR HTTP-date), so a `.stream()` consumer gets the same
          // structured backoff hint the awaited path gets off the thrown RateLimitError. Additive and
          // optional — every other `error` event omits it (issue #145).
          retryAfter?: number;
          attempts: number;
          at: number;
      }
    | {
          type: 'done';
          ok: boolean;
          /** Total wall-clock time for the run (ms). */
          elapsed: number;
          attempts: number;
          at: number;
      };

/**
 * Anything that produces a stitch event stream: the event iterable itself (a `.stream()`
 * generator), or anything that hands one back (a {@link StitchResult}, a stitch stub). The
 * canonical intake for event-stream consumers — `collectStitchEvents` in `stitchapi/testing`
 * accepts exactly this.
 */
export type StitchEventSource<T = unknown> =
    AsyncIterable<StitchEvent<T>> | { stream(): AsyncIterable<StitchEvent<T>> };

// ---- Clock (injectable time, ADR 0010) ------------------------------------
/** An opaque timer handle returned by {@link Clock.setTimer}. */
export type TimerHandle = unknown;
/**
 * The seam for time. The engine reads the clock for retry backoff, throttle pacing, the per-attempt
 * timeout, circuit cooldown, and `Retry-After` HTTP-dates — so a test can drive them deterministically
 * with no real waiting. Defaults to the system clock (wall-clock + global timers); inject a
 * `manualClock()` (from `stitchapi/testing`) to control time by hand. NOTE: `timeout.total` and the
 * `at`/`elapsed` fields on events stay on wall-clock and are not driven by the clock.
 */
export interface Clock {
    /** Current time in epoch ms. */
    now(): number;
    /** Resolve after `ms`; reject promptly if `signal` aborts. */
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
    /** Run `fn` after `ms`; returns a handle for {@link Clock.clearTimer}. */
    setTimer(fn: () => void, ms: number): TimerHandle;
    /** Cancel a pending timer from {@link Clock.setTimer}. */
    clearTimer(handle: TimerHandle): void;
}

// ---- Config & the Stitch callable ----------------------------------------
// Each slot accepts any {@link SchemaLike} (raw Zod / Standard Schema / Validator / predicate) —
// no `toValidator()` cast required; `normalizeInput` coerces them at compose time.
export interface InputSchemas {
    params?: SchemaLike;
    query?: SchemaLike;
    body?: SchemaLike;
    headers?: SchemaLike;
    // GraphQL variables (the `graphql` surface's primary input). Declaring a schema here types the
    // call arg's `variables` (see `CallInput`) and validates them at runtime alongside the other
    // slots; left undeclared, `variables` stays the loose untyped passthrough it has always been.
    variables?: SchemaLike;
}
/**
 * Auto-pagination: follow pages until {@link PaginateOptions.next} returns `undefined`, aggregating
 * `items` with auth/retry/throttle applied to every page (CONTRACT.md P14 — extracted from the
 * inline `paginate` shape so it can be imported and composed).
 */
export interface PaginateOptions {
    /**
     * Given the previous page's raw body and how many pages were fetched, return the input (merged
     * over the original) for the next page, or `undefined` to stop.
     */
    next: (prevBody: unknown, pagesFetched: number) => StitchInput | undefined;
    /** Pull the array from each picked page. Default: the value if it is an array. */
    items?: (value: unknown) => unknown[];
    /** Safety cap on pages. Default 50. */
    pages?: number;
}
export interface StitchConfig {
    /** Label used in events and traces; defaults to `path` or `'stitch'`. */
    name?: string;
    /**
     * Request style — a {@link Surface} plugin (ADR 0005 Decisions 1-2). Omitted = the built-in
     * `http` surface. The public `__config` exposes only the surface's `id` string (so a stitch's
     * declaration round-trips as JSON — Decision 11); the live object stays on `__rawConfig`.
     */
    kind?: Surface;
    /** HTTP method; defaults to `GET`. */
    method?: string;
    /**
     * Wire-format options — request body encoding, response decoding, and urlencoded array
     * serialisation, grouped by category rather than by request/response phase (CONTRACT.md P24).
     * The opaque `wire: {}` is rejected (P20); no field dominates, so there is no scalar shorthand
     * (P14), exactly as with {@link StitchConfig.input}.
     */
    wire?: AtLeastOne<WireOptions>;
    /**
     * Streaming options (ADR 0005 Decision 5) — how a `stream` surface decodes the live body
     * (`'bytes'` default / `'lines'` / `'ndjson'` / `'json'`). `'json'` is the structural,
     * unframed streaming-JSON decoder (issue #111): one `delta` per complete value / top-level
     * array element, tolerant of internal newlines and concatenated values. Only meaningful for
     * the `stream` surface. A bare {@link StreamDecode} string is shorthand for the object form —
     * `stream: 'ndjson'` ≡ `stream: { decode: 'ndjson' }` (CONTRACT.md P12); the opaque
     * `stream: {}` is rejected (P20).
     */
    stream?: StreamDecode | AtLeastOne<StreamOptions>;
    /**
     * Resumable-SSE options (issue #71) — sibling to {@link StitchConfig.stream}, but for the `sse`
     * surface. **Off by default**: with no `sse` block the engine opens the live body once
     * (today's behaviour). When enabled, a dropped stream reconnects, replaying the last `id:` as
     * `Last-Event-ID` and honouring a server `retry:` (else `reconnect.delay` / the `retry`
     * policy), capped at `reconnect.attempts`. Plain JSON (the contract gate). Only the `sse`
     * surface reads it. `true` is shorthand for `{ reconnect: true }` (CONTRACT.md P13); the
     * object form must set at least one field (P20).
     */
    sse?: boolean | AtLeastOne<SseOptions>;
    /**
     * Full request endpoint as one string — the atomic spelling, when a stitch is exactly one
     * endpoint with no base to share. Templated (`{param}`, incl. the host) and `?query`-aware
     * like `path`; may be a thunk for lazy/env resolution.
     *
     * ⚠️ `url` is the COMPLETE endpoint and is **not** joined to `baseUrl` — setting `url` makes
     * `baseUrl` ignored. To address an endpoint *relative to* a shared `baseUrl` (e.g. a
     * seam/fragment origin), use `path`, not a relative `url`: `url: '/users'` resolves to the
     * un-fetchable `/users`, whereas `path: '/users'` resolves to `${baseUrl}/users`. Mutually
     * exclusive with `baseUrl`/`path`: when both are set `url` wins, and across composed
     * fragments the last fragment to write either spelling wins the whole slot.
     */
    url?: string | (() => string);
    /** Origin that `path` is appended to, as a string or a thunk resolved at call time. Ignored when `url` is set (which carries its own origin). */
    baseUrl?: string | (() => string);
    /** Path appended to `baseUrl` — use THIS (not a relative `url`) for an endpoint relative to a shared `baseUrl`; may include `{param}` slots and a `?query` string. Ignored when `url` is set. */
    path?: string;
    /** Static default headers merged into every request. */
    headers?: Record<string, string>;
    /** GraphQL document string (`kind: 'graphql'`) — sent as the request body's `query` field. */
    document?: string;
    /**
     * GraphQL `operationName` sent alongside the document + `variables` (`kind: 'graphql'`). Omit
     * to derive it from the first named operation in `document`; set it explicitly to override
     * (e.g. a multi-operation document) or pass `''` to suppress the field entirely.
     */
    operationName?: string;
    /**
     * Schemas validating params, query, body, headers, and (GraphQL) variables before the request.
     * At least one slot must be set — the opaque `input: {}` is rejected (CONTRACT.md P20).
     */
    input?: AtLeastOne<InputSchemas>;
    /**
     * Response schema, or a {@link DriftSpec} for leveled drift detection. Accepts any
     * {@link SchemaLike} — a raw Zod schema, any Standard Schema (Valibot, ArkType), or a
     * `(value) => boolean` predicate — directly; the stitch infers its result type from it
     * (see `InferOutput`), so a hand-written generic is rarely needed.
     *
     * @example output: z.object({ id: z.number(), name: z.string() })
     */
    output?: SchemaLike | DriftSpec;
    /** Dot-path picking the part of the response to return (e.g. `'data.items'`). */
    pick?: string;
    /** Reshape the raw body before `pick` and validation (e.g. scrape HTML to structured data). */
    transform?: (body: unknown) => unknown;
    /** Auto-loop pages, aggregating items, with auth/retry/throttle applied to every page. */
    paginate?: PaginateOptions;
    /** Auth strategy — the stitch holds the credential; the caller never sees it. */
    auth?: AuthStrategy;
    /**
     * Retry-and-backoff policy. A bare number is shorthand for the attempt count —
     * `retry: 3` ≡ `retry: { attempts: 3 }`; the opaque `retry: {}` is rejected (CONTRACT.md P20).
     */
    retry?: number | AtLeastOne<RetryOptions>;
    /**
     * What counts as success — the declarative input to stage 4, the surface's `interpret`
     * (ADR 0022). `accept` takes a non-2xx as a normal result; `flag` fails a `200` whose body
     * explicitly says it failed. The opaque `verdict: {}` is rejected (P20).
     */
    verdict?: AtLeastOne<VerdictOptions>;
    /**
     * Rate and concurrency limits. A bare rate string is shorthand —
     * `throttle: '2/s'` ≡ `throttle: { rate: '2/s' }` (CONTRACT.md P12); the opaque `throttle: {}`
     * is rejected (P20).
     */
    throttle?: string | AtLeastOne<ThrottleOptions>;
    /**
     * Timeouts, by scope: `total` for the whole call, `each` for one attempt. A bare number (ms) or
     * duration string is shorthand for the total — `timeout: '5s'` ≡ `timeout: { total: '5s' }`;
     * the opaque `timeout: {}` is rejected (CONTRACT.md P20).
     */
    timeout?: number | string | AtLeastOne<TimeoutOptions>;
    /**
     * Circuit breaker that fast-fails a repeatedly failing dependency. `failures` + `cooldown` are
     * required by design (P15), so the empty object is rejected (P20 — `AtLeastOne`). The
     * positional form names both at once — `circuit: [5, '30s']` ≡
     * `circuit: { failures: 5, cooldown: '30s' }`.
     */
    circuit?:
        | [failures: number, cooldown: number | string]
        | AtLeastOne<CircuitOptions>;
    /**
     * Inject a stable Idempotency-Key header on writes so safe retries don't duplicate.
     * `true` enables it with defaults (header `Idempotency-Key`, a random uuid per call); the
     * object form customizes it and **must** set at least one field — the opaque `idempotency: {}`
     * is rejected (CONTRACT.md P20).
     */
    idempotency?: boolean | AtLeastOne<IdempotencyOptions>;
    /**
     * Read-through response cache + in-process coalescing (ADR 0003). Off unless set; the engine
     * is loaded lazily from the `stitchapi/cache` subpath only when this block is present. A bare
     * number (ms) or duration string is shorthand for the TTL — `cache: '1m'` ≡
     * `cache: { ttl: '1m' }` (still subject to the fingerprint / `version` rules before an entry is
     * actually stored).
     */
    cache?: number | string | CacheOptions;
    /**
     * Opt this stitch out of the cache **and** coalescing entirely — never stored, always a live
     * call. The honest "do not persist this response" hatch for one-time tokens or compliance-
     * bound data; the opaque key + principal scope already cover leak-protection, so the default
     * `false` is not fail-open. Only meaningful alongside a `cache` block.
     */
    sensitive?: boolean;
    /** Request/response/error/retry lifecycle hooks. At least one — the opaque `hooks: {}` is rejected (CONTRACT.md P20). */
    hooks?: AtLeastOne<Hooks>;
    /**
     * Fragment(s) to deep-merge under this config — strings, partials, or other stitches. A single
     * fragment is shorthand for a one-element list (CONTRACT.md P7).
     */
    extends?:
        | Partial<StitchConfig>
        | Stitch
        | string
        | (Partial<StitchConfig> | Stitch | string)[];
    /** Test seam / custom transport. */
    adapter?: Adapter;
    /**
     * Injectable time (ADR 0010). Defaults to the system clock; inject a `manualClock()` (from
     * `stitchapi/testing`) to drive retry backoff, throttle pacing, the per-attempt timeout, and
     * circuit cooldown deterministically in tests. Live object — stripped from `__config`.
     */
    clock?: Clock;
    /** Pluggable state store for throttle + session. Default in-memory. */
    store?: StitchStore;
    /**
     * Observability sink — **off by default**, because a stitch's only effect on
     * the world is its call. Opt in with `'console'` (the colored stderr stream),
     * a sink from `fileSink(path)` / `createTrace(...)` for JSONL on disk, or any
     * custom {@link TraceSink}. `false` forces it off even when the `STITCH_TRACE_*`
     * env vars are set. Unset falls back to the env-driven sink, which is itself
     * silent unless `STITCH_TRACE_CONSOLE` / `STITCH_TRACE_FILE` / `STITCH_EXPORT`
     * opt in.
     */
    trace?: TraceSink | 'console' | false;
}

/**
 * {@link CacheFingerprintOptions} after {@link compose}: the nested `transform` scalar is folded to
 * `{ version }`, so the resolver reads one shape.
 */
export type ResolvedCacheFingerprintOptions = Omit<
    CacheFingerprintOptions,
    'transform'
> & {
    transform?: CacheTransformOptions;
};

/**
 * {@link CacheOptions} after {@link compose}: the `T | T[]` list fields are always arrays and the
 * `fingerprint` scalar is folded to `{ version }` (with its own nested fold applied).
 */
export type ResolvedCacheOptions = Omit<
    CacheOptions,
    'vary' | 'methods' | 'fingerprint'
> & {
    vary?: string[];
    methods?: string[];
    fingerprint?: ResolvedCacheFingerprintOptions;
};

/** {@link StreamOptions} after {@link compose}: the `buffer` scalar is folded to `{ chars }`. */
export type ResolvedStreamOptions = Omit<StreamOptions, 'buffer'> & {
    buffer?: StreamBufferOptions;
};

/** {@link WireOptions} after {@link compose}: the `multipart` scalar is folded to `{ nesting }`. */
export type ResolvedWireOptions = Omit<WireOptions, 'multipart'> & {
    multipart?: MultipartOptions;
};

/**
 * A {@link StitchConfig} after {@link compose} has run: every authoring shorthand is expanded to
 * its canonical envelope field (P0) — scalar `retry` / `timeout` / `cache` / `throttle` / `stream`
 * / `multipart` literals become `{ attempts }` / `{ total }` / `{ ttl }` / `{ rate }` /
 * `{ decode }` / `{ nesting }`, the `sse: true` toggle becomes `{ reconnect: true }`, the
 * positional `circuit` tuple becomes `{ failures, cooldown }`, the `hooks` / `input` envelopes
 * become their chained/normalized object, and every `T | T[]` list field is an array. This is the
 * shape the engine and {@link redactConfig} read — never the loose authoring union.
 */
export type ResolvedStitchConfig = Omit<StitchConfig, NormalizedSlot | 'kind'> &
    ResolvedNormalizations & {
        /**
         * ALWAYS present after `compose` — an omitted `kind` resolves to `httpSurface` (ADR 0022
         * Decision 2). The engine therefore has no "no surface" branch and no interpretation of its
         * own: it asks the selected surface, and for a plain stitch that surface is `http`.
         */
        kind: Surface;
    };

/**
 * The PUBLIC, redacted projection of a {@link StitchConfig} that a stitch exposes as `__config`
 * (and a seam as its shared `__config`). {@link redactConfig} produces it: the live, secret-bearing
 * handles are stripped (`auth`, `store`, `adapter`), the surface is normalised to its `id` string
 * (`kind`), and the auth's non-secret {@link SecurityScheme} is projected onto `authScheme`. It
 * therefore round-trips as JSON (ADR 0005 Decision 11 — the contract gate) and is what `mcp` /
 * `diagram` / `stitch export --openapi` read.
 *
 * This is the HONEST runtime shape: `__config.auth` / `.store` / `.adapter` / `.trace` are always
 * absent, and `__config.kind` is the surface's `id` string — never a live {@link Surface}. (The
 * full, secret-bearing config lives on the non-enumerable `__rawConfig`, used only for fragment
 * composition.)
 */
export type RedactedStitchConfig = Omit<ResolvedStitchConfig, RedactedSlot> & {
    /** The surface's `id` string (never the live {@link Surface}); absent for the default `http`. */
    kind?: string;
    /** Non-secret auth scheme projected from the (stripped) live `auth`; feeds `export --openapi`. */
    authScheme?: SecurityScheme;
};

/**
 * The error a failed stitch raises: a non-2xx response (after retries), a contract/validation
 * breach, a timeout, or an open circuit. It is what `await stitch(...)` and {@link Stitch.unwrap}
 * throw, and what rides in `error` on the {@link SafeResult} from {@link Stitch.safe}.
 */
export class StitchError extends Error {
    /** HTTP status when the failure came from a response; `undefined` for transport/internal errors. */
    readonly status: number | undefined;
    /** Attempts made before giving up (1 = no retry). */
    readonly attempts: number;
    /**
     * The parsed response body of the failing response (an API's `{ error: "..." }` payload),
     * when the failure came from an HTTP response; `undefined` for transport/internal errors. Only
     * populated on the awaited / `.safe()` path — it is carried over the non-enumerable error
     * channel and so never serialises into a trace sink.
     */
    readonly body?: unknown;
    /** The final request URL (after redirects) of the failing response, when the transport exposes it. */
    readonly url?: string;
    constructor(
        message: string,
        opts: {
            status?: number | undefined;
            attempts?: number | undefined;
            body?: unknown;
            url?: string | undefined;
            cause?: unknown;
        } = {},
    ) {
        super(
            message,
            opts.cause !== undefined ? { cause: opts.cause } : undefined,
        );
        this.name = 'StitchError';
        this.status = opts.status;
        this.attempts = opts.attempts ?? 0;
        if (opts.body !== undefined) this.body = opts.body;
        if (opts.url !== undefined) this.url = opts.url;
    }
}

/**
 * The outcome of a never-throwing call ({@link Stitch.safe}). A discriminated union: check `error`
 * (or `ok`) — when `error` is `null` the call succeeded and `data` is the result; otherwise `error`
 * is the {@link StitchError} and `data` is `null`.
 *
 * `error` is the SAME instance the throwing path raises, never a downgraded copy — so when the
 * failure is a delegate-backoff `RateLimitError` (a `StitchError` subclass, CONTRACT.md P10) it
 * arrives here as one, with `retryAfter`/`response` intact and `instanceof` still true.
 */
export type SafeResult<T> =
    | { ok: true; data: T; error: null }
    | { ok: false; data: null; error: StitchError };

/** Options for {@link Stitch.inspect} (ADR 0016 / ADR 0018). */
export interface InspectOptions {
    /**
     * Honour the cache policy instead of bypassing it. Default `false` — `.inspect()` is a fresh
     * network probe (neither reads nor writes the cache), so `raw` is always live. With `cache: true`
     * a cache hit is allowed, but the cache stores only `{ value, status }` — so `raw` is `null` on
     * a hit (it is only populated on a miss, where a live request actually ran).
     */
    cache?: boolean;
    /**
     * Scrub secret-named fields from `raw` before placing it on the wrapper (ADR 0018). Default
     * `false` — `raw` is unredacted so the deliberate-use case ("catch a stray token in an
     * undeclared field") is unimpaired. Set when you want to pipe `wrapper.raw` into a log or
     * support ticket and need the _known-secret_ fields removed first.
     *
     * - `true` — apply the shared secret-key denylist (`isSecretKey` / `registerSecretKey`
     *   registrations) to every object key in `raw`, depth-first. Returns a deep clone.
     * - `string[]` — additionally scrub the listed key-name/path patterns on top of the shared
     *   denylist (reuses the {@link matchPath} grammar: exact, `*` wildcard, or prefix).
     *
     * ⚠️ Name-based only — cannot catch a secret in an innocuously-named undeclared field.
     * `status`/`findings`/`value` are never affected.
     */
    redact?: boolean | string[];
}

/**
 * The result of {@link Stitch.inspect} (ADR 0016) — the validated value alongside the pre-validation
 * raw body and the drift {@link DriftFinding}s diffed between them, plus the response `status`. It
 * **never throws**: a hard contract violation comes back as `{ data: null, error }` with `raw`,
 * `findings`, and `status` still populated. `data` and `error` are **inverse** — `data` is `null`
 * iff `error` is set.
 *
 * ⚠️ `raw` is the UNREDACTED pre-validation body, exposed on a **non-enumerable** field: `JSON.stringify`,
 * object spread, and trace walkers all skip it, so it can't leak by accident — reach for `wrapper.raw`
 * deliberately, and never log the whole wrapper. `raw` is `null` on a streaming surface (no single
 * buffered body) and on a cache hit — `source` (ADR 0019) disambiguates which.
 */
export interface Inspection<T> {
    /** The validated result payload — coerced/defaulted/stripped per ADR 0015; `null` iff `error` is set. Aligns with `SafeResult.data` (CONTRACT.md P5). */
    data: T | null;
    /**
     * The pre-validation body the findings are diffed against. Non-enumerable; `null` on
     * streaming/cache-hit. Unredacted by default — to scrub known-secret fields before
     * sharing, pass `{ redact: true }` (or `{ redact: ['extra.path'] }`) to `.inspect()`
     * (ADR 0018). Non-enumerability already prevents accidental leakage via
     * `JSON.stringify` / spread; `redact` is the deliberate-sharing escape hatch.
     */
    raw: unknown;
    /** Soft + hard drift findings (including those that ride the event stream), in emission order. */
    findings: DriftFinding[];
    /** HTTP status of the probed response — makes `raw` interpretable (a `422` body reads unlike a `200`). */
    status: number;
    /** The {@link StitchError} on a hard failure; `null` on success. */
    error: StitchError | null;
    /**
     * Why `raw` is what it is (ADR 0019) — the interpretant of `raw`. `'cache'` and `'stream'` are
     * **structural** nulls: `raw` _can never_ exist there (the cache stores only `{ value, status }`;
     * a streaming surface has no single buffered body). `'live'` means a real request ran (a miss, or
     * the default cache-bypassing probe) — so `raw` is populated **except** when a transport error
     * killed the request before any body arrived (then `raw` is `null` and `source` is still `'live'`).
     * The contract is "`source` tells you whether `raw` _could_ exist," not "`source === 'live'` ⟹
     * `raw !== null`."
     */
    source: 'live' | 'cache' | 'stream';
}

/**
 * Fine-grained cache outcome for one run (ADR 0019) — the detail behind {@link Inspection.source}.
 * `'hit'` / `'hit (revalidated)'` / `'miss'` mirror the engine's `phase:'cache'` events; `'bypass'`
 * is a run that skipped the cache (the default `.report()` probe, or a runtime non-cacheable case);
 * `'disabled'` is a stitch with no `cache` block configured at all.
 */
export type CacheOutcome =
    'hit' | 'hit (revalidated)' | 'miss' | 'bypass' | 'disabled';

/**
 * The result of {@link Stitch.report} (ADR 0019) — an {@link Inspection} **plus** run diagnostics: it
 * _is_ an inspection (same `data` / `raw` / `findings` / `status` / `error` / `source`, same
 * never-throws contract and the same non-enumerable `raw`) extended with how the run actually went.
 * Every added field is secret-free and enumerable — a report is safe to log _except_ don't expand
 * `raw` (inherited non-enumerable, ADR 0018's `redact` applies). Per-attempt latency is deliberately
 * **absent** in v1 (deferred — the spine carries no per-attempt request spans).
 */
export interface RunReport<T> extends Inspection<T> {
    /** Total attempts made, including the first (1 = no retry). From the terminal event / `StitchError.attempts`. */
    attempts: number;
    /**
     * Wall-clock timing of the run. `elapsed` is the total (the `done` event's `elapsed`); `waited` is the
     * summed backoff/throttle/reconnect wait (Σ `progress.waited`), **omitted** when nothing waited.
     */
    timing: { elapsed: number; waited?: number };
    /**
     * The **resolved, redacted** per-call config (ADR 0019 §5) — the stitch's existing redacted
     * `__config`, never the secret-bearing `__rawConfig`. Safe to echo into a log or support ticket.
     */
    config: RedactedStitchConfig;
    /** Fine-grained cache outcome — the detail behind {@link Inspection.source}. See {@link CacheOutcome}. */
    cache: CacheOutcome;
}

export interface StitchResult<T> extends PromiseLike<T> {
    stream(): AsyncGenerator<StitchEvent<T>, void>;
    /** Consume the call without throwing — resolves to `{ ok, data, error }` (see {@link SafeResult}); shares the one run with `then`/`catch`/`finally`. */
    safe(): Promise<SafeResult<T>>;
    /** Attach a rejection handler (like `Promise.catch`); the stitch runs once, shared with `then`/`finally`/`safe`. */
    catch<R = never>(
        onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null,
    ): Promise<T | R>;
    /** Run a callback when the call settles (like `Promise.finally`); shared with `then`/`catch`/`safe`. */
    finally(onfinally?: (() => void) | null): Promise<T>;
}
/**
 * The callable a stitch resolves to. `TOut` is the result type (inferred from `config.output`);
 * `TIn` is the call-argument type (inferred from `config.input` — see {@link InputOf}). `TIn`
 * defaults to the loose {@link StitchInput}, which has no required keys, so a stitch with no input
 * schemas keeps its fully-optional argument and every pre-Phase-2 `Stitch<T>` usage is unchanged.
 * No `extends StitchInput` bound on `TIn`: a `headers` schema can infer non-string values, which
 * `Record<string, string>` would reject.
 */
export interface Stitch<TOut = unknown, TIn = StitchInput> {
    (...args: Args<TIn>): StitchResult<TOut>;
    stream(...args: Args<TIn>): AsyncGenerator<StitchEvent<TOut>, void>;
    /**
     * Call without throwing: resolves to a `SafeResult` — `{ ok, data, error }`. The eager
     * shortcut for `stitch(...).safe()`, mirroring `.stream()`.
     */
    safe(...args: Args<TIn>): Promise<SafeResult<TOut>>;
    /**
     * Call and unwrap to the value, throwing a `StitchError` on failure. The named twin
     * of `.safe()` (and an explicit spelling of the throwing bare call).
     */
    unwrap(...args: Args<TIn>): Promise<TOut>;
    /**
     * Probe a fresh call and return an {@link Inspection} — `{ data, raw, findings, status, error }` —
     * **without throwing** (ADR 0016). Use it after the fact to ask "the schema coerced/stripped this;
     * what did the server actually send?": `raw` is the pre-validation body, `findings` the soft + hard
     * drift between it and `data`.
     *
     * `.inspect()` **always hits the network and bypasses the cache by default**, so it is a fresh probe
     * — *not* an observer of what your cached `await` call did. Pass `true` (≡ `{ cache: true }`) to
     * honour the cache policy (then `raw` is `null` on a hit). On a streaming surface `raw` is `null`
     * too (no single buffered body). ⚠️ `raw` is unredacted and non-enumerable — read `wrapper.raw`
     * deliberately; never log the whole wrapper.
     */
    inspect(
        ...args: [...Args<TIn>, opts?: boolean | AtLeastOne<InspectOptions>]
    ): Promise<Inspection<TOut>>;
    /**
     * Probe a fresh call and return a {@link RunReport} — an {@link Inspection} (`{ data, raw,
     * findings, status, error, source }`) **plus** run diagnostics: `attempts`, `timing`
     * (`{ elapsed, waited? }`), the resolved+redacted `config`, and the fine-grained `cache` outcome
     * (ADR 0019). Like `.inspect()` it **never throws** (a hard contract violation comes back with
     * `error` set and the diagnostics populated) and is a **network probe**: it always hits the
     * network and **bypasses the cache by default** — pass `true` (≡ `{ cache: true }`) to honour
     * the cache policy (then `cache` reports the real `hit`/`miss` and `raw` is `null`/`source` is
     * `'cache'` on a hit). Use `.report()` to ask "how did this run go?"; `.inspect()` stays the
     * minimal "raw + drift" probe. ⚠️ `raw` is inherited unredacted and non-enumerable — the rest
     * of the report is safe to log.
     */
    report(
        ...args: [...Args<TIn>, opts?: boolean | AtLeastOne<InspectOptions>]
    ): Promise<RunReport<TOut>>;
    // WHY THIS SLOT IS UNGUARDED — implementer detail, deliberately a line comment rather than
    // JSDoc: the docs playground surfaces a member's JSDoc verbatim as autocomplete help
    // (apps/docs/app/(home)/playground/playground-completions.generated.ts), where a wall of
    // declaration-emit reasoning is noise for the reader hovering `.with`. The user-facing caveat
    // stays in the JSDoc below; the mechanism lives here.
    //
    // `const P` is inferred from the argument exactly as on the config surfaces, so
    // excess-property checking is suppressed the same way and `NoUnknownKeys` would be the fix —
    // but this is the only signature whose RETURN type reads `keyof P`, and
    // `keyof (P & NoUnknownKeys<P, …>)` does not reduce to `keyof P` while `P` is unresolved.
    // Intersecting the parameter therefore rewrites `RelaxKeys<TIn, keyof P>` into a deferred union
    // that `tsup`'s declaration rollup emits in a different form than source — so `lib`'s `Stitch`
    // stops being structurally identical to `src`'s, and every `S extends Stitch<unknown>`
    // constraint in the package breaks (`streaming-inference.test-d.ts` catches it immediately).
    //
    // The F-bounded spelling that would keep the parameter bare —
    // `P extends Partial<TIn> & NoUnknownKeys<P, TIn, …>` — is a circular constraint (TS2313).
    // Guarding this slot means degrading the public `Stitch` type for every consumer, which costs
    // more than the hole it closes; the config surfaces have no such coupling and are all guarded.
    /**
     * Bind part of the call input, returning a stitch whose remaining input is relaxed by the keys
     * just supplied.
     *
     * Unlike the config surfaces, a MISSPELLED input key here is not a compile error — it binds
     * nothing, silently (`.with({ params, parms })` keeps the `params` and drops the typo). Spell
     * the slots as {@link StitchInput} declares them.
     */
    with<const P extends Partial<TIn>>(
        partial: P,
    ): Stitch<TOut, RelaxKeys<TIn, keyof P>>;
    /**
     * Cache surface (ADR 0003). A no-op unless this stitch has a `cache` block.
     * - `invalidate(input)` — **exact** eviction of the one entry that `input` would hit.
     * - `cache.invalidate()` — **bulk** eviction of every entry this stitch produced (a
     *   per-stitch generation bump; prior entries become unreachable and TTL out).
     * - `cache.keyOf(input)` — the derived opaque key, for introspection (CONTRACT.md P6).
     */
    invalidate(input?: StitchInput): Promise<void>;
    readonly cache: {
        invalidate(): Promise<void>;
        keyOf(input?: StitchInput): Promise<string | undefined>;
    };
    readonly __config: RedactedStitchConfig;
    readonly __stitch: true;
}

export function isStitch(x: unknown): x is Stitch {
    return (
        typeof x === 'function' &&
        (x as { __stitch?: boolean }).__stitch === true
    );
}

export function isSeam(x: unknown): x is Seam {
    return (
        typeof x === 'object' &&
        x !== null &&
        (x as { __seam?: boolean }).__seam === true
    );
}

// ---- Run identity (ADR 0007) ----------------------------------------------
/**
 * OTLP-aligned identity for one logical call ({@link Stitch} run) and its place in a run
 * tree. The field names are the OpenTelemetry span names verbatim: `traceId` is shared across a
 * whole tree, `spanId` identifies this run, and `parentSpanId` is set when one run spawns another —
 * a `cookieSession` login, a `linked` step. Minted by the engine (`newRunContext`), never supplied
 * by a caller.
 */
export interface RunContext {
    /** 32-hex trace id, shared across every run in a tree (OTel `traceId`). */
    traceId: string;
    /** 16-hex id for this run (OTel `spanId`). */
    spanId: string;
    /** The spawning run's `spanId` (OTel `parentSpanId`); absent for a root run. */
    parentSpanId?: string;
}

/**
 * The per-run metadata a {@link TraceSink} receives alongside every event: the stitch
 * `name` plus the run identity (ADR 0007). The id fields are present for every
 * engine-driven run, but **optional** so a sink fed events by hand (tests, custom
 * pipelines) can still pass just `{ name }`; a sink reading only `ctx.name` is unchanged.
 */
export interface TraceContext {
    name: string;
    spanId?: string;
    traceId?: string;
    parentSpanId?: string;
}

// A trace sink consumes every event a stitch emits.
export interface TraceSink {
    handle(event: StitchEvent, ctx: TraceContext): void;
    flush?(): void | Promise<void>;
}

// A pluggable state store for throttle counters + auth session/token state. Default is
// in-memory (single process). A Redis/Postgres adapter makes throttle distributed and
// sessions persistent/shared across workers — see DESIGN.md §13.
export interface StitchStore {
    get(key: string): Promise<unknown>;
    /** Set a value. `ttl` (ms) is optional on both verbs — absent means no expiry. */
    set(key: string, value: unknown, ttl?: number): Promise<void>;
    /** Atomically increment a counter. Absent `ttl` means no window — the counter never expires. */
    increment(key: string, ttl?: number): Promise<number>;
    /**
     * Atomically reserve the next slot on a shared **pacing cursor** and resolve to the instant
     * reserved (epoch ms). One read-compute-write, indivisible across every process on the store:
     *
     * ```
     * at = max(now, cell ?? 0);   cell = at + spacing;   return at
     * ```
     *
     * This is the GCRA cell (ADR 0024). `increment` can only allocate *positions*; turning a
     * position into a time needs an origin, and any origin a caller can compute is either
     * per-process (so N workers each pace independently) or fixed to a window (so a worker joining
     * mid-window inherits slots that already elapsed). A cursor has neither problem: it carries
     * continuously, it is shared, and `max(now, …)` resets it after idle.
     *
     * **Optional**, and a store is a first-class citizen without it. `createStoreThrottle` falls
     * back to `increment` plus a per-process cursor, which paces each process correctly and lets a
     * fleet drift to N× mid-window (ADR 0023). Two reasons it is not required: an
     * eventually-consistent backend (Cloudflare KV) has no atomic read-compute-write to build it
     * from, and `StitchStore` is a contract **consumers implement**, where adding a required member
     * is a hard break in any channel
     * ([CONTRACT.md P19](../../../docs/CONTRACT.md#p19--the-alias-obligation-is-scoped-to-the-ga-channel)).
     *
     * `now` is the CALLER's clock, not the store's, so the cursor stays deterministic under an
     * injected {@link Clock} (ADR 0010) and a store never needs a clock of its own.
     *
     * **`ttl` refreshes on every call**, unlike {@link StitchStore.increment}'s — whose expiry is
     * bound to the creating increment precisely so a busy fixed window cannot slide forever. The
     * opposite is right here: a cursor is continuous, so letting it lapse mid-pace would reset the
     * schedule and allow the burst it exists to prevent. Absent `ttl` means it never expires.
     * Losing the cell is always *safe* — `max(now, …)` restarts pacing from the present, exactly
     * like a cold start — it just forgets any grants already queued past `now`.
     */
    reserve?(
        key: string,
        spacing: number,
        now: number,
        ttl?: number,
    ): Promise<number>;
    /**
     * Atomically take (or renew) one slot of a **counting semaphore** with `limit` slots, expiring
     * `ttl` ms from `now`. Resolves `true` when this caller holds a slot, `false` when all `limit`
     * are taken by live holders. The fleet-wide half of `throttle.concurrency` (ADR 0025).
     *
     * Semantics, atomically as one step — drop every lease whose expiry is at or before `now`,
     * then:
     *
     * - `token` already held ⇒ **renew** it to `now + ttl` and resolve `true`. Idempotent by
     *   design: a caller that re-leases is extending, never taking a second slot.
     * - otherwise, fewer than `limit` live ⇒ **take** a slot for `token` until `now + ttl`, `true`.
     * - otherwise ⇒ take nothing, `false`. The pruning still persists; a failed attempt must not
     *   leave expired holders in place for the next caller to trip over.
     *
     * **The representation is yours.** This specifies behaviour, not storage: `memoryStore` and
     * `@stitchapi/deno-kv` keep a token→expiry map, `@stitchapi/redis` uses a sorted set, and both
     * satisfy the same rules. `token` is minted by the caller, so it is also the identity
     * {@link StitchStore.release} frees.
     *
     * **Expiry is the whole point, not a fallback.** A holder that crashes, is paused, or loses
     * its network never calls `release`; the lease lapsing is what returns its slot. That is also
     * why the limiter can treat `release` as fire-and-forget: a dropped release costs the fleet one
     * slot for at most `ttl`, rather than forever. The cost of that design is the converse — a
     * caller still working past `ttl` has already lost its slot, so the fleet can briefly exceed
     * `limit`. Size `throttle.lease` above your slowest call.
     *
     * **Optional, and paired** with {@link StitchStore.release} — a store MUST implement both or
     * neither. Without them `concurrency` stays per-process, exactly as it was before ADR 0025.
     * Same two reasons as {@link StitchStore.reserve}: an eventually-consistent backend cannot make
     * this atomic, and a required member on a consumer-implemented contract is a hard break in any
     * channel ([CONTRACT.md P19](../../../docs/CONTRACT.md#p19--the-alias-obligation-is-scoped-to-the-ga-channel)).
     */
    lease?(
        key: string,
        token: string,
        limit: number,
        ttl: number,
        now: number,
    ): Promise<boolean>;
    /**
     * Give back the slot {@link StitchStore.lease} took for `token` — atomically, and idempotent:
     * releasing a token that is not held (already expired, already released) is a no-op, never an
     * error. Paired with `lease`; implement both or neither.
     */
    release?(key: string, token: string): Promise<void>;
    /**
     * Release any resources (connections, timers) the store holds. Optional — the in-memory
     * default clears its map. A seam's `close()` calls this as the last lifecycle step.
     */
    close?(): Promise<void>;
}

// ---- Seam (a primitive stitches belong to) --------------------------------
/**
 * The config a seam shares with every member as a fragment — {@link StitchConfig} minus the keys
 * that are intrinsically **per-endpoint**: the address (`path` / `url` / `method` / `document`)
 * and the request/response shape (`name` / `input` / `output` / `kind`). Everything cross-cutting
 * — `baseUrl`, `headers`, `auth`, `retry`, `throttle`, `timeout`, `circuit`, `idempotency`,
 * `paginate`, `pick`, `transform`, `wire`, `hooks`, `trace`, `store`, `cache`, `adapter`
 * — belongs here, so the type itself answers "what belongs at the seam". Members set the endpoint
 * keys.
 */
export type SeamConfig = Omit<
    StitchConfig,
    | 'path'
    | 'url'
    | 'method'
    | 'document'
    | 'name'
    | 'input'
    | 'output'
    | 'kind'
>;

/**
 * Options for {@link Seam} — the shared {@link SeamConfig} plus an optional hardened `secretStore`
 * backing the vault.
 */
export type SeamOptions = SeamConfig & {
    /**
     * Backend for the vault (auth tokens/sessions). Defaults to a reserved, redacted namespace
     * over the seam's `store`; supply a KMS/Vault-backed store here for a hardened vault. Split
     * is by **visibility**, not backend — both store and vault may be distributed (ADR 0002 §4).
     */
    secretStore?: StitchStore;
};

/**
 * A principal-bound seam handle — what `seam.as(id)` returns, and the object trusted code hands to
 * the least-trusted caller (the agent). It creates member stitches and can re-bind the principal,
 * but deliberately **lacks the shared-runtime levers** (`flush` / `close` / `invalidate`): tearing
 * down, or invalidating the cache of, the runtime every other principal depends on is a *root-seam*
 * authority, never a per-principal one. The boundary that prevents impersonation must not also be a
 * teardown lever (ADR 0002 §2).
 */
export type PrincipalSeam = Omit<
    Seam,
    'as' | 'flush' | 'close' | 'invalidate'
> & {
    /** Re-bind to another principal — last binding wins. Still lifecycle-free. */
    as(principal: string): PrincipalSeam;
};

/**
 * A long-lived entity that owns a shared config fragment, shared runtime (`store` + `vault` +
 * trace sink), a registry of the stitches it created, and a lifecycle. Its decisive job is the
 * **trusted principal boundary**: `seam.as(req.user.id)` binds identity in the closure, so the
 * caller can never name another principal. Create shared surfaces with `seam`; standalone,
 * one-off endpoints stay on the low-level `stitch()` peer (ADR 0002).
 */
export interface Seam {
    /**
     * Create a stitch belonging to this seam — inherits the shared fragment and shares the
     * runtime. Like top-level `stitch`, the result type is inferred from `config.output`; pass an
     * explicit generic (`api.stitch<Foo>(...)`) only to override the inferred type.
     */
    stitch<
        TExplicit = never,
        const C extends Partial<StitchConfig> = Partial<StitchConfig>,
    >(
        config: C &
            NoUnknownConfigKeys<C> &
            NoUnknownNestedKeys<C> &
            MultipartOnlyOnMultipartBody<C> &
            FlagPathInOutput<C> &
            GraphqlOnlyOnGraphqlSurface<C> &
            WireBodyFixedByGraphql<C> &
            RequestShapeFixedByDownload<C>,
    ): Stitch<ResolveOutput<TExplicit, C>, InputOf<C>>;
    /**
     * Non-inferring fallback: a path string or a `string | Partial<StitchConfig>` value (see
     * {@link StitchFn}). `C` is captured only to re-apply the dead-config guards
     * ({@link NoUnknownConfigKeys}, {@link MultipartOnlyOnMultipartBody},
     * {@link GraphqlOnlyOnGraphqlSurface}, {@link WireBodyFixedByGraphql},
     * {@link RequestShapeFixedByDownload}) — see {@link StitchFn}'s fallback for why.
     */
    stitch<
        T = unknown,
        const C extends string | Partial<StitchConfig> =
            string | Partial<StitchConfig>,
    >(
        config: C &
            NoUnknownConfigKeys<C> &
            NoUnknownNestedKeys<C> &
            MultipartOnlyOnMultipartBody<C> &
            FlagPathInOutput<C> &
            GraphqlOnlyOnGraphqlSurface<C> &
            WireBodyFixedByGraphql<C> &
            RequestShapeFixedByDownload<C>,
    ): Stitch<T>;
    /** GraphQL-over-HTTP member stitch (POST `{ query, variables }`, picks `data`). */
    graphql<
        TExplicit = never,
        const C extends Partial<StitchConfig> & {
            document: string;
        } = Partial<StitchConfig> & {
            document: string;
        },
    >(
        config: C &
            NoUnknownConfigKeys<C> &
            NoUnknownNestedKeys<C> &
            MultipartOnlyOnMultipartBody<C> &
            FlagPathInOutput<C> &
            NoWireBodyOnGraphql<C>,
    ): Stitch<ResolveOutput<TExplicit, C>, InputOf<C>>;
    /**
     * Derive a principal-bound {@link PrincipalSeam} reusing the same shared runtime, but whose
     * stitches carry `principal` in their AuthContext: separate sessions per principal, one shared
     * throttle bucket. The principal lives in the returned closure, never in `StitchInput`
     * (ADR 0002 §2–3). The handle is **lifecycle-free** — only the root seam may `flush` / `close`
     * / `invalidate` the shared runtime.
     */
    as(principal: string): PrincipalSeam;
    /**
     * Bulk cache invalidation (ADR 0003) over the shared store this seam owns. With no argument
     * it bumps the **cache-wide** generation (every member stitch's entries become unreachable);
     * pass a member `stitch` to bump just that stitch's generation. A no-op for members without a
     * `cache` block. Exact, single-entry eviction stays on `stitch.invalidate(input)`.
     */
    invalidate(stitch?: Stitch): Promise<void>;
    /** Flush the shared trace sink (drain any buffered exporter). */
    flush(): Promise<void>;
    /** `flush()`, then close the shared store/vault and drop the registry. */
    close(): Promise<void>;
    /** The shared config fragment — redacted (no `store`/`vault`/`auth`/`adapter`). */
    readonly __config: RedactedStitchConfig;
    readonly __seam: true;
}
