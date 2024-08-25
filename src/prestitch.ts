import { stitch } from '@/stitch';
import { GetResponseType } from '@/types/get-response-type';
import { CreateStitchInput } from '@/types/stitch';

import merge from 'lodash/merge';

export function prestitch<
    TOptions extends CreateStitchInput<GetResponseType<TOptions>>,
>(predefined: Partial<TOptions>) {
    return (options: TOptions) => {
        if (typeof predefined === 'string' && typeof options === 'string') {
            return stitch(options);
        } else if (
            typeof predefined === 'string' &&
            typeof options === 'object'
        ) {
            return stitch({ path: predefined, ...options });
        } else if (
            typeof predefined === 'object' &&
            typeof options === 'string'
        ) {
            return stitch({ ...predefined, path: options });
        }

        return stitch(merge(predefined, options));
    };
}
