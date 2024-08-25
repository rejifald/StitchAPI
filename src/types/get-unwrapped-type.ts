import { GetResponseType } from "./get-response-type";

export type GetUnwrappedType<
  TOptions,
  TResponse = GetResponseType<TOptions>,
> = TOptions extends {
  unwrap: keyof TResponse;
}
  ? TResponse[TOptions["unwrap"]]
  : TResponse;
