import { Adapter } from './adapter';
import { GetBodyType } from './get-body-type';
import { GetParamsType } from './get-params-type';
import { GetQueryType } from './get-query-type';
import { ValidateOptions } from './validate';

export type CreateStitchInput<TResponse> =
    | string
    | (Partial<StitchConfig<TResponse>> &
          Pick<StitchConfig<TResponse>, 'path'>);

export interface StitchConfig<TResponse> {
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    baseUrl?: string;
    unwrap?: keyof TResponse;
    validate?: ValidateOptions;
    adapter?: Adapter;
}

export interface StitchArgs<TOptions = unknown> {
    params?: GetParamsType<TOptions>;
    body?: GetBodyType<TOptions>;
    query?: GetQueryType<TOptions>;
}
