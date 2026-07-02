// @stitchapi/json-schema — adapt a runtime-discovered JSON Schema into a StitchSchema
// (a Standard Schema, https://standardschema.dev) that stitchapi accepts directly.
//
// The problem it solves: a validation schema is discovered at runtime — fetched, received, or
// registered by a tenant, whatever delivered it — and arrives as JSON Schema, unknown until it
// reaches you. You can't generate TypeScript types for a schema that doesn't exist when you write
// the code. So you don't type across that boundary; you validate at it.
//
// This package ships NO validation engine. You bring your own — a configured Ajv instance, or any
// compiled `check` — so the schema is validated with exactly the keywords, formats, `$ref`s and
// draft your app already uses everywhere else. A vanilla engine we instantiated ourselves would
// mis-handle a schema that relies on your custom keywords/formats, so we don't guess: you pass the
// engine. `JsonSchema.adapt(schema, engine)` wraps it into a StitchSchema whose `~standard.validate`
// reports structured issues (path + message) — the shape you hand back to whoever sent the data.
import type { StitchSchema } from 'stitchapi';

/** A JSON Schema document to validate against. */
export type JsonSchemaObject = Record<string, unknown>;

/** One failure from a validation engine, normalised to a JSON Pointer + a message. */
export interface JsonSchemaIssue {
    /** JSON Pointer to the offending value, e.g. `/limit`, or `` (empty) for the root. */
    readonly pointer: string;
    readonly message: string;
}

/**
 * A compiled JSON Schema check — the engine seam. Bring any engine that can answer "is this value
 * valid, and if not, which paths failed?"; the wrapping and issue-path mapping stay identical.
 */
export type JsonSchemaCheck = (value: unknown) => {
    readonly valid: boolean;
    readonly issues: readonly JsonSchemaIssue[];
};

/**
 * The slice of an Ajv instance we use — just `ajv.compile(schema)`. Declared structurally so this
 * package imports nothing from `ajv`: your configured instance satisfies it, and a `{ check }`-only
 * consumer needs `ajv` neither installed nor in their type graph.
 */
export interface AjvInstance {
    compile(schema: JsonSchemaObject): AjvValidate;
}
interface AjvValidate {
    (value: unknown): boolean;
    errors?: readonly AjvError[] | null;
}
interface AjvError {
    readonly instancePath: string;
    readonly keyword: string;
    readonly message?: string;
    readonly params: Record<string, unknown>;
}

/**
 * The validation engine — required, because this package bundles none. Bring a configured Ajv
 * instance (we call `.compile()` on it, reusing its formats/keywords/`$ref`s/draft), or a fully
 * custom compiled `check` (a Workers-safe validator, a draft-2020-12 engine, a shared instance).
 */
export type JsonSchemaEngine =
    | { readonly ajv: AjvInstance }
    | { readonly check: JsonSchemaCheck };

/**
 * Adapt a JSON Schema into a {@link StitchSchema} — a Standard Schema (https://standardschema.dev)
 * a stitch's `input`/`output` accepts directly.
 *
 * ```ts
 * import Ajv from 'ajv';
 * import { JsonSchema } from '@stitchapi/json-schema';
 *
 * const ajv = new Ajv();                               // your app's configured engine
 * const validator = JsonSchema.adapt(discovered, { ajv });
 * const result = await validator['~standard'].validate(payload);
 * if (result.issues) repair(result.issues);           // [{ message: 'must be <= 50', path: ['limit'] }]
 * ```
 *
 * The output type is `T` (default `unknown`): a schema discovered at runtime carries no static
 * shape, so the honest result is `unknown` — validate it, don't pretend to type it. Pass `T`
 * explicitly only when you already know the shape at authoring time.
 */
function adapt<T = unknown>(
    schema: JsonSchemaObject,
    engine: JsonSchemaEngine,
): StitchSchema<T, T> {
    const check =
        'check' in engine ? engine.check : ajvCheck(engine.ajv, schema);
    return {
        '~standard': {
            version: 1,
            vendor: 'stitchapi-json-schema',
            validate(value) {
                const result = check(value);
                if (result.valid) return { value: value as T };
                return {
                    issues: result.issues.map((issue) => ({
                        message: issue.message,
                        path: pointerToPath(issue.pointer),
                    })),
                };
            },
        },
    };
}

/**
 * Operations on runtime-discovered JSON Schemas. `adapt` bridges a schema (+ your engine) into a
 * StitchSchema; the namespace leaves room for more verbs (`is`, `deref`) as they earn their place.
 */
export const JsonSchema = { adapt };

/** Decode a JSON Pointer (`/items/0/name`) into a Standard Schema path (`['items', 0, 'name']`). */
function pointerToPath(pointer: string): (string | number)[] {
    if (pointer === '' || pointer === '#') return [];
    return pointer
        .replace(/^#/, '')
        .split('/')
        .slice(1)
        .map((segment) => {
            const decoded = segment.replace(/~1/g, '/').replace(/~0/g, '~');
            return /^\d+$/.test(decoded) ? Number(decoded) : decoded;
        });
}

function ajvCheck(ajv: AjvInstance, schema: JsonSchemaObject): JsonSchemaCheck {
    const validate = ajv.compile(schema);
    return (value) => {
        if (validate(value)) return { valid: true, issues: [] };
        const errors = validate.errors ?? [];
        return { valid: false, issues: errors.map(ajvError) };
    };
}

function ajvError(error: AjvError): JsonSchemaIssue {
    if (error.keyword === 'additionalProperties') {
        const extra = (error.params as { additionalProperty?: unknown })
            .additionalProperty;
        if (typeof extra === 'string') {
            return {
                pointer: error.instancePath,
                message: `must NOT have additional property '${extra}'`,
            };
        }
    }
    return { pointer: error.instancePath, message: error.message ?? 'invalid' };
}
