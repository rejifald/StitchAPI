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
            return `obj{${fields.join(',')};unk=${String(def.unknownKeys ?? '')};cat=${catchall}}`;
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
            return `opt(${describe(def.innerType)})`;
        case 'ZodNullable':
            return `nul(${describe(def.innerType)})`;
        case 'ZodArray':
            return `arr(${describe(def.type)})[min=${str(def.minLength)},max=${str(def.maxLength)},exact=${str(def.exactLength)}]`;
        case 'ZodTuple':
            return `tup[${(def.items as unknown[]).map(describe).join(',')}${def.rest ? ';rest=' + describe(def.rest) : ''}]`;
        case 'ZodRecord':
            return `rec(${describe(def.keyType)},${describe(def.valueType)})`;
        case 'ZodMap':
            return `map(${describe(def.keyType)},${describe(def.valueType)})`;
        case 'ZodSet':
            return `set(${describe(def.valueType)})`;
        case 'ZodEnum':
            return `enum{${[...(def.values as unknown[])].map(String).sort().map(key).join(',')}}`;
        case 'ZodLiteral':
            return `lit(${literal(def.value)})`;
        case 'ZodUnion':
        case 'ZodDiscriminatedUnion':
            return `union{${(def.options as unknown[]).map(describe).sort().join('|')}}`;
        case 'ZodIntersection':
            return `and(${describe(def.left)},${describe(def.right)})`;
        case 'ZodReadonly':
            return `ro(${describe(def.innerType)})`;
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

function v4(def: any): string {
    switch (def.type) {
        case 'object': {
            const shape = def.shape as AnyRec;
            const fields = Object.keys(shape)
                .sort()
                .map((k) => `${key(k)}:${describe(shape[k])}`);
            const catchall = def.catchall ? describe(def.catchall) : '';
            return `obj{${fields.join(',')};cat=${catchall}}`;
        }
        case 'string':
            return `str[${v4Checks(def.checks)}]`;
        case 'number':
            return `num[${v4Checks(def.checks)}]`;
        case 'bigint':
            return `bigint[${v4Checks(def.checks)}]`;
        case 'boolean':
            return `bool[${v4Checks(def.checks)}]`;
        case 'date':
            return `date[${v4Checks(def.checks)}]`;
        case 'optional':
            return `opt(${describe(def.innerType)})`;
        case 'nullable':
            return `nul(${describe(def.innerType)})`;
        case 'nonoptional':
            return `req(${describe(def.innerType)})`;
        case 'array':
            return `arr(${describe(def.element)})[${v4Checks(def.checks)}]`;
        case 'tuple':
            return `tup[${(def.items as unknown[]).map(describe).join(',')}${def.rest ? ';rest=' + describe(def.rest) : ''}]`;
        case 'record':
            return `rec(${describe(def.keyType)},${describe(def.valueType)})`;
        case 'map':
            return `map(${describe(def.keyType)},${describe(def.valueType)})`;
        case 'set':
            return `set(${describe(def.valueType)})`;
        case 'enum':
            return `enum{${Object.values(def.entries as AnyRec)
                .map(String)
                .sort()
                .map(key)
                .join(',')}}`;
        case 'literal':
            return `lit{${(def.values as unknown[]).map(literal).sort().join('|')}}`;
        case 'union':
            return `union{${(def.options as unknown[]).map(describe).sort().join('|')}}`;
        case 'intersection':
            return `and(${describe(def.left)},${describe(def.right)})`;
        case 'readonly':
            return `ro(${describe(def.innerType)})`;
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
