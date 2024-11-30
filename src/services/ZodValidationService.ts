import { ZodSchema, ZodTypeDef } from 'zod';
import { fromError } from 'zod-validation-error';

export class ZodValidationService implements ValidationService<ZodSchema> {
    validate(data: unknown, schema?: ZodSchema<any, ZodTypeDef, any>): unknown {
        if (!schema) {
            return true;
        } else if (!schema && !data) {
            return true;
        }

        const result = schema.safeParse(data ?? {});

        if (result.error) {
            throw new Error(fromError(result.error).toString());
        }

        return result.data;
    }
}
