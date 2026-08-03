// The ANATOMY of a stitch config: one description of what each slot IS, from which the operations
// that walk the config derive their key lists instead of restating them.
//
// Before this, the same closed set of slot names was written out by hand in seven places —
// `expandShorthand`'s envelope folds, `redactConfig`'s drop-list and its fn-strip tail,
// `RedactedStitchConfig`'s `Omit`, `pipelineStages`, the `mcp` policy read-out, and the P0 test
// fixture — and no two agreed. Nothing forced them to: adding a slot compiled fine with six of the
// seven left stale, which is how a live `TraceSink` reached the public `__config`.
//
// This module is TYPE-ONLY BY CONSTRUCTION. It emits no runtime value, so the lean
// `import { stitch }` entry pays nothing for facts only the cold consumers (`diagram`, `mcp`,
// `export --openapi`) care about. The runtime key lists stay hand-written where they are used, but
// each is now checked against the anatomy with `satisfies` (a WRONG entry) plus a coverage assert
// (a MISSING entry), so a stale list is a compile error naming the slot it forgot.
import type {
    CircuitOptions,
    Hooks,
    IdempotencyOptions,
    InputSchemas,
    ResolvedCacheOptions,
    ResolvedStreamOptions,
    ResolvedWireOptions,
    RetryOptions,
    SseOptions,
    StitchConfig,
    ThrottleOptions,
    TimeoutOptions,
} from './types';

/** Fail to compile unless `T` is exactly `true`; the failing type shows the offending slot name. */
export type Assert<T extends true> = T;

/**
 * What one config slot is. Every fact is optional — a plain data slot (`name`, `method`, `headers`)
 * carries none and is simply kept, verbatim, everywhere.
 */
interface SlotFacts {
    /**
     * The dominant field a scalar shorthand folds into (CONTRACT.md P12/P14): `retry: 3` becomes
     * `{ attempts: 3 }`. Read by `expandShorthand`'s `envelope` walk.
     */
    shorthand?: string;
    /**
     * A boolean toggle rather than a scalar envelope (P13/P20): `true` means "on with defaults",
     * `false` removes the slot. Normalised alongside the shorthands but not by `envelope`.
     */
    toggle?: true;
    /**
     * Carries author closures at depth 1 — a derivation fn or predicate that must be stripped before
     * the slot reaches the public `__config` (CONTRACT.md P0). Read by `redactConfig`'s fn-strip and
     * by the P0 regression fixture, so a new fn-bearing slot cannot pass the test by omission.
     */
    fns?: true;
    /**
     * When and how the slot leaves the public view.
     * - `'redact'` — never on `__config`: a live handle (`store`/`adapter`/`clock`/`trace`), an
     *   always-fn (`transform`/`hooks`), or re-projected as data (`kind`/`auth`).
     * - `'redact-if-fn'` — a data-or-handle slot: the data form survives, the function form is
     *   dropped (a string `url`, a `number[]` `acceptStatus`).
     * - `'compose'` — consumed earlier, by `flatten`, and never reaches a resolved config at all.
     */
    dropped?: 'redact' | 'redact-if-fn' | 'compose';
    /** A non-secret projection replaces it on `__config` (`kind` → its id, `auth` → `authScheme`). */
    project?: true;
    /**
     * Position in the pipeline read-out shared by `stitch diagram` and the `mcp` teaching list.
     * One shared number line, in ENGINE order, so the read-out matches what actually runs — the
     * positions `config-summary` fills unconditionally are 0 `call`, 2 the endpoint label, 4 the
     * surface's `interpret`, and 9 `result`; the rest are slots and appear only when configured.
     */
    stage?: number;
    /** Reported as a configured/not-configured flag in the `mcp` `policies` summary. */
    policy?: true;
    /**
     * `compose` rewrites this slot, so `ResolvedStitchConfig` re-declares it in its normalised form
     * rather than inheriting the loose authoring union. Only needed for slots normalised by
     * something OTHER than the shorthand/toggle folds — `hooks` (chained into one), `input` (each
     * schema through `toValidator`) and `circuit` (the positional `[failures, cooldown]` tuple
     * spread into its named fields); every `shorthand`/`toggle` slot is normalised by definition
     * and counts automatically. See {@link NormalizedSlot}.
     */
    normalized?: true;
    /**
     * Holds a Standard Schema validator, whose `validate` sits at depth 2 — the ONE documented
     * exception to P0's "no functions on `__config`" (CONTRACT.md P0). It is not sugar: `toOpenApi`
     * reads these schemas off `__config` to build its parameter and response shapes, so stripping
     * the validator would break `export --openapi` outright, and a schema is not reconstructible
     * from its fn-free husk the way a `retry` envelope is. The slot is therefore kept whole and the
     * exemption is stated rather than discovered. See {@link SchemaSlot}.
     */
    carriesSchema?: true;
}

/**
 * Every slot of {@link StitchConfig}, described once. The two asserts below make this list and
 * `StitchConfig` provably the same set — add a slot to one and the other fails to compile.
 */
export interface StitchConfigAnatomy {
    name: object;
    kind: { dropped: 'redact'; project: true };
    method: object;
    // One slot for every wire-format choice (body encoding, response decoding, urlencoded array
    // serialisation, multipart nesting). `wire.multipart`'s scalar shorthand folds NESTED, like
    // `retry.backoff` — not at the top level — so `wire` declares no `shorthand` of its own but is
    // still `normalized`, and `ResolvedWireOptions` re-declares it with `multipart` in object form.
    wire: { normalized: true };
    stream: { shorthand: 'decode' };
    sse: { toggle: true };
    url: { dropped: 'redact-if-fn' };
    baseUrl: { dropped: 'redact-if-fn' };
    path: object;
    headers: object;
    document: object;
    operationName: object;
    input: { normalized: true; carriesSchema: true };
    output: { stage: 7; carriesSchema: true };
    pick: { stage: 6 };
    transform: { dropped: 'redact' };
    paginate: { fns: true; stage: 5 };
    auth: { dropped: 'redact'; project: true };
    retry: { shorthand: 'attempts'; fns: true; stage: 3; policy: true };
    acceptStatus: { dropped: 'redact-if-fn' };
    throttle: { shorthand: 'rate'; fns: true; stage: 1; policy: true };
    timeout: { shorthand: 'total'; policy: true };
    circuit: { normalized: true };
    idempotency: { toggle: true; fns: true };
    cache: { shorthand: 'ttl'; fns: true; stage: 8; policy: true };
    sensitive: object;
    hooks: { dropped: 'redact'; normalized: true };
    extends: { dropped: 'compose' };
    adapter: { dropped: 'redact' };
    clock: { dropped: 'redact' };
    store: { dropped: 'redact' };
    trace: { dropped: 'redact' };
}

type Undescribed = Exclude<keyof StitchConfig, keyof StitchConfigAnatomy>;
type Phantom = Exclude<keyof StitchConfigAnatomy, keyof StitchConfig>;

/** A slot exists on `StitchConfig` but the anatomy says nothing about it. */
export type _EverySlotDescribed = Assert<
    [Undescribed] extends [never]
        ? true
        : ['slot missing from the anatomy:', Undescribed]
>;
/** The anatomy describes a slot that `StitchConfig` no longer has. */
export type _NoPhantomSlots = Assert<
    [Phantom] extends [never]
        ? true
        : ['anatomy describes a slot that does not exist:', Phantom]
>;
/** Every declared fact is a real fact (a typo'd key is a compile error, not a silently-ignored one). */
export type _FactsWellFormed = Assert<
    StitchConfigAnatomy extends Record<keyof StitchConfigAnatomy, SlotFacts>
        ? true
        : false
>;

type SlotsWhere<F> = {
    [K in keyof StitchConfigAnatomy]: StitchConfigAnatomy[K] extends F
        ? K
        : never;
}[keyof StitchConfigAnatomy];

/** Slots carrying author closures at depth 1 — fn-stripped on the way to `__config` (P0). */
export type FnBearingSlot = SlotsWhere<{ fns: true }>;
/** Slots never present on the public `__config`. */
export type RedactedSlot = SlotsWhere<{ dropped: 'redact' }>;
/** Slots whose DATA form survives redaction and whose function form does not. */
export type RedactedIfFnSlot = SlotsWhere<{ dropped: 'redact-if-fn' }>;
/** Slots re-projected onto `__config` as plain data rather than simply removed. */
export type ProjectedSlot = SlotsWhere<{ project: true }>;
/**
 * Slots holding a Standard Schema validator — P0's single documented exemption. Every OTHER slot on
 * `__config` is fn-free; these two carry `validate` at depth 2 by design.
 */
export type SchemaSlot = SlotsWhere<{ carriesSchema: true }>;
/** Slots whose scalar shorthand folds into a dominant field. */
export type ShorthandSlot = SlotsWhere<{ shorthand: string }>;
/** Slots whose `true`/`false` toggle normalises to the object form (or removal). */
export type ToggleSlot = SlotsWhere<{ toggle: true }>;
/**
 * Slots `compose` rewrites, and therefore exactly the slots `ResolvedStitchConfig` must re-declare
 * in their normalised form. A shorthand or toggle slot qualifies BY DEFINITION — `expandShorthand`
 * rewrites it — so adding one to the anatomy widens this union automatically, and forgetting to
 * re-declare it becomes a compile error instead of a resolved type that still admits the scalar.
 */
export type NormalizedSlot =
    ShorthandSlot | ToggleSlot | SlotsWhere<{ normalized: true }>;
/** Slots reported as configured/not in the `mcp` `policies` summary. */
export type PolicySlot = SlotsWhere<{ policy: true }>;
/** Slots that appear in the pipeline read-out. */
export type StagedSlot = SlotsWhere<{ stage: number }>;
/**
 * One entry of the pipeline read-out table: the slot, its anatomy-declared position (a mismatch is
 * a compile error, so the order lives in exactly one place), and how to render it. `detailed` is the
 * diagram view, which annotates counts; the terse default names the stage only.
 */
export type StageEntry<Cfg> = {
    [K in StagedSlot]: {
        slot: K;
        at: StitchConfigAnatomy[K] extends { stage: infer At } ? At : never;
        label: (cfg: Cfg, detailed: boolean) => string;
    };
}[StagedSlot];
/** Slots with a scalar shorthand, paired with the field it folds into. */
export type ShorthandPair = {
    [K in ShorthandSlot]: StitchConfigAnatomy[K] extends {
        shorthand: infer Field;
    }
        ? readonly [K, Field]
        : never;
}[ShorthandSlot];

/**
 * Assert a hand-written key list covers every slot the anatomy marks. `satisfies` already rejects a
 * WRONG entry; this catches a MISSING one and names it. Use as
 * `type _ = Covers<FnBearingSlot, typeof FN_BEARING_SLOTS>`.
 */
export type Covers<Expected extends PropertyKey, Listed extends PropertyKey> = [
    Exclude<Expected, Listed>,
] extends [never]
    ? true
    : ['list is missing slot(s):', Exclude<Expected, Listed>];

/**
 * What each {@link NormalizedSlot} looks like AFTER `compose` has rewritten it — the object half of
 * `ResolvedStitchConfig`. It lives here, beside the anatomy that decides which slots are normalised,
 * so the two halves cannot drift: `_ResolvedRedeclaresEveryNormalizedSlot` holds the key sets equal,
 * and a new shorthand/toggle slot fails here until it is re-declared.
 */
export interface ResolvedNormalizations {
    retry?: RetryOptions;
    timeout?: TimeoutOptions;
    cache?: ResolvedCacheOptions;
    idempotency?: IdempotencyOptions;
    throttle?: ThrottleOptions;
    circuit?: CircuitOptions;
    stream?: ResolvedStreamOptions;
    wire?: ResolvedWireOptions;
    sse?: SseOptions;
    hooks?: Hooks;
    input?: InputSchemas;
}
export type _ResolvedRedeclaresEveryNormalizedSlot = Assert<
    Covers<NormalizedSlot, keyof ResolvedNormalizations>
>;
