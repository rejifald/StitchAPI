import { AdapterInput } from '@/types/adapter';

import 'cross-fetch/polyfill';
import isEmpty from 'lodash/isEmpty';
import merge from 'lodash/merge';

export const fetchAdapter =
    (initial: RequestInit = {}) =>
    async ({ url, method, body }: AdapterInput): Promise<unknown> => {
        const response = await fetch(
            url,
            merge(initial, {
                method,
                body: isEmpty(body) ? undefined : JSON.stringify(body),
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
            }),
        );
        return response.json();
    };
