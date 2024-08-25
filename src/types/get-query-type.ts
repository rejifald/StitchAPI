import { JsonObject } from 'type-fest';
import { ZodSchema, z } from 'zod';

export type GetQueryType<TOptions> = TOptions extends {
    validate: {
        query: ZodSchema;
    };
}
    ? z.infer<TOptions['validate']['query']>
    : JsonObject;
