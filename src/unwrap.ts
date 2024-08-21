import get from "lodash/get";
import { StitchOptions } from "./types/stitch";

export const unwrap = (response: unknown, config: StitchOptions["unwrap"]) => {
  if (!config) {
    return response;
  }

  return get(response, config);
};
