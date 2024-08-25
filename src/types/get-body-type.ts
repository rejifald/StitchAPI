import { JsonObject } from 'type-fest';
import { ZodSchema, z } from 'zod';

export type GetBodyType<TOptions> = TOptions extends {
    validate: {
        body: ZodSchema;
    };
}
    ? z.infer<TOptions['validate']['body']>
    : JsonObject;
