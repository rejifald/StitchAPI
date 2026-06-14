// Minimal local copy of the Standard Schema v1 interface (https://standardschema.dev).
// Zod >=3.24, Valibot, ArkType all expose `~standard`. We need the validate entry point at
// runtime and the optional `types` phantom at compile time: that is how a Standard Schema carries
// its inferred input/output types, which `InferInput`/`InferOutput` (src/infer.ts) read so a
// stitch can infer its result type from the schema instead of a hand-written generic.
export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly '~standard': {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (
            value: unknown,
        ) => StandardResult<Output> | Promise<StandardResult<Output>>;
        /**
         * Phantom carrier for the inferred types — never present at runtime (validators don't set
         * it), so it is typed optional and read only at the type level. `input` is what the schema
         * accepts; `output` is what it produces after coercion.
         */
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
    readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
}

export function isStandardSchema(x: unknown): x is StandardSchemaV1 {
    return (
        !!x &&
        (typeof x === 'object' || typeof x === 'function') &&
        '~standard' in (x as Record<string, unknown>)
    );
}
