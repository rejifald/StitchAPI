import { StitchOptions } from "./types/stitch-options";

import get from "lodash/get";
import intersection from "lodash/intersection";
import isEmpty from "lodash/isEmpty";
import qs from "qs";
import { joinURL, parseURL, stringifyParsedURL } from "ufo";
import { parseTemplate, PrimitiveValue } from "url-template";

interface StitchArgs<
  TQuery extends object = Record<string, string>,
  TBody = unknown,
  TParams extends object = Record<string, string>,
> {
  params?: TParams;
  body?: TBody;
  query?: TQuery;
  fetchOptions?: RequestInit;
}

export const stitch = <
  TParams extends object,
  TResponse,
  TBody extends object,
  TQuery extends object,
>(
  options: StitchOptions | string,
) => {
  const spec: StitchOptions =
    typeof options === "string" ? { path: options, method: "GET" } : options;
  const placeholders = [...spec.path.matchAll(/{([^{}]+)}|([^{}]+)/g)]
    .map((match) => match[1])
    .filter(Boolean);

  const path: string = joinURL(get(options, "baseUrl", ""), spec.path);
  const urlTemplate = parseTemplate(path);

  return async ({
    params = {} as TParams,
    query = {} as TQuery,
    body = {} as TBody,
    fetchOptions = {},
  }: StitchArgs<TQuery, TBody, TParams> = {}): Promise<TResponse> => {
    let url: string;
    for (const placeholder of placeholders) {
      if (!(params as Record<string, unknown>)[placeholder]) {
        throw new Error(`Missing path param: ${placeholder}`);
      }
    }

    try {
      url = urlTemplate.expand(params as Record<string, PrimitiveValue>);
    } catch (e: unknown) {
      throw new Error(
        `Failed to resolve url template. Reason: ${(e as Error).message}`,
      );
    }

    if (!isEmpty(query)) {
      const { search, ...restUrlParts } = parseURL(url);
      const predefinedQuery = qs.parse(search, {
        ignoreQueryPrefix: true,
      });
      const conflictedKeys = intersection(
        Object.keys(predefinedQuery),
        Object.keys(query),
      );

      if (conflictedKeys.length) {
        console.warn("Conflicted query keys:", conflictedKeys.join(", "));
      }

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
    if (spec.unwrap) {
      return get(json, spec.unwrap);
    }
    return json;
  };
};
