import { StitchOptions, StitchArgs } from "./types/stitch";
import unwrap from "./unwrap";

import get from "lodash/get";
import isEmpty from "lodash/isEmpty";
import qs from "qs";
import { joinURL, parseURL, stringifyParsedURL } from "ufo";
import { parseTemplate, PrimitiveValue } from "url-template";

export const stitch = <
  TResponse,
  TParams extends object,
  TBody extends object,
  TQuery extends object,
>(
  options: StitchOptions | string,
) => {
  const spec: StitchOptions =
    typeof options === "string" ? { path: options, method: "GET" } : options;

  const path: string = joinURL(get(options, "baseUrl", ""), spec.path);
  const urlTemplate = parseTemplate(path);

  return async ({
    params = {} as TParams,
    query = {} as TQuery,
    body = {} as TBody,
    fetchOptions = {},
  }: StitchArgs<TQuery, TBody, TParams> = {}): Promise<TResponse> => {
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

    const response = await fetch(url, {
      method: spec.method || "GET",
      body: isEmpty(body) ? undefined : JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
      },
      ...fetchOptions,
    });

    const json = await response.json();

    return unwrap(json, spec.unwrap);
  };
};
