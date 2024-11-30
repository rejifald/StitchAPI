import { fetchAdapter } from '@/adapters/fetch';
import { GetResponseType } from '@/types/get-response-type';
import { CreateStitchInput, StitchConfig } from '@/types/stitch';

import defaults from 'lodash/defaults';

export class ConfigService {
    public static from<
        TOptions extends CreateStitchInput<GetResponseType<TOptions>>,
    >(options: TOptions): StitchConfig<GetResponseType<TOptions>> {
        const withDefaults = defaults(
            typeof options === 'string' ? { path: options } : options,
            {
                method: 'GET',
                adapter: fetchAdapter(),
                validate: {},
            } as StitchConfig<GetResponseType<TOptions>>,
        );

        withDefaults.validate =
            'safeParse' in withDefaults.validate
                ? { response: withDefaults.validate }
                : withDefaults.validate;

        return withDefaults;
    }
}
