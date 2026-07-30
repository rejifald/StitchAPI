// A tiny adapter that makes validation flexible: a `Validator` can be backed by
// Zod (`safeParse`), any Standard Schema (`~standard`), or a plain predicate.
// This is how we honour "Zod-first projects keep Zod" while also accepting Valibot/ArkType.
import { isStandardSchema } from './standard-schema';

export interface Issue {
    path: (string | number)[];
    message: string;
}

export type ValidationResult<T> =
    { ok: true; value: T } | { ok: false; issues: Issue[] };

export interface Validator<T = unknown> {
    validate(value: unknown): Promise<ValidationResult<T>>;
    /**
     * The raw schema this validator wraps (Zod / Valibot / ArkType / any Standard Schema /
     * predicate), attached non-enumerably by {@link toValidator}. The response cache reads it to
     * fingerprint the output contract (ADR 0004): the wrapper itself hides the original
     * `~standard.vendor` the fingerprint strategy dispatches on. Non-enumerable, so it never lands
     * in `__config`, JSON, or trace payloads.
     */
    readonly source?: unknown;
}

// Attach the raw schema to a wrapper non-enumerably, so the cache can fingerprint the output
// contract (ADR 0004) without the schema leaking through enumerable copies into `__config`/traces.
function withSource(validator: Validator, source: unknown): Validator {
    return Object.defineProperty(validator, 'source', {
        value: source,
        enumerable: false,
    });
}

/** Coerce a Zod schema | Standard Schema | Validator | undefined into a Validator. */
export function toValidator(schema: unknown): Validator | undefined {
    if (schema == null) return undefined;

    // Already a Validator
    if (
        typeof (schema as Validator).validate === 'function' &&
        !isStandardSchema(schema)
    ) {
        // Zod also has `.parse`, distinguish by checking for safeParse below first.
        if (
            typeof (schema as { safeParse?: unknown }).safeParse !== 'function'
        ) {
            return schema as Validator;
        }
    }

    // Zod (v3): has safeParse
    const zodLike = schema as { safeParse?: (v: unknown) => ZodResult };
    const { safeParse } = zodLike;
    if (typeof safeParse === 'function') {
        return withSource(
            {
                async validate(value) {
                    const r = safeParse(value);
                    if (r.success) return { ok: true, value: r.data };
                    return {
                        ok: false,
                        issues: (r.error?.issues ?? []).map((i) => ({
                            path: i.path ?? [],
                            message: i.message,
                        })),
                    };
                },
            },
            schema,
        );
    }

    // Standard Schema
    if (isStandardSchema(schema)) {
        return withSource(
            {
                async validate(value) {
                    const r = await schema['~standard'].validate(value);
                    if ('issues' in r && r.issues) {
                        return {
                            ok: false,
                            issues: r.issues.map((i) => ({
                                path: (i.path ?? []).map((p) =>
                                    typeof p === 'object'
                                        ? (p.key as string | number)
                                        : (p as string | number),
                                ),
                                message: i.message,
                            })),
                        };
                    }
                    return { ok: true, value: (r as { value: unknown }).value };
                },
            },
            schema,
        );
    }

    // Plain predicate: (value: unknown) => boolean
    if (typeof schema === 'function') {
        const predicate = schema as (v: unknown) => boolean;
        return withSource(
            {
                async validate(value) {
                    if (predicate(value)) return { ok: true, value };
                    return {
                        ok: false,
                        issues: [
                            { path: [], message: 'Predicate returned false' },
                        ],
                    };
                },
            },
            schema,
        );
    }

    throw new Error(
        `Unsupported schema passed to toValidator(): received ${typeof schema}. Fix: pass a Standard Schema, a Zod-style {parse}, a {validate} object, or a (value)=>boolean predicate.`,
    );
}

interface ZodResult {
    success: boolean;
    data?: unknown;
    error?: { issues?: { path?: (string | number)[]; message: string }[] };
}
