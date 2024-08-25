import { JsonObject } from 'type-fest';
import { ZodSchema, z } from 'zod';

export type GetParamsType<TOptions> = TOptions extends {
    validate: {
        params: ZodSchema;
    };
}
    ? z.infer<TOptions['validate']['params']>
    : JsonObject;
