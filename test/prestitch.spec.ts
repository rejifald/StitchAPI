import getUsersResponseMock from './__mocks__/get_users_response.json';

import { prestitch } from '@/prestitch';

import fetch from 'jest-fetch-mock';

describe('prestitch', () => {
    beforeEach(() => {
        fetch.mockResponse(JSON.stringify(getUsersResponseMock));
    });
    it('should return a function that calls stitch with the merged options', () => {
        prestitch({ baseUrl: 'https://reqres.in/api' })({
            path: '/users',
            method: 'GET',
            baseUrl: 'https://reqres.in/api',
        })();
        expect(fetch).toHaveBeenCalledWith('https://reqres.in/api/users', {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
        });
    });

    it("should return a function that calls stitch with the merged options, even if it's a string", () => {
        prestitch('/user')('/users')();
        expect(fetch).toHaveBeenCalledWith('/users', {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
        });
    });

    it('should return a function that calls stitch with the merged options, even if the first argument is a string', () => {
        prestitch('/user')({
            baseUrl: 'https://reqres.in/api',
            path: '/users',
            method: 'GET',
        })();
        expect(fetch).toHaveBeenCalledWith('/users', {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
        });
    });

    it('should return a function that calls stitch with the merged options, even if the first argument is a string', () => {
        prestitch({
            baseUrl: 'https://reqres.in/api',
            method: 'GET',
            path: '/user',
        })('/users')();
        expect(fetch).toHaveBeenCalledWith('/users', {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
        });
    });
});
