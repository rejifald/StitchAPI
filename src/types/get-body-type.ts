import { JsonObject } from "type-fest";
import { z, ZodSchema } from "zod";

export type GetBodyType<TOptions> = TOptions extends {
  validate: {
    body: ZodSchema;
  };
}
  ? z.infer<TOptions["validate"]["body"]>
  : JsonObject;
