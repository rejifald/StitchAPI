import { StitchError } from './errors';
import { UrlService } from './services/UrlService';
import { ZodValidationService } from './services/ZodValidationService';
import { HttpMethod, HttpMethodStateful } from './types/HttpMethod';
import { Adapter } from './types/adapter';
import { ExecutorInput } from './types/executor-input';
import { GetBodyType } from './types/get-body-type';
import { GetParamsType } from './types/get-params-type';
import { GetQueryType } from './types/get-query-type';
import { GetResponseType } from './types/get-response-type';
import { CreateStitchInput, StitchConfig } from './types/stitch';
import unwrap from './unwrap';

import { isEmpty, merge } from 'lodash';
import qs from 'qs';
import { parseURL, stringifyParsedURL } from 'ufo';

const StatefulHttpMethods = Object.values(
    HttpMethodStateful,
) as unknown as HttpMethod[];

export const executor = async <
    TOptions extends CreateStitchInput<GetResponseType<TOptions>>,
>(
    input: ExecutorInput<StitchConfig<GetResponseType<TOptions>>>,
): Promise<GetResponseType<TOptions>> => {
    const { query, body, params, config } = input;
    const fetcher: Adapter = config.adapter!;
    const urlTemplate = UrlService.template(config);

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

    const validationService = new ZodValidationService();

    try {
        validationService.validate(query, config.validate?.query);
    } catch (e: unknown) {
        throw new Error(`Invalid query, reason: ${e.message}`);
    }

    try {
        validationService.validate(body, config.validate?.body);
    } catch (e: unknown) {
        throw new Error(`Invalid body, reason: ${e.message}`);
    }

    let json: GetResponseType<TOptions>;
    try {
        json = (await fetcher({
            url,
            method: config.method,
            body,
        })) as GetResponseType<TOptions>;
    } catch (e) {
        throw new StitchError((e as Error).message, {
            config,
            original: e,
        });
    }
    const assertation = config.assert?.(json);
    if (assertation) {
        throw new StitchError(
            assertation === true ? 'Assertion failed' : assertation,
            { config },
        );
    }

    try {
        validationService.validate(json, config.validate?.response);
    } catch (e) {
        throw new Error(`Invalid response, reason: ${e.message}`);
    }
    return unwrap(json, config.unwrap);
};

export const create = <
    TOptions extends CreateStitchInput<GetResponseType<TOptions>>,
>(
    config: StitchConfig<GetResponseType<TOptions>>,
    params?: GetParamsType<StitchConfig<GetResponseType<TOptions>>>,
) => {
    const validationService = new ZodValidationService();
    try {
        validationService.validate(params, config.validate?.params);
    } catch (e) {
        throw new Error(`Invalid params, reason: ${e.message}`);
    }
    if (StatefulHttpMethods.includes(config.method)) {
        return (body?: GetBodyType<TOptions>, query?: GetQueryType<TOptions>) =>
            executor<TOptions>({
                query,
                config,
                params,
                body,
            });
    } else {
        return (query?: GetQueryType<TOptions>) =>
            executor<TOptions>({
                query,
                config,
                params,
            });
    }
};
