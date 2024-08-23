import { StitchArgs, CreateStitchInput, StitchConfig } from "./types/stitch";

import get from "lodash/get";
import isEmpty from "lodash/isEmpty";
import qs from "qs";
import { joinURL, parseURL, stringifyParsedURL } from "ufo";
import { parseTemplate, PrimitiveValue } from "url-template";
import { GetUnwrappedType } from "./types/get-unwrapped-type";
import { validate } from "./validate";
import unwrap from "./unwrap";
import defaults from "lodash/defaults";
import { fetchAdapter } from "./adapters/fetch-adapter";

export const stitch = <
  TOptions extends StitchConfig<TResponse>,
  TResponse extends object = {
    success: boolean;
    error: object;
    total: number;
  },
  TParams extends object = object,
  TBody extends object = object,
  TQuery extends object = object,
>(
  options: CreateStitchInput<TResponse>,
) => {
  const config: StitchConfig<TResponse> = defaults(
    typeof options === "string" ? { path: options } : options,
    { method: "GET", adapter: fetchAdapter() },
  );

  const fetcher = config.adapter;
  const path: string = joinURL(get(options, "baseUrl", ""), config.path);
  const urlTemplate = parseTemplate(path);

  return async ({
    params = {} as TParams,
    query = {} as TQuery,
    body = {} as TBody,
  }: StitchArgs<TQuery, TBody, TParams> = {}): Promise<
    GetUnwrappedType<TResponse, TOptions>
  > => {
    let url = urlTemplate.expand({ ...params, ...query } as Record<
      string,
      PrimitiveValue
    >);

    if (!isEmpty(query)) {
      const { search, ...restUrlParts } = parseURL(url);
      const predefinedQuery = qs.parse(search, {
        ignoreQueryPrefix: true,
      });

      const combinedQuery = { ...predefinedQuery, ...query };
      url = stringifyParsedURL({
        ...restUrlParts,
        search: qs.stringify(combinedQuery, { addQueryPrefix: true }),
      });
    }

    const json = (await fetcher({
      url,
      method: config.method,
      body,
    })) as TResponse;

    const validated = validate(json, config.validate);

    return unwrap(validated, config.unwrap);
  };
};
