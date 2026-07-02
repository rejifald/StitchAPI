// @stitchapi/json-schema — turn a runtime-discovered JSON Schema into a Standard Schema
// validator that stitchapi (or any Standard-Schema consumer) accepts directly.
//
// The problem it solves: a validation schema is discovered at runtime — fetched, received, or
// registered by a tenant, whatever delivered it — and arrives as JSON Schema, unknown until it
// reaches you. You can't generate TypeScript types for a schema that doesn't exist when you
// write the code. So you don't type across that boundary; you validate at it.
// `jsonSchemaValidator(schema)` returns a Standard Schema (https://standardschema.dev) whose
// `~standard.validate` checks a value and reports structured issues (path + message) — the
// shape you hand back to whoever sent the data so they can correct it.
//
// The bundled engine is Ajv. Bring your own check — a Workers-safe validator, a shared Ajv
// instance, a draft-2020-12 engine — through the `check` option; the wrapping and the
// issue-path mapping stay identical.
import Ajv, { type ErrorObject, type SchemaObject } from 'ajv';
import addFormats from 'ajv-formats';

// Minimal local copy of the Standard Schema v1 interface (https://standardschema.dev), so
// this package imports nothing from stitchapi. Zod, Valibot, ArkType and stitchapi all speak
// this shape; `toValidator()` in core consumes it directly.
export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly '~standard': {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (
            value: unknown,
        ) => StandardResult<Output> | Promise<StandardResult<Output>>;
        readonly types?: {
            readonly input: Input;
            readonly output: Output;
        };
    };
}

export type StandardResult<Output> =
    | { readonly value: Output; readonly issues?: undefined }
    | { readonly issues: readonly StandardIssue[] };

export interface StandardIssue {
    readonly message: string;
    readonly path?: readonly (string | number)[];
}

/** A JSON Schema object describing the data to validate. */
export type JsonSchema = Record<string, unknown>;

/** One failure from a JSON Schema engine, normalised to a JSON Pointer + a message. */
export interface JsonSchemaIssue {
    /** JSON Pointer to the offending value, e.g. `/limit`, or `` (empty) for the root. */
    readonly pointer: string;
    readonly message: string;
}

/** A compiled JSON Schema check — the seam that lets you swap the validation engine. */
export type JsonSchemaCheck = (value: unknown) => {
    readonly valid: boolean;
    readonly issues: readonly JsonSchemaIssue[];
};

export interface JsonSchemaValidatorOptions {
    /**
     * Bring your own compiled check instead of the bundled Ajv engine — a Workers-safe
     * validator, a draft-2020-12 engine, or a shared instance. When set, the schema is not
     * compiled here.
     */
    readonly check?: JsonSchemaCheck;
    /** Collect every failing path (default `true`) or stop at the first failure. */
    readonly allErrors?: boolean;
}

/**
 * Turn a JSON Schema into a Standard Schema validator.
 *
 * ```ts
 * import { toValidator } from 'stitchapi';
 * import { jsonSchemaValidator } from '@stitchapi/json-schema';
 *
 * const validator = toValidator(jsonSchemaValidator(discoveredSchema));
 * const result = await validator.validate(payload);
 * if (!result.ok) repair(result.issues); // [{ path: ['limit'], message: 'must be <= 50' }]
 * ```
 *
 * The output type is `T` (default `unknown`): a schema discovered at runtime carries no
 * static shape, so the honest result is `unknown` — validate it, don't pretend to type it.
 * Pass `T` explicitly only when you already know the shape at authoring time.
 */
export function jsonSchemaValidator<T = unknown>(
    schema: JsonSchema,
    options: JsonSchemaValidatorOptions = {},
): StandardSchemaV1<T, T> {
    const check = options.check ?? ajvCheck(schema, options.allErrors ?? true);
    return {
        '~standard': {
            version: 1,
            vendor: 'stitchapi-json-schema',
            validate(value): StandardResult<T> {
                const result = check(value);
                if (result.valid) return { value: value as T };
                return { issues: result.issues.map(toStandardIssue) };
            },
        },
    };
}

function toStandardIssue(issue: JsonSchemaIssue): StandardIssue {
    return { message: issue.message, path: pointerToPath(issue.pointer) };
}

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

function ajvCheck(schema: JsonSchema, allErrors: boolean): JsonSchemaCheck {
    const ajv = new Ajv({ allErrors, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema as SchemaObject);
    return (value) => {
        if (validate(value)) return { valid: true, issues: [] };
        const errors = validate.errors ?? [];
        return { valid: false, issues: errors.map(ajvError) };
    };
}

function ajvError(error: ErrorObject): JsonSchemaIssue {
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
