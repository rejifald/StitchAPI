import { RequireAtLeastOne } from 'type-fest';
import { ZodSchema } from 'zod';

export type ValidateIndexSignature = 'params' | 'query' | 'body' | 'response';

export type ValidateOptions =
    | ZodSchema
    | undefined
    | RequireAtLeastOne<Record<ValidateIndexSignature, ZodSchema>>;
