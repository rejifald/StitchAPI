// Inference works across every schema flavour the runtime already accepts, plus the exported
// `InferOutput` / `InferInput` helpers.
import { drift, stitch } from '..';
import type { InferInput, InferOutput, Validator } from '..';
import { output } from './_util';

import { expectType } from 'tsd';
import { z } from 'zod';

const userSchema = z.object({ id: z.number(), name: z.string() });
type User = z.infer<typeof userSchema>;

// 1) drift() wrapper still infers the inner contract type.
expectType<User>(
    output(stitch({ output: drift(userSchema, { critical: ['id'] }) })),
);

// 2) Standard Schema (non-Zod): infers OUTPUT from `~standard.types`, distinct from input.
declare const std: {
    readonly '~standard': {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (v: unknown) => { value: { id: number } };
        readonly types?: {
            readonly input: { raw: string };
            readonly output: { id: number };
        };
    };
};
expectType<{ id: number }>(output(stitch({ output: std })));

// 3) a hand-rolled Validator<T>.
declare const val: Validator<{ v: boolean }>;
expectType<{ v: boolean }>(output(stitch({ output: val })));

// 4) a user-defined type guard narrows the result.
const isThing = (v: unknown): v is { kind: 'thing' } =>
    typeof v === 'object' && v !== null;
expectType<{ kind: 'thing' }>(output(stitch({ output: isThing })));

// 5) the exported helpers read straight off a schema type.
expectType<User>(null as unknown as InferOutput<typeof userSchema>);
expectType<{ id: number }>(null as unknown as InferOutput<typeof std>);
expectType<{ raw: string }>(null as unknown as InferInput<typeof std>);

// 6) input vs output on a coercing schema: InferInput is the accepted type, InferOutput the result.
const lengthSchema = z.string().transform((s) => s.length);
expectType<number>(null as unknown as InferOutput<typeof lengthSchema>);
expectType<string>(null as unknown as InferInput<typeof lengthSchema>);
