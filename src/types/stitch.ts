import { HttpMethod } from './HttpMethod';
import { PluginOptions } from './plugin-options';
import { ExtractRFCParams } from './utils/get-template-type';

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
    method: HttpMethod;
    baseUrl?: string;
    unwrap?: keyof TResponse;
    assert?: (response: TResponse) => boolean;
    validate?: ValidateOptions;
    adapter?: Adapter;
    plugins?: PluginOptions[];
}

export type ParametricStitch<TParams, TStitch> = (params: TParams) => TStitch;
export type StitchExecutor<
    TResponse,
    TOptions extends StitchConfig<TResponse>,
> = TOptions['method'] extends 'GET' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'TRACE'
    ? (query: GetQueryType<TOptions>) => Promise<TResponse>
    : (
          body: GetBodyType<TOptions>,
          query: GetQueryType<TOptions>,
      ) => Promise<TResponse>;

export type Stitch<TResponse, TOptions extends StitchConfig<TResponse>> =
    ExtractRFCParams<TOptions['path']> extends never
        ? StitchExecutor<TResponse, TOptions>
        : ParametricStitch<
              GetParamsType<TOptions>,
              StitchExecutor<TResponse, TOptions>
          >;
