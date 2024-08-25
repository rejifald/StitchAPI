import { stitch } from '../src';
import { GetUsersResponseSchema } from './__mocks__/get-users-response-schema';
import getUsersResponseMock from './__mocks__/get_users_response.json';

import fetch from 'jest-fetch-mock';

describe('unwrap', () => {
    beforeEach(() => {
        fetch.mockResponse(JSON.stringify(getUsersResponseMock));
    });
    it('Should unwrap response', async () => {
        const response = await stitch({
            path: 'https://reqres.in/api/users',
            unwrap: 'data',
            validate: {
                response: GetUsersResponseSchema,
            },
        })();

        expect(fetch).toHaveBeenCalledWith('https://reqres.in/api/users', {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
        });

        expect(response).toEqual(getUsersResponseMock.data);
    });
});
