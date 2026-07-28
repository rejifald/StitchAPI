// Standard Schema fingerprint strategy for ArkType (StitchAPI ADR 0004).
//
// ArkType exposes a canonical JSON representation of every type on `t.json`. It
// already normalises the parts that matter for structural identity — object keys
// are emitted in a stable order and union branches are pre-sorted — so the bulk
// of the work is reading that surface, then ABSTAINING (returning `token: null`)
// the moment it contains something that can't be soundly captured:
//
//   - morphs (`.pipe`) surface as `morphs: ["$ark.fn10"]` and narrows (`.narrow`)
//     as `predicate: ["$ark.fn12"]`. But ArkType also references its BUILT-IN
//     parsers/predicates the same way — `morphs: ["$ark.parseJson"]` for
//     `string.json.parse`, `morphs: ["$ark.morphs11"]` for `string.numeric.parse`,
//     `predicate: [{ predicate: "$ark.isParsableDate" }]` for `string.date`, and
//     so on. Every such `$ark.<name>` string is opaque (the closure body is
//     invisible) and often non-deterministic (`$ark.fn<n>`/`$ark.morphs<n>` use a
//     global counter, so the number changes per construction). Its presence
//     anywhere forces an abstain — matching the whole `$ark.` namespace, not just
//     the literal `$ark.fn`, so no built-in morph/predicate slips through with a
//     token. (Scope/type aliases use a bare `$<alias>` — e.g. `"$node"` — WITHOUT
//     the `ark.` segment, so pure structural references stay fingerprintable.)
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

// Namespace prefix ArkType uses for EVERY opaque function reference in its JSON:
// user `.pipe` morphs / `.narrow` predicates (`$ark.fn<n>`) AND built-in
// morph/predicate keywords (`$ark.parseJson`, `$ark.morphs<n>`,
// `$ark.isParsableDate`, `$ark.isParsableUrl`, `$ark.isLuhnValid`, …). Any of
// these is opaque and value-transforming, so its presence anywhere in the JSON is
// disqualifying. Matching the prefix (not the exact `$ark.fn`) is deliberately
// broad so no built-in slips through — and it's the SAFE direction: a false
// abstain merely falls back to the version/revalidate ladder. Scope/type aliases
// (`$<alias>`, e.g. `$node`) lack the `ark.` segment, so they are unaffected.
const ARK_REF = '$ark.';

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
        if ((node as string).includes(ARK_REF)) throw ABSTAIN;
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
            if (k.includes(ARK_REF)) throw ABSTAIN;
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
    // Fast disqualifier: any opaque/non-deterministic morph or predicate ref
    // anywhere in the JSON — user `.pipe`/`.narrow` OR a built-in keyword.
    // (canon also catches these, but this keeps the intent obvious.)
    if (JSON.stringify(j).includes(ARK_REF)) throw ABSTAIN;
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
            return { token, strength: 'strong' };
        } catch {
            // ABSTAIN sentinel or any unexpected introspection failure → abstain.
            return { token: null, strength: 'strong' };
        }
    },
};
