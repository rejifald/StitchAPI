import { stitch } from '../src';
import { axiosAdapter } from '../src/adapters/axios';

import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

const mock = new MockAdapter(axios);

mock.onGet('https://reqres.in/api/users/2').reply(200, {
    success: true,
    error: {},
    total: 0,
});

describe('axiosAdapter', () => {
    it('should return response data', async () => {
        const stitched = stitch({
            path: 'https://reqres.in/api/users/{id}',
            method: 'GET',
            adapter: axiosAdapter(),
        });

        const response = await stitched({
            params: {
                id: 2,
            },
        });
        expect(response).toEqual({
            success: true,
            error: {},
            total: 0,
        });
    });
});
