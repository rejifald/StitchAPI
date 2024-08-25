import { JsonObject } from "type-fest";
import { z, ZodSchema } from "zod";

export type GetParamsType<TOptions> = TOptions extends {
  validate: {
    params: ZodSchema;
  };
}
  ? z.infer<TOptions["validate"]["params"]>
  : JsonObject;
