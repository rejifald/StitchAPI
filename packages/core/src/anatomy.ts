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
import type { StitchConfig } from './types';

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
}

/**
 * Every slot of {@link StitchConfig}, described once. The two asserts below make this list and
 * `StitchConfig` provably the same set — add a slot to one and the other fails to compile.
 */
export interface Anatomy {
    name: object;
    kind: { dropped: 'redact'; project: true };
    method: object;
    bodyType: object;
    multipart: { shorthand: 'nesting' };
    stream: { shorthand: 'decode' };
    sse: { toggle: true };
    responseType: object;
    url: { dropped: 'redact-if-fn' };
    baseUrl: { dropped: 'redact-if-fn' };
    path: object;
    headers: object;
    document: object;
    operationName: object;
    input: object;
    output: { stage: 7 };
    pick: { stage: 6 };
    transform: { dropped: 'redact' };
    paginate: { fns: true; stage: 5 };
    auth: { dropped: 'redact'; project: true };
    retry: { shorthand: 'attempts'; fns: true; stage: 3; policy: true };
    acceptStatus: { dropped: 'redact-if-fn' };
    throttle: { shorthand: 'rate'; fns: true; stage: 1; policy: true };
    timeout: { shorthand: 'total'; policy: true };
    circuit: object;
    idempotency: { toggle: true; fns: true };
    cache: { shorthand: 'ttl'; fns: true; stage: 8; policy: true };
    sensitive: object;
    arrayFormat: object;
    hooks: { dropped: 'redact' };
    extends: { dropped: 'compose' };
    adapter: { dropped: 'redact' };
    clock: { dropped: 'redact' };
    store: { dropped: 'redact' };
    trace: { dropped: 'redact' };
}

type Undescribed = Exclude<keyof StitchConfig, keyof Anatomy>;
type Phantom = Exclude<keyof Anatomy, keyof StitchConfig>;

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
    Anatomy extends Record<keyof Anatomy, SlotFacts> ? true : false
>;

type SlotsWhere<F> = {
    [K in keyof Anatomy]: Anatomy[K] extends F ? K : never;
}[keyof Anatomy];

/** Slots carrying author closures at depth 1 — fn-stripped on the way to `__config` (P0). */
export type FnBearingSlot = SlotsWhere<{ fns: true }>;
/** Slots never present on the public `__config`. */
export type RedactedSlot = SlotsWhere<{ dropped: 'redact' }>;
/** Slots whose DATA form survives redaction and whose function form does not. */
export type RedactedIfFnSlot = SlotsWhere<{ dropped: 'redact-if-fn' }>;
/** Slots re-projected onto `__config` as plain data rather than simply removed. */
export type ProjectedSlot = SlotsWhere<{ project: true }>;
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
        at: Anatomy[K] extends { stage: infer At } ? At : never;
        label: (cfg: Cfg, detailed: boolean) => string;
    };
}[StagedSlot];
/** Slots with a scalar shorthand, paired with the field it folds into. */
export type ShorthandPair = {
    [K in SlotsWhere<{ shorthand: string }>]: Anatomy[K] extends {
        shorthand: infer Field;
    }
        ? readonly [K, Field]
        : never;
}[SlotsWhere<{ shorthand: string }>];

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
