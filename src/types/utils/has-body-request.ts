import { GetRequestMethod } from './get-request-method';

export type HasBodyRequest<TMethod> =
    GetRequestMethod<TMethod> extends
        | 'GET'
        | 'DELETE'
        | 'HEAD'
        | 'OPTIONS'
        | 'TRACE'
        ? true
        : false;
