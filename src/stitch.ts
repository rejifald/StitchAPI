import { create } from './executor';
import { ConfigService } from './services/ConfigService';
import { UrlService } from './services/UrlService';
import { GetParamsType } from './types/get-params-type';

import { GetResponseType } from '@/types/get-response-type';
import { CreateStitchInput, Stitch, StitchConfig } from '@/types/stitch';

export const stitch = <
    TOptions extends CreateStitchInput<GetResponseType<TOptions>>,
>(
    options: TOptions,
): Stitch<
    GetResponseType<TOptions>,
    StitchConfig<GetResponseType<TOptions>>
> => {
    const config = ConfigService.from(options);
    const extractedParams = UrlService.extractRFCParams(config.path);

    if (extractedParams.length) {
        return (params: GetParamsType<TOptions>) => create(config, params);
    }

    return create(config);
};
