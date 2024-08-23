import { ZodSchema } from "zod";
import { RequireAtLeastOne } from "type-fest";

export type ValidateIndexSignature = "params" | "query" | "body" | "response";

export type ValidateOptions =
  | ZodSchema
  | undefined
  | RequireAtLeastOne<Record<ValidateIndexSignature, ZodSchema>>;
