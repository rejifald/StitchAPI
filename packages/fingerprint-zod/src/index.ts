// Standard Schema fingerprint strategy for Zod (StitchAPI ADR 0004).
//
// Walks Zod's internal representation — `_def`/`typeName` on Zod 3, `_zod.def`/
// `type` on Zod 4 — building a canonical structural descriptor that is hashed
// into an opaque token. The walker is an ALLOWLIST: it only emits a fingerprint
// for constructs whose validation/shape semantics it fully captures, and ABSTAINS
// (returns `value: null`) on anything else — opaque `.refine`/`.transform`/
// `.default`/custom checks, unrepresentable literals, or any unknown node. Abstain
// is sound: the cache falls back to re-validate-on-hit rather than trust a token
// that might collide across semantically-different schemas.
//
// `zod` is a PEER dependency and is never imported here — the strategy reads the
// schema instance it is handed, so it works against whichever Zod the app ships.
import { type SchemaFingerprinter, hash } from 'stitchapi/fingerprint';

// Thrown the moment a construct can't be soundly captured; caught at the top and
// turned into an abstain. A symbol keeps it distinct from real errors.
const ABSTAIN = Symbol('abstain');

type AnyRec = Record<string, unknown>;
/* eslint-disable @typescript-eslint/no-explicit-any -- foreign untyped internals */

// Canonical JSON for check params / literals: sort keys, encode RegExp/bigint,
// and ABSTAIN on any function value (i.e. opaque logic hiding in a "check").
function stableJson(value: unknown): string {
    const out = JSON.stringify(value, (_k, v: unknown) => {
        if (typeof v === 'function') throw ABSTAIN;
        if (v instanceof RegExp) return `re:${v.source}/${v.flags}`;
        if (typeof v === 'bigint') return `bi:${v.toString()}`;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            const o = v as AnyRec;
            const sorted: AnyRec = {};
            for (const k of Object.keys(o).sort()) sorted[k] = o[k];
            return sorted;
        }
        return v;
    });
    // `undefined`/symbol at the root yields `undefined` from JSON.stringify.
    if (out === undefined) throw ABSTAIN;
    return out;
}

function literal(v: unknown): string {
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean')
        return JSON.stringify(v);
    if (t === 'bigint') return `bi:${(v as bigint).toString()}`;
    throw ABSTAIN;
}

const key = (k: string): string => JSON.stringify(k);

// ---- Zod 3 (`_def` + `typeName`) ------------------------------------------

function v3Checks(checks: unknown): string {
    const arr = (checks as any[] | undefined) ?? [];
    return arr
        .map((c: any) => {
            const rest = { ...(c as AnyRec) };
            delete rest['message']; // error message doesn't change what's valid
            return stableJson(rest);
        })
        .sort()
        .join(',');
}

function v3(def: any): string {
    switch (def.typeName) {
        case 'ZodObject': {
            const shape =
                typeof def.shape === 'function' ? def.shape() : def.shape;
            const fields = Object.keys(shape as AnyRec)
                .sort()
                .map((k) => `${key(k)}:${describe((shape as AnyRec)[k])}`);
            const catchall =
                def.catchall && def.catchall._def?.typeName !== 'ZodNever'
                    ? describe(def.catchall)
                    : '';
            return `obj{${fields.join(',')};unk=${String(def.unknownKeys ?? '')};cat=${catchall}}[${v3Checks(def.checks)}]`;
        }
        case 'ZodString':
            return `str[${v3Checks(def.checks)}${def.coerce ? ';coerce' : ''}]`;
        case 'ZodNumber':
            return `num[${v3Checks(def.checks)}${def.coerce ? ';coerce' : ''}]`;
        case 'ZodBigInt':
            return `bigint[${v3Checks(def.checks)}]`;
        case 'ZodBoolean':
            return `bool${def.coerce ? '[coerce]' : ''}`;
        case 'ZodDate':
            return `date[${v3Checks(def.checks)}]`;
        case 'ZodOptional':
            return `opt(${describe(def.innerType)})[${v3Checks(def.checks)}]`;
        case 'ZodNullable':
            return `nul(${describe(def.innerType)})[${v3Checks(def.checks)}]`;
        case 'ZodArray':
            return `arr(${describe(def.type)})[min=${str(def.minLength)},max=${str(def.maxLength)},exact=${str(def.exactLength)}]`;
        case 'ZodTuple':
            return `tup[${(def.items as unknown[]).map(describe).join(',')}${def.rest ? ';rest=' + describe(def.rest) : ''}][${v3Checks(def.checks)}]`;
        case 'ZodRecord':
            return `rec(${describe(def.keyType)},${describe(def.valueType)})[${v3Checks(def.checks)}]`;
        case 'ZodMap':
            return `map(${describe(def.keyType)},${describe(def.valueType)})[${v3Checks(def.checks)}]`;
        case 'ZodSet':
            return `set(${describe(def.valueType)})[${v3Checks(def.checks)}]`;
        case 'ZodEnum':
            return `enum{${[...(def.values as unknown[])].map(literal).sort().join(',')}}`;
        case 'ZodLiteral':
            return `lit(${literal(def.value)})`;
        case 'ZodUnion':
        case 'ZodDiscriminatedUnion':
            return `union{${(def.options as unknown[]).map(describe).sort().join('|')}}[${v3Checks(def.checks)}]`;
        case 'ZodIntersection':
            return `and(${describe(def.left)},${describe(def.right)})[${v3Checks(def.checks)}]`;
        case 'ZodReadonly':
            return `ro(${describe(def.innerType)})[${v3Checks(def.checks)}]`;
        case 'ZodBranded':
            return `brand(${describe(def.type)})`;
        case 'ZodNull':
            return 'null';
        case 'ZodUndefined':
            return 'undef';
        case 'ZodAny':
            return 'any';
        case 'ZodUnknown':
            return 'unknown';
        case 'ZodNever':
            return 'never';
        case 'ZodVoid':
            return 'void';
        case 'ZodNaN':
            return 'nan';
        // ZodEffects (.refine/.transform/.preprocess), ZodDefault, ZodCatch,
        // ZodPipeline, ZodLazy, ZodPromise, ZodFunction, ZodNativeEnum, … → abstain.
        default:
            throw ABSTAIN;
    }
}

// ---- Zod 4 (`_zod.def` + `type`) ------------------------------------------

function v4Checks(checks: unknown): string {
    const arr = (checks as any[] | undefined) ?? [];
    return arr
        .map((c: any) => {
            const d = c?._zod?.def;
            if (!d) throw ABSTAIN;
            if (d.check === 'custom') throw ABSTAIN; // .refine / custom predicate
            const rest = { ...(d as AnyRec) };
            // Drop noise + the structural checks' `when`/`error` functions; any
            // OTHER function left in `rest` makes stableJson abstain.
            delete rest['when'];
            delete rest['error'];
            delete rest['abort'];
            return stableJson(rest);
        })
        .sort()
        .join(',');
}

// Zod 4 exposes coercion as `def.coerce` on the primitive node (v3 does the
// same). It changes what inputs are accepted — `z.coerce.number()` parses
// `"1"`, `z.number()` rejects it — so it MUST fold into the descriptor, matching
// the v3 branches.
const v4Coerce = (def: any): string => (def.coerce ? ';coerce' : '');

// Zod 4 lifts string formats to their own nodes: `z.email()` is a `string` node
// with `def.format` set (and often `def.pattern`, a RegExp), NOT a check in
// `def.checks`. Reading only `def.checks` collapses `z.email()`/`z.uuid()`/…
// and plain `z.string()` to the same descriptor. Fold both in — the pattern via
// the same RegExp encoding `stableJson` uses, so a chained `z.string().regex(re)`
// and a format that happens to share a source stay comparable.
function v4StringFormat(def: any): string {
    if (def.format == null && def.pattern == null) return '';
    const fmt = def.format == null ? '' : String(def.format);
    const pat =
        def.pattern instanceof RegExp
            ? `re:${def.pattern.source}/${def.pattern.flags}`
            : def.pattern == null
              ? ''
              : stableJson(def.pattern);
    return `;fmt=${fmt};pat=${pat}`;
}

// Canonical members of a Zod 4 enum. `def.entries` is a name→value record, but a
// numeric TS enum is BIDIRECTIONAL (`{0:'Red','Red':0,…}`); the reverse keys must
// be dropped or `Object.values` double-counts. What validation actually gates on
// is the set of accepted VALUES, so encode those — type-preservingly (`literal`,
// not `String`, so `1` and `'1'` differ), which also keeps a string-member enum
// identical to the v3 value-list form (cross-version stability).
function enumMembers(entries: AnyRec): string {
    const reverse = new Set(
        Object.values(entries).filter((v) => typeof v === 'number'),
    );
    const values: unknown[] = [];
    for (const [k, v] of Object.entries(entries)) {
        // Skip the reverse-mapping entry a numeric member adds: a numeric-string
        // key whose value is another member's name.
        if (reverse.has(Number(k)) && typeof v === 'string' && v in entries)
            continue;
        values.push(v);
    }
    return values.map(literal).sort().join(',');
}

function v4(def: any): string {
    switch (def.type) {
        case 'object': {
            const shape = def.shape as AnyRec;
            const fields = Object.keys(shape)
                .sort()
                .map((k) => `${key(k)}:${describe(shape[k])}`);
            const catchall = def.catchall ? describe(def.catchall) : '';
            return `obj{${fields.join(',')};cat=${catchall}}[${v4Checks(def.checks)}]`;
        }
        case 'string':
            return `str[${v4Checks(def.checks)}${v4StringFormat(def)}${v4Coerce(def)}]`;
        case 'number':
            return `num[${v4Checks(def.checks)}${v4Coerce(def)}]`;
        case 'bigint':
            return `bigint[${v4Checks(def.checks)}${v4Coerce(def)}]`;
        case 'boolean':
            return `bool[${v4Checks(def.checks)}${v4Coerce(def)}]`;
        case 'date':
            return `date[${v4Checks(def.checks)}${v4Coerce(def)}]`;
        case 'optional':
            return `opt(${describe(def.innerType)})[${v4Checks(def.checks)}]`;
        case 'nullable':
            return `nul(${describe(def.innerType)})[${v4Checks(def.checks)}]`;
        case 'nonoptional':
            return `req(${describe(def.innerType)})[${v4Checks(def.checks)}]`;
        case 'array':
            return `arr(${describe(def.element)})[${v4Checks(def.checks)}]`;
        case 'tuple':
            return `tup[${(def.items as unknown[]).map(describe).join(',')}${def.rest ? ';rest=' + describe(def.rest) : ''}][${v4Checks(def.checks)}]`;
        case 'record':
            return `rec(${describe(def.keyType)},${describe(def.valueType)})[${v4Checks(def.checks)}]`;
        case 'map':
            return `map(${describe(def.keyType)},${describe(def.valueType)})[${v4Checks(def.checks)}]`;
        case 'set':
            return `set(${describe(def.valueType)})[${v4Checks(def.checks)}]`;
        case 'enum':
            return `enum{${enumMembers(def.entries as AnyRec)}}`;
        case 'literal':
            return `lit{${(def.values as unknown[]).map(literal).sort().join('|')}}[${v4Checks(def.checks)}]`;
        case 'union':
            return `union{${(def.options as unknown[]).map(describe).sort().join('|')}}[${v4Checks(def.checks)}]`;
        case 'intersection':
            return `and(${describe(def.left)},${describe(def.right)})[${v4Checks(def.checks)}]`;
        case 'readonly':
            return `ro(${describe(def.innerType)})[${v4Checks(def.checks)}]`;
        case 'null':
            return 'null';
        case 'undefined':
            return 'undef';
        case 'any':
            return 'any';
        case 'unknown':
            return 'unknown';
        case 'never':
            return 'never';
        case 'void':
            return 'void';
        case 'nan':
            return 'nan';
        // 'pipe' (.transform), 'default', 'prefault', 'catch', 'lazy', 'promise',
        // 'custom', 'transform', 'success', 'template_literal', … → abstain.
        default:
            throw ABSTAIN;
    }
}

const str = (x: unknown): string => (x == null ? '' : String(x));

function describe(schema: unknown): string {
    if (!schema || typeof schema !== 'object') throw ABSTAIN;
    const s = schema as any;
    if (s._zod?.def) return v4(s._zod.def);
    if (s._def) return v3(s._def);
    throw ABSTAIN;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Fingerprint strategy for Zod schemas. Register it once at startup:
 *
 * ```ts
 * import { registerFingerprinter } from 'stitchapi/fingerprint';
 * import { zodFingerprinter } from '@stitchapi/fingerprint-zod';
 * registerFingerprinter(zodFingerprinter);
 * ```
 */
export const zodFingerprinter: SchemaFingerprinter = {
    vendor: 'zod',
    supports: '^3.24.0 || ^4.0.0',
    fingerprint(schema) {
        try {
            // `zfp1` tags the descriptor format: bump it to force a one-time,
            // safe re-fingerprint if the descriptor scheme ever changes.
            const token = hash(`zfp1|${describe(schema)}`);
            return { token, value: token, strength: 'strong' };
        } catch {
            // ABSTAIN sentinel or any unexpected introspection failure → abstain.
            return { token: null, value: null, strength: 'strong' };
        }
    },
};
