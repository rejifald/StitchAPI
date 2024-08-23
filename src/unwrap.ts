import get from "lodash/get";
import { StitchConfig } from "./types/stitch";

export const unwrap = <TData>(
  response: TData,
  config?: StitchConfig<TData>["unwrap"],
) => {
  if (!config) {
    return response;
  }

  return get(response, config);
};

export default unwrap;
