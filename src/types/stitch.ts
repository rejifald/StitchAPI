import { Adapter } from '@/types/adapter';
import { GetBodyType } from '@/types/get-body-type';
import { GetParamsType } from '@/types/get-params-type';
import { GetQueryType } from '@/types/get-query-type';
import { ValidateOptions } from '@/types/validate';

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
