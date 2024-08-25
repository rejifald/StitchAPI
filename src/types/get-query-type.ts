import { JsonObject } from "type-fest";
import { z, ZodSchema } from "zod";

export type GetQueryType<TOptions> = TOptions extends {
  validate: {
    query: ZodSchema;
  };
}
  ? z.infer<TOptions["validate"]["query"]>
  : JsonObject;
