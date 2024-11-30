export type GetRequestMethod<TInput> = TInput extends string
    ? TInput
    : TInput extends { method: string }
      ? TInput['method']
      : never;
