import { HasBodyRequest } from './utils/has-body-request';

import { JsonObject } from 'type-fest';
import { ZodSchema, z } from 'zod';

export type GetBodyType<TOptions> =
    HasBodyRequest<TOptions> extends true
        ? TOptions extends {
              validate: {
                  body: ZodSchema;
              };
          }
            ? z.infer<TOptions['validate']['body']>
            : JsonObject
        : never;
