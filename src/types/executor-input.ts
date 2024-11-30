import { GetBodyType } from './get-body-type';
import { GetQueryType } from './get-query-type';
import { GetResponseType } from './get-response-type';
import { StitchConfig } from './stitch';
import { ExtractRFCParams } from './utils/get-template-type';

export interface ExecutorInput<TOptions> {
    params: ExtractRFCParams<
        TOptions extends string ? TOptions : never
    > extends never
        ? never
        : ExtractRFCParams<TOptions extends string ? TOptions : never>;
    body: GetBodyType<TOptions>;
    query: GetQueryType<TOptions>;
    config: StitchConfig<GetResponseType<TOptions>>;
}
