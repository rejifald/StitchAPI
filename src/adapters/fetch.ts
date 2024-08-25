import isEmpty from "lodash/isEmpty";
import { AdapterInput } from "../types/adapter";
import merge from "lodash/merge";
import { fetch } from "cross-fetch";

export const fetchAdapter =
  (initial: RequestInit = {}) =>
  async ({ url, method, body }: AdapterInput): Promise<unknown> => {
    const response = await fetch(
      url,
      merge(initial, {
        method,
        body: isEmpty(body) ? undefined : JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }),
    );
    return response.json();
  };
