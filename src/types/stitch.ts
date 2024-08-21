export interface StitchOptions {
  path: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  unwrap?: string;
  baseUrl?: string;
}

export interface StitchArgs<
  TQuery extends object = Record<string, string>,
  TBody = unknown,
  TParams extends object = Record<string, string>,
> {
  params?: TParams;
  body?: TBody;
  query?: TQuery;
  fetchOptions?: RequestInit;
}
