// Minimal local copy of the Standard Schema v1 interface (https://standardschema.dev).
// Zod >=3.24, Valibot, ArkType all expose `~standard`. We only need the validate entry point.

export interface StandardSchemaV1<Output = unknown> {
    readonly '~standard': {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (
            value: unknown,
        ) => StandardResult<Output> | Promise<StandardResult<Output>>;
    };
}

export type StandardResult<Output> =
    | { readonly value: Output; readonly issues?: undefined }
    | { readonly issues: readonly StandardIssue[] };

export interface StandardIssue {
    readonly message: string;
    readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
}

export function isStandardSchema(x: unknown): x is StandardSchemaV1 {
    return (
        !!x &&
        (typeof x === 'object' || typeof x === 'function') &&
        '~standard' in (x as Record<string, unknown>)
    );
}
