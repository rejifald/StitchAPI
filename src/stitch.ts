import { fetchAdapter } from '@/adapters/fetch';
import { Adapter } from '@/types/adapter';
import { GetResponseType } from '@/types/get-response-type';
import { GetUnwrappedType } from '@/types/get-unwrapped-type';
import { CreateStitchInput, StitchArgs, StitchConfig } from '@/types/stitch';
import { ValidateIndexSignature } from '@/types/validate';
import unwrap from '@/unwrap';
import { validate } from '@/validate';

import defaults from 'lodash/defaults';
import get from 'lodash/get';
import isEmpty from 'lodash/isEmpty';
import isObject from 'lodash/isObject';
import merge from 'lodash/merge';
import qs from 'qs';
import { joinURL, parseURL, stringifyParsedURL } from 'ufo';
import { parseTemplate } from 'url-template';
import { ZodSchema } from 'zod';

export const stitch = <
    TOptions extends CreateStitchInput<GetResponseType<TOptions>>,
>(
    options: TOptions,
) => {
    const config: StitchConfig<GetResponseType<TOptions>> = defaults(
        typeof options === 'string' ? { path: options } : options,
        { method: 'GET', adapter: fetchAdapter() } as StitchConfig<
            GetResponseType<TOptions>
        >,
    );

    const fetcher: Adapter = config.adapter!;
    const path: string = joinURL(get(options, 'baseUrl', ''), config.path);
    const urlTemplate = parseTemplate(path);

    return async ({ params, query, body }: StitchArgs<TOptions> = {}): Promise<
        GetUnwrappedType<TOptions>
    > => {
        let url = urlTemplate.expand(merge(params ?? {}, query ?? {}));

        if (!isEmpty(query)) {
            const { search, ...restUrlParts } = parseURL(url);
            const predefinedQuery = qs.parse(search, {
                ignoreQueryPrefix: true,
            });

            const combinedQuery = { ...predefinedQuery, ...query };
            url = stringifyParsedURL({
                ...restUrlParts,
                search: qs.stringify(combinedQuery, { addQueryPrefix: true }),
            });
        }

        if (isObject(config.validate) && !get(config.validate, 'safeParse')) {
            const context = { query, params, body };
            for (const key of Object.keys(context)) {
                try {
                    validate(
                        context[key as keyof typeof context] ?? {},
                        (
                            config.validate as Record<
                                ValidateIndexSignature,
                                ZodSchema
                            >
                        )[key as keyof typeof context],
                    );
                } catch (e) {
                    throw new Error(
                        `Invalid ${key}, reason: ${(e as Error).message}`,
                    );
                }
            }
        }

        const json = (await fetcher({
            url,
            method: config.method,
            body,
        })) as GetResponseType<TOptions>;

        validate(json, config.validate);

        return unwrap(json, config.unwrap);
    };
};
