import axios, { AxiosRequestConfig } from "axios";
import { AdapterInput } from "../types/adapter";
import merge from "lodash/merge";

export const axiosAdapter =
  (initial: AxiosRequestConfig = {}) =>
  async ({ url, method, body }: AdapterInput) => {
    const response = await axios(
      merge(initial, {
        url,
        method,
        data: body,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      }),
    );
    return response.data;
  };
