import axios, { AxiosRequestConfig } from "axios";
import { AdapterInput } from "../types/adapter";

export const axiosAdapter =
  (initial: AxiosRequestConfig = {}) =>
  async ({ url, method, body }: AdapterInput) => {
    const response = await axios({
      ...initial,
      url,
      method,
      data: body,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    return response.data;
  };
