import { StitchConfig } from './types/stitch';

import get from 'lodash/get';

export const unwrap = <TData>(
    response: TData,
    config?: StitchConfig<TData>['unwrap'],
) => {
    if (!config) {
        return response;
    }

    return get(response, config);
};

export default unwrap;
