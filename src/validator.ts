// A tiny adapter that makes validation flexible: a `Validator` can be backed by
// Zod (`safeParse`), any Standard Schema (`~standard`), or a plain predicate.
// This is how we honour "Zod-first projects keep Zod" while also accepting Valibot/ArkType.
import { isStandardSchema } from './standard-schema';

export interface Issue {
    path: (string | number)[];
    message: string;
}

export type ValidationResult<T> =
    | { ok: true; value: T }
    | { ok: false; issues: Issue[] };

export interface Validator<T = unknown> {
    validate(value: unknown): Promise<ValidationResult<T>>;
}

/** Coerce a Zod schema | Standard Schema | Validator | undefined into a Validator. */
export function toValidator(schema: unknown): Validator | undefined {
    if (schema == null) return undefined;

    // Already a Validator
    if (typeof (schema as Validator).validate === 'function' && !isStandardSchema(schema)) {
        // Zod also has `.parse`, distinguish by checking for safeParse below first.
        if (typeof (schema as { safeParse?: unknown }).safeParse !== 'function') {
            return schema as Validator;
        }
    }

    // Zod (v3): has safeParse
    const zodLike = schema as { safeParse?: (v: unknown) => ZodResult };
    if (typeof zodLike.safeParse === 'function') {
        return {
            async validate(value) {
                const r = zodLike.safeParse!(value);
                if (r.success) return { ok: true, value: r.data };
                return {
                    ok: false,
                    issues: (r.error?.issues ?? []).map((i) => ({
                        path: i.path ?? [],
                        message: i.message,
                    })),
                };
            },
        };
    }

    // Standard Schema
    if (isStandardSchema(schema)) {
        return {
            async validate(value) {
                const r = await schema['~standard'].validate(value);
                if ('issues' in r && r.issues) {
                    return {
                        ok: false,
                        issues: r.issues.map((i) => ({
                            path: (i.path ?? []).map((p) =>
                                typeof p === 'object' ? (p.key as string | number) : (p as string | number),
                            ),
                            message: i.message,
                        })),
                    };
                }
                return { ok: true, value: (r as { value: unknown }).value };
            },
        };
    }

    throw new Error('Unsupported schema passed to toValidator()');
}

interface ZodResult {
    success: boolean;
    data?: unknown;
    error?: { issues?: Array<{ path?: (string | number)[]; message: string }> };
}
