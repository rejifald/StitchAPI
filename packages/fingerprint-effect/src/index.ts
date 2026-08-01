// Standard Schema fingerprint strategy for Effect Schema (StitchAPI ADR 0004).
//
// A raw Effect schema (`S.Struct(...)`) is NOT a Standard Schema — users wrap it
// with `S.standardSchemaV1(schema)`, and THAT object both carries `~standard`
// (vendor `'effect'`) and keeps the underlying `.ast`. So this strategy reads
// `(schema as any).ast` and walks Effect's AST by its `_tag`, building a canonical
// structural descriptor that is hashed into an opaque token.
//
// The walker is an ALLOWLIST: it only emits a fingerprint for AST nodes whose
// validation/shape semantics it fully captures, and ABSTAINS (returns
// `token: null`) on anything else — `Transformation` (`.transform`/applied
// defaults), `Refinement` (an opaque predicate), `Suspend` (lazy/recursive),
// `Declaration`, or any unknown `_tag`. Abstain is sound: the cache falls back to
// re-validate-on-hit rather than trust a token that might collide across
// semantically-different schemas. Soundness beats coverage.
//
// `effect` is a PEER dependency and is never imported here — the strategy reads
// the schema instance it is handed, so it works against whichever Effect the app
// ships.
import { type SchemaFingerprinter, hash } from 'stitchapi/fingerprint';

// Thrown the moment a construct can't be soundly captured; caught at the top and
// turned into an abstain. A symbol keeps it distinct from real errors.
const ABSTAIN = Symbol('abstain');

/* foreign untyped internals — `any` casts are intentional throughout. */
type AnyAst = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const key = (k: string): string => JSON.stringify(String(k));

// Canonical encoding of a `Literal` AST node's value. Effect literals are
// string/number/boolean/bigint/null; anything else (e.g. a symbol) abstains.
function literal(node: AnyAst): string {
    const v: unknown = node.literal;
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean')
        return JSON.stringify(v);
    if (t === 'bigint') return `bi:${(v as bigint).toString()}`;
    throw ABSTAIN;
}

// Walk one AST node into a canonical descriptor string. Recursion bottoms out on
// keyword leaves; composite nodes sort their children so construction order /
// key order never affects the fingerprint.
function describeAst(ast: AnyAst): string {
    if (!ast || typeof ast !== 'object' || typeof ast._tag !== 'string')
        throw ABSTAIN;

    switch (ast._tag) {
        // ---- object / record ------------------------------------------------
        case 'TypeLiteral': {
            const props =
                (ast.propertySignatures as AnyAst[] | undefined) ?? [];
            const fields = props
                .map(
                    (p) =>
                        `${key(p.name)}:${p.isOptional ? '?' : ''}${describeAst(
                            p.type,
                        )}`,
                )
                .sort();
            // Index signatures (Record) — sorted so order is irrelevant. These
            // must be captured so a Record is never confused with an empty/other
            // struct: `S.Record({key,value})` has no propertySignatures.
            const idx = ((ast.indexSignatures as AnyAst[] | undefined) ?? [])
                .map(
                    (s) =>
                        `${describeAst(s.parameter)}=>${describeAst(s.type)}`,
                )
                .sort();
            return `obj{${fields.join(',')};idx[${idx.join(',')}]}`;
        }

        // ---- keyword leaves -------------------------------------------------
        case 'StringKeyword':
            return 'str';
        case 'NumberKeyword':
            return 'num';
        case 'BooleanKeyword':
            return 'bool';
        case 'BigIntKeyword':
            return 'bigint';
        case 'SymbolKeyword':
            return 'symbol';
        case 'UndefinedKeyword':
            return 'undef';
        case 'VoidKeyword':
            return 'void';
        case 'UnknownKeyword':
            return 'unknown';
        case 'AnyKeyword':
            return 'any';
        case 'ObjectKeyword':
            return 'object';
        case 'NeverKeyword':
            return 'never';

        // ---- literals -------------------------------------------------------
        case 'Literal':
            return `lit(${literal(ast)})`;

        // ---- composites -----------------------------------------------------
        case 'Union': {
            const members = (ast.types as AnyAst[]).map(describeAst).sort();
            return `union{${members.join('|')}}`;
        }
        case 'TupleType': {
            // `S.Tuple` → elements only; `S.Array` → rest only; both land here.
            const elements = (ast.elements as AnyAst[] | undefined) ?? [];
            const els = elements
                .map((e) => `${e.isOptional ? '?' : ''}${describeAst(e.type)}`)
                .join(',');
            const rest = ((ast.rest as AnyAst[] | undefined) ?? [])
                .map((r) => describeAst(r.type))
                .join(',');
            return `tup[${els};rest=${rest}]`;
        }
        case 'Enums': {
            // `enums` is an array of `[name, value]` pairs.
            const pairs = (ast.enums as [string, string | number][])
                .map(([k, v]) => `${key(k)}=${JSON.stringify(v)}`)
                .sort();
            return `enum{${pairs.join(',')}}`;
        }

        // ---- abstain --------------------------------------------------------
        // Transformation (.transform / applied defaults), Refinement (opaque
        // predicate), Suspend (lazy/recursive), Declaration (opaque custom),
        // UniqueSymbol, and any unknown tag → not soundly capturable.
        default:
            throw ABSTAIN;
    }
}

/**
 * Fingerprint strategy for Effect Schema. The schema handed in must be the
 * Standard Schema produced by `S.standardSchemaV1(...)` (it carries both
 * `~standard.vendor === 'effect'` and the underlying `.ast`). Register it once at
 * startup:
 *
 * ```ts
 * import { registerFingerprinter } from 'stitchapi/fingerprint';
 * import { effectFingerprinter } from '@stitchapi/fingerprint-effect';
 * registerFingerprinter(effectFingerprinter);
 * ```
 */
export const effectFingerprinter: SchemaFingerprinter = {
    vendor: 'effect',
    range: '^3.0.0',
    fingerprint(schema) {
        try {
            const ast = (schema as { ast?: unknown }).ast;
            if (!ast) throw ABSTAIN;
            // `efp1` tags the descriptor format: bump it to force a one-time,
            // safe re-fingerprint if the descriptor scheme ever changes.
            const token = hash(`efp1|${describeAst(ast)}`);
            return { token, strength: 'strong' };
        } catch {
            // ABSTAIN sentinel or any unexpected introspection failure → abstain.
            return { token: null, strength: 'strong' };
        }
    },
};
