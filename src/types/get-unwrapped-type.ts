export type GetUnwrappedType<
  TResponse extends object,
  TOptions extends { unwrap?: keyof TResponse },
> = TOptions extends { unwrap: keyof TResponse }
  ? TResponse[TOptions["unwrap"]]
  : TResponse;
