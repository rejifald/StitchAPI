// Standard Schema fingerprint strategy for Valibot (StitchAPI ADR 0004).
//
// Walks Valibot's internal representation — a schema is a plain object with a
// `.kind` of `'schema'`, a `.type` discriminator (`'object'`/`'string'`/…), and
// type-specific children (`.entries`, `.wrapped`, `.item`, `.options`, …). A
// PIPED schema (`v.pipe(v.string(), v.minLength(2))`) carries a `.pipe` array of
// `[baseSchema, ...actions]`, each action a `{ kind, type, requirement }` record.
//
// The walker is an ALLOWLIST: it only emits a fingerprint for constructs whose
// validation/shape semantics it fully captures, and ABSTAINS (`token: null`) on
// anything else — opaque `check`/`custom`/`transform`/`brand` pipe actions, any
// action whose `requirement` is a function (hidden, unserialisable logic), an
// injected `default`, or any unknown node. Abstain is sound: the cache falls
// back to re-validate-on-hit rather than trust a token that might collide across
// semantically-different schemas.
//
// `valibot` is a PEER dependency and is never imported here — the strategy reads
// the schema instance it is handed, so it works against whichever Valibot the
// app ships.
import { type SchemaFingerprinter, hash } from 'stitchapi/fingerprint';

// Thrown the moment a construct can't be soundly captured; caught at the top and
// turned into an abstain. A symbol keeps it distinct from real errors.
const ABSTAIN = Symbol('abstain');

type AnyRec = Record<string, unknown>;

const key = (k: string): string => JSON.stringify(k);

// Canonical JSON for action requirements / literals: sort object keys, encode
// RegExp/bigint, and ABSTAIN on any function value (opaque logic in disguise).
function stableJson(value: unknown): string {
    const out = JSON.stringify(value, (_k, val: unknown) => {
        if (typeof val === 'function') throw ABSTAIN;
        if (val instanceof RegExp) return `re:${val.source}/${val.flags}`;
        if (typeof val === 'bigint') return `bi:${val.toString()}`;
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            const o = val as AnyRec;
            const sorted: AnyRec = {};
            for (const k of Object.keys(o).sort()) sorted[k] = o[k];
            return sorted;
        }
        return val;
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

// Pipe-action types whose semantics are user-supplied logic we cannot capture.
const OPAQUE_ACTIONS = new Set([
    'check',
    'check_items',
    'custom',
    'raw_check',
    'raw_transform',
    'transform',
]);

// Describe one pipe ACTION (a validation/transformation step). Abstains on any
// transformation, any opaque-typed action, or a function-valued requirement.
function action(a: unknown): string {
    if (!a || typeof a !== 'object') throw ABSTAIN;
    const act = a as AnyRec;
    const kind = act['kind'];
    const type = act['type'];
    if (typeof type !== 'string') throw ABSTAIN;
    // Transformations mutate the value — not soundly captured by shape alone.
    if (kind === 'transformation') throw ABSTAIN;
    // Anything that isn't a plain validation (e.g. a nested 'schema' guard) or is
    // on the opaque allowlist can't be soundly serialised.
    if (kind !== 'validation') throw ABSTAIN;
    if (OPAQUE_ACTIONS.has(type)) throw ABSTAIN;
    // A function requirement hides logic (or constant predicates we can't tell
    // apart from parameterised ones) — abstain rather than risk a collision.
    if ('requirement' in act && typeof act['requirement'] === 'function')
        throw ABSTAIN;
    const req =
        'requirement' in act ? `=${stableJson(act['requirement'])}` : '';
    return `${type}${req}`;
}

// Describe a sorted list of pipe actions (order-independent for stability).
function actions(pipe: readonly unknown[]): string {
    // pipe[0] is the base schema (already described by the caller); the rest are
    // validation/transformation actions.
    return pipe.slice(1).map(action).sort().join(',');
}

// A wrapper (optional/nullable/nullish/exact_optional) carries a `default`
// property even when no default was supplied — its VALUE is `undefined` then.
// A real default injects a value (or runs a function) we cannot soundly hash.
function noDefault(s: AnyRec): void {
    if ('default' in s && s['default'] !== undefined) throw ABSTAIN;
}

function schemaBody(s: AnyRec, type: string): string {
    switch (type) {
        case 'object':
        case 'strict_object':
        case 'loose_object':
        case 'object_with_rest': {
            const entries = (s['entries'] as AnyRec) ?? {};
            const fields = Object.keys(entries)
                .sort()
                .map((k) => `${key(k)}:${describe(entries[k])}`);
            const rest =
                'rest' in s && s['rest'] ? `;rest=${describe(s['rest'])}` : '';
            return `${type}{${fields.join(',')}${rest}}`;
        }
        case 'string':
            return 'str';
        case 'number':
            return 'num';
        case 'bigint':
            return 'bigint';
        case 'boolean':
            return 'bool';
        case 'date':
            return 'date';
        case 'symbol':
            return 'symbol';
        case 'null':
            return 'null';
        case 'undefined':
            return 'undef';
        case 'void':
            return 'void';
        case 'nan':
            return 'nan';
        case 'any':
            return 'any';
        case 'unknown':
            return 'unknown';
        case 'never':
            return 'never';
        case 'optional':
            noDefault(s);
            return `opt(${describe(s['wrapped'])})`;
        case 'exact_optional':
            noDefault(s);
            return `xopt(${describe(s['wrapped'])})`;
        case 'nullable':
            noDefault(s);
            return `nul(${describe(s['wrapped'])})`;
        case 'nullish':
            noDefault(s);
            return `nullish(${describe(s['wrapped'])})`;
        case 'non_optional':
            return `nonopt(${describe(s['wrapped'])})`;
        case 'non_nullable':
            return `nonnul(${describe(s['wrapped'])})`;
        case 'non_nullish':
            return `nonnullish(${describe(s['wrapped'])})`;
        case 'array':
            return `arr(${describe(s['item'])})`;
        case 'tuple':
        case 'strict_tuple':
        case 'loose_tuple': {
            const items = (s['items'] as readonly unknown[]) ?? [];
            const rest =
                'rest' in s && s['rest'] ? `;rest=${describe(s['rest'])}` : '';
            return `${type}[${items.map(describe).join(',')}${rest}]`;
        }
        case 'tuple_with_rest':
            return `tupr[${((s['items'] as readonly unknown[]) ?? [])
                .map(describe)
                .join(',')};rest=${describe(s['rest'])}]`;
        case 'record':
            return `rec(${describe(s['key'])},${describe(s['value'])})`;
        case 'map':
            return `map(${describe(s['key'])},${describe(s['value'])})`;
        case 'set':
            return `set(${describe(s['value'])})`;
        case 'literal':
            return `lit(${literal(s['literal'])})`;
        case 'picklist': {
            const opts = (s['options'] as readonly unknown[]) ?? [];
            return `pick{${opts.map(literal).sort().join('|')}}`;
        }
        case 'enum': {
            const en = (s['enum'] as AnyRec) ?? {};
            // Enum identity is its set of member VALUES; sort for stability.
            return `enum{${Object.values(en).map(literal).sort().join('|')}}`;
        }
        case 'union':
        case 'variant': {
            const opts = (s['options'] as readonly unknown[]) ?? [];
            const tag =
                type === 'variant' && typeof s['key'] === 'string'
                    ? `key=${key(s['key'] as string)};`
                    : '';
            return `union{${tag}${opts.map(describe).sort().join('|')}}`;
        }
        case 'intersect':
            return `and{${((s['options'] as readonly unknown[]) ?? [])
                .map(describe)
                .sort()
                .join('&')}}`;
        // 'pipe'-only constructs, lazy, custom, instance, promise, file, blob,
        // and anything unrecognised → abstain via the default arm.
        default:
            throw ABSTAIN;
    }
}

function describe(schema: unknown): string {
    if (!schema || typeof schema !== 'object') throw ABSTAIN;
    const s = schema as AnyRec;
    if (s['kind'] !== 'schema') throw ABSTAIN;
    const type = s['type'];
    if (typeof type !== 'string') throw ABSTAIN;
    const base = schemaBody(s, type);
    // A piped schema sets `.type` to the BASE type and lists actions in `.pipe`.
    const pipe = s['pipe'];
    if (Array.isArray(pipe) && pipe.length > 1) {
        return `${base}|p[${actions(pipe)}]`;
    }
    return base;
}

/**
 * Fingerprint strategy for Valibot schemas. Register it once at startup:
 *
 * ```ts
 * import { registerFingerprinter } from 'stitchapi/fingerprint';
 * import { valibotFingerprinter } from '@stitchapi/fingerprint-valibot';
 * registerFingerprinter(valibotFingerprinter);
 * ```
 */
export const valibotFingerprinter: SchemaFingerprinter = {
    vendor: 'valibot',
    range: '^1.0.0',
    fingerprint(schema) {
        try {
            // `vfp1` tags the descriptor format: bump it to force a one-time,
            // safe re-fingerprint if the descriptor scheme ever changes.
            const token = hash(`vfp1|${describe(schema)}`);
            return { token, strength: 'strong' };
        } catch {
            // ABSTAIN sentinel or any unexpected introspection failure → abstain.
            return { token: null, strength: 'strong' };
        }
    },
};
