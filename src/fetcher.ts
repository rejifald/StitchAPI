import isFunction from "lodash/isFunction";
import isObject from "lodash/isObject";
import { Adapter, AdapterFn, AdapterOptions } from "./types/adapter";
import { fetchAdapter } from "./adapters";
import axios from "axios";

export const fetcher = (adapter?: Adapter): AdapterFn => {
  if (isObject(adapter)) {
    if (adapter.name === "axios") {
      return axios.create((adapter as AdapterOptions<"axios">).options);
    } else if (adapter.name === "fetch") {
      return fetchAdapter((adapter as AdapterOptions<"fetch">).options);
    } else {
      throw new Error(
        `Invalid adapter name: ${(adapter as AdapterOptions).name}`,
      );
    }
  } else if (isFunction(adapter)) {
    return (adapter as () => AdapterFn)();
  }

  return fetchAdapter();
};
