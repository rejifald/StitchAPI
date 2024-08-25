import { z, ZodSchema } from "zod";

export type GetResponseType<TOptions> = TOptions extends {
  validate: ZodSchema;
}
  ? z.infer<TOptions["validate"]>
  : TOptions extends {
        validate: {
          response: ZodSchema;
        };
      }
    ? z.infer<TOptions["validate"]["response"]>
    : unknown;
