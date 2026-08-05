// Standard Schema fingerprint strategy for TypeBox (StitchAPI ADR 0004).
//
// A TypeBox schema IS a plain JSON Schema object: `Type.Object({ id: Type.Number(),
// name: Type.String({ minLength: 2 }) })` is literally
// `{ type: 'object', required: ['id', 'name'], properties: { id: { type: 'number' },
// name: { minLength: 2, type: 'string' } } }` plus a `Symbol(TypeBox.Kind)` marker.
// So the descriptor is a canonical stringify of that JSON Schema with recursively
// SORTED keys — two schemas with the same JSON Schema (modulo key order) hash equal.
//
// The walker is an ALLOWLIST. JSON.stringify silently ignores symbols, so the
// opaque parts of a schema are INVISIBLE to a naive stringify: a
// `Type.Transform(Type.String())...` serialises to exactly `{ type: 'string' }`,
// indistinguishable from a plain string. We therefore walk every nested node and
// ABSTAIN (return `token: null`) the moment we hit a part we cannot soundly
// capture: a transform codec (detected by `Symbol(TypeBox.Transform)`), an opaque
// Kind (`Function`/`Constructor`/`Unsafe`/`Undefined`/`Void`), or a node that
// carries no JSON-Schema discriminator at all (`Any`/`Unknown`/`Unsafe`, which all
// serialise to `{}`). Abstaining is always sound — the cache falls back to
// re-validate-on-hit rather than trust a token that might collide across
// semantically-different schemas. A false negative (same token, different contract)
// would be a correctness bug; coverage is the thing we trade away, never soundness.
//
// `@sinclair/typebox` is a PEER dependency and is never imported here — the
// strategy reads the schema instance it is handed, so it works against whichever
// TypeBox the app ships.
//
// NOTE: TypeBox 0.34 schemas do NOT expose `~standard` — they are plain JSON
// Schema objects keyed by `Symbol(TypeBox.Kind)`. For the registry to dispatch a
// TypeBox schema to this strategy, the schema must be surfaced as a Standard Schema
// with `~standard.vendor === 'typebox'` (via a thin wrapper today, or a future
// TypeBox release). The fingerprint LOGIC below is what this package proves; the
// conformance test attaches a minimal `~standard` to each fixture to exercise it.
import { type SchemaFingerprinter, hash } from 'stitchapi/fingerprint';

// Thrown the moment a construct can't be soundly captured; caught at the top and
// turned into an abstain. A symbol keeps it distinct from real errors.
const ABSTAIN = Symbol('abstain');

const KIND = Symbol.for('TypeBox.Kind');
const TRANSFORM = Symbol.for('TypeBox.Transform');

// Kinds whose JSON Schema does NOT soundly capture their validation semantics:
//  - Function/Constructor: `{ type: 'Function'|'Constructor', ... }` is not real
//    JSON Schema; the callable contract isn't structurally hashable.
//  - Unsafe: an escape hatch — arbitrary opaque shape.
//  - Undefined/Void: validate `undefined`/nothing; not a cache-relevant shape and
//    `Undefined` even serialises to a non-standard `{ type: 'undefined' }`.
const OPAQUE_KINDS = new Set([
    'Function',
    'Constructor',
    'Unsafe',
    'Undefined',
    'Void',
]);

// A node must carry at least one JSON-Schema discriminator to be representable.
// `Any`/`Unknown`/`Unsafe` all serialise to `{}` (none of these present) → abstain.
const DISCRIMINATORS = ['type', 'enum', '$ref', 'anyOf', 'allOf', 'const'];

type AnyRec = Record<string, unknown>;

// True for a TypeBox *schema node* — an object marked with `Symbol(TypeBox.Kind)`.
// Nested schema nodes (object properties, array items, union members, …) all carry
// it, so this is how we find every node that must be soundness-checked.
function isSchemaNode(value: unknown): value is AnyRec {
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as AnyRec)[KIND as unknown as string] !== undefined
    );
}

// Soundness gate for a single schema node. Throws ABSTAIN on anything we can't
// fully capture; returns normally when the node is representable.
function assertRepresentable(node: AnyRec): void {
    // A transform attaches an opaque Decode/Encode codec that is INVISIBLE to
    // JSON.stringify — its presence changes the parsed value without changing the
    // serialised JSON Schema, so it must abstain.
    if (node[TRANSFORM as unknown as string] !== undefined) {
        throw ABSTAIN;
    }
    const kind = node[KIND as unknown as string];
    if (typeof kind === 'string' && OPAQUE_KINDS.has(kind)) throw ABSTAIN;
    // No JSON-Schema discriminator → nothing structural to hash (Any/Unknown/Unsafe).
    if (!DISCRIMINATORS.some((d) => d in node)) throw ABSTAIN;
}

// Build a canonical descriptor by recursively walking `value` with SORTED object
// keys. Strips the synthetic `~standard` wrapper (see file header) so it never
// pollutes the fingerprint, and soundness-checks every TypeBox schema node it
// passes through — so a transform nested arbitrarily deep is still caught.
function describe(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) {
        return `[${value.map(describe).join(',')}]`;
    }
    if (typeof value === 'object') {
        // A function leaking into the JSON Schema (e.g. a custom keyword value) is
        // opaque logic we can't hash — abstain.
        if (typeof value === 'function') throw ABSTAIN;
        if (isSchemaNode(value)) assertRepresentable(value);
        const rec = value as AnyRec;
        const parts: string[] = [];
        for (const k of Object.keys(rec).sort()) {
            // `~standard` is the test/registry wrapper, not part of the contract.
            if (k === '~standard') continue;
            // `required` is a JSON-Schema SET keyword: its order follows property
            // declaration order, which is NOT semantic, so canonicalise by sorting.
            // (Order-significant arrays like tuple `items` are left untouched.)
            if (
                k === 'required' &&
                Array.isArray(rec[k]) &&
                (rec[k] as unknown[]).every((e) => typeof e === 'string')
            ) {
                const sorted = [...(rec[k] as string[])].sort();
                parts.push(`${JSON.stringify(k)}:${describe(sorted)}`);
                continue;
            }
            parts.push(`${JSON.stringify(k)}:${describe(rec[k])}`);
        }
        return `{${parts.join(',')}}`;
    }
    if (typeof value === 'function') throw ABSTAIN;
    if (typeof value === 'bigint') return `bi:${value.toString()}`;
    // string | number | boolean → JSON-encoded scalar.
    return JSON.stringify(value);
}

// Top-level: the handed schema must itself be a TypeBox schema node.
function describeRoot(schema: unknown): string {
    if (!isSchemaNode(schema)) throw ABSTAIN;
    return describe(schema);
}

/**
 * Fingerprint strategy for TypeBox schemas. Register it once at startup:
 *
 * ```ts
 * import { registerFingerprinter } from 'stitchapi/fingerprint';
 * import { typeboxFingerprinter } from '@stitchapi/fingerprint-typebox';
 * registerFingerprinter(typeboxFingerprinter);
 * ```
 */
export const typeboxFingerprinter: SchemaFingerprinter = {
    vendor: 'typebox',
    range: '^0.34.0',
    fingerprint(schema) {
        try {
            // `tbfp1` tags the descriptor format: bump it to force a one-time,
            // safe re-fingerprint if the descriptor scheme ever changes.
            const token = hash(`tbfp1|${describeRoot(schema)}`);
            return { token, strength: 'strong' };
        } catch {
            // ABSTAIN sentinel or any unexpected introspection failure → abstain.
            return { token: null, strength: 'strong' };
        }
    },
};
