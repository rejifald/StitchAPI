import { StitchConfig } from "./types/stitch";

export const validate = <TData, TOptions extends StitchConfig<TData>>(
  data: TData,
  config: TOptions["validate"],
) => {
  if (config && "safeParse" in config) {
    const validate = config.safeParse(data);
    if (validate.success) {
      return data;
    } else {
      throw new Error("Invalid response");
    }
  }

  return data;
};
