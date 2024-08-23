import { Adapter } from "./adapter";
import { ValidateOptions } from "./validate";

export type CreateStitchInput<TResponse> =
  | string
  | (Partial<StitchConfig<TResponse>> & Pick<StitchConfig<TResponse>, "path">);

export interface StitchConfig<TResponse> {
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  baseUrl?: string;
  unwrap?: keyof TResponse;
  validate?: ValidateOptions;
  adapter: Adapter;
}

export interface StitchArgs<
  TQuery extends object = Record<string, string>,
  TBody = unknown,
  TParams extends object = Record<string, string>,
> {
  params?: TParams;
  body?: TBody;
  query?: TQuery;
}
