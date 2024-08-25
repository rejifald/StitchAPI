import { StitchConfig } from './types/stitch';

import { fromError } from 'zod-validation-error';

export const validate = <TData, TOptions extends StitchConfig<TData>>(
    data: TData,
    config: TOptions['validate'],
) => {
    if (config && 'safeParse' in config) {
        const validate = config.safeParse(data);
        if (validate.success) {
            return data;
        } else {
            throw new Error(fromError(validate.error).toString());
        }
    }

    return data;
};
