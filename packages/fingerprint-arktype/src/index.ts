// Standard Schema fingerprint strategy for ArkType (StitchAPI ADR 0004).
//
// ArkType exposes a canonical JSON representation of every type on `t.json`. It
// already normalises the parts that matter for structural identity — object keys
// are emitted in a stable order and union branches are pre-sorted — so the bulk
// of the work is reading that surface, then ABSTAINING (returning `value: null`)
// the moment it contains something that can't be soundly captured:
//
//   - morphs (`.pipe`) surface as `morphs: ["$ark.fn10"]` and narrows (`.narrow`)
//     as `predicate: ["$ark.fn12"]`. Those `$ark.fn<n>` strings are opaque (the
//     closure body is invisible) AND non-deterministic (a global counter, so the
//     number changes per construction). Either property alone forces an abstain.
//   - a property `default` (e.g. `'string = "x"'`) silently changes the value the
//     cache would store, so trusting a token here would under-invalidate. Abstain.
//
// This is an ALLOWLIST in spirit: only schemas whose JSON is fully deterministic
// and value-preserving get a token; everything else falls back to re-validation.
// A false-negative (same token for different contracts) is the only unsafe outcome,
// so abstaining is always the safe choice.
//
// `arktype` is a PEER dependency and is never imported here — the strategy reads
// the schema instance it is handed via the `~standard`/`.json` surface, so it
// works against whichever ArkType the app ships.
import { type SchemaFingerprinter, hash } from 'stitchapi/fingerprint';

/* eslint-disable @typescript-eslint/no-explicit-any -- foreign untyped internals */

// Thrown the moment a construct can't be soundly captured; caught at the top and
// turned into an abstain. A symbol keeps it distinct from real errors.
const ABSTAIN = Symbol('abstain');

// Non-deterministic + opaque reference emitted by ArkType for `.pipe` morphs and
// `.narrow`/predicate closures. Its presence anywhere in the JSON is disqualifying.
const ARK_FN = '$ark.fn';

type AnyRec = Record<string, unknown>;

// Recursively canonicalise the ArkType JSON into a stable string:
//   - object keys are sorted (defensive — ArkType already orders them, but this
//     guards against any version that doesn't, and over-ordering is always sound);
//   - arrays keep their order (union branches are pre-sorted by ArkType, and
//     tuple `prefix`/`sequence` arrays are ORDER-SIGNIFICANT — reordering them
//     would conflate `[string, number]` with `[number, string]`);
//   - a `default` property triggers an abstain: it changes the stored value, which
//     a cache token must not paper over.
function canon(node: unknown): string {
    if (node === null) return 'null';
    const t = typeof node;
    if (t === 'string') {
        if ((node as string).includes(ARK_FN)) throw ABSTAIN;
        return JSON.stringify(node);
    }
    if (t === 'number' || t === 'boolean') return JSON.stringify(node);
    if (t === 'bigint') return `bi:${(node as bigint).toString()}`;
    // ArkType's JSON never contains functions/undefined/symbols at value
    // positions for representable types — if one appears, we can't capture it.
    if (t !== 'object') throw ABSTAIN;

    if (Array.isArray(node)) {
        return `[${node.map(canon).join(',')}]`;
    }

    const o = node as AnyRec;
    // A property default silently rewrites the validated value → not soundly
    // cacheable. (Appears as e.g. {"default":"x","key":"name","value":"string"}.)
    if ('default' in o) throw ABSTAIN;
    const parts = Object.keys(o)
        .sort()
        .map((k) => {
            if (k.includes(ARK_FN)) throw ABSTAIN;
            return `${JSON.stringify(k)}:${canon(o[k])}`;
        });
    return `{${parts.join(',')}}`;
}

function describe(schema: unknown): string {
    // ArkType type instances are CALLABLE validators, so a schema is `function`
    // (not `object`) — accept both, reject everything else.
    if (!schema || (typeof schema !== 'object' && typeof schema !== 'function'))
        throw ABSTAIN;
    const j = (schema as any).json;
    if (j === undefined) throw ABSTAIN;
    // Fast disqualifier: any opaque/non-deterministic morph or predicate ref.
    // (canon also catches these, but this keeps the intent obvious.)
    if (JSON.stringify(j).includes(ARK_FN)) throw ABSTAIN;
    return canon(j);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Fingerprint strategy for ArkType schemas. Register it once at startup:
 *
 * ```ts
 * import { registerFingerprinter } from 'stitchapi/fingerprint';
 * import { arktypeFingerprinter } from '@stitchapi/fingerprint-arktype';
 * registerFingerprinter(arktypeFingerprinter);
 * ```
 */
export const arktypeFingerprinter: SchemaFingerprinter = {
    vendor: 'arktype',
    supports: '^2.0.0',
    fingerprint(schema) {
        try {
            // `afp1` tags the descriptor format: bump it to force a one-time,
            // safe re-fingerprint if the descriptor scheme ever changes.
            const token = hash(`afp1|${describe(schema)}`);
            return { token, value: token, strength: 'strong' };
        } catch {
            // ABSTAIN sentinel or any unexpected introspection failure → abstain.
            return { token: null, value: null, strength: 'strong' };
        }
    },
};
