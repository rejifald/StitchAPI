import isEmpty from "lodash/isEmpty";
import { AdapterInput } from "../types/adapter";

export const fetchAdapter =
  (initial: RequestInit = {}) =>
  async ({ url, method, body }: AdapterInput): Promise<unknown> => {
    const response = await fetch(url, {
      ...initial,
      method,
      body: isEmpty(body) ? undefined : JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    return response.json();
  };
