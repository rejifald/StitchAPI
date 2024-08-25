import { stitch } from '../src/stitch';
import { GetUserResponseSchema } from './__mocks__/get-user-response-schema';
import { GetUsersResponseSchema } from './__mocks__/get-users-response-schema';
import getUserResponseMock from './__mocks__/get_user_response.json';

import fetch from 'jest-fetch-mock';
import { z } from 'zod';

describe('validation', () => {
    beforeEach(() => {
        fetch.mockResponse(JSON.stringify(getUserResponseMock));
    });
    it('Should pass if response is valid', async () => {
        const result = await stitch({
            path: 'https://reqres.in/api/users/{id}',
            validate: GetUserResponseSchema,
        })({});

        expect(result).toEqual(getUserResponseMock);
    });

    it('Should throw if response is invalid', async () => {
        await expect(() =>
            stitch({
                path: 'https://reqres.in/api/users/',
                validate: GetUsersResponseSchema,
            })(),
        ).rejects.toEqual(
            new Error(
                'Validation error: Required at "page"; Required at "per_page"; Required at "total"; Required at "total_pages"; Expected array, received object at "data"',
            ),
        );
    });

    it('Should validate query', async () => {
        await expect(() =>
            stitch({
                path: 'https://reqres.in/api/users/',
                validate: {
                    body: z.object({
                        email: z.string(),
                        id: z.object({}),
                        name: z.string(),
                    }),
                },
            })(),
        ).rejects.toEqual(
            new Error(
                'Invalid body, reason: Validation error: Required at "email"; Required at "id"; Required at "name"',
            ),
        );
    });
});
