import { stitch } from '../src/stitch';

import fetch from 'jest-fetch-mock';

describe('response assertation', () => {
    beforeEach(() => {
        fetch.mockResponse(
            JSON.stringify({
                error: 'Unknwon error',
            }),
        );
    });

    it('should assert response', async () => {
        const assert = (response) => Boolean(response.error);
        const stitched = stitch({
            assert,
        });
        expect(() => stitched()).rejects.toEqual(new Error('Assertion failed'));
    });

    it('should return asserted error message', async () => {
        const assert = () => "I'm an error";
        const stitched = stitch({
            assert,
        });
        expect(() => stitched()).rejects.toEqual(new Error("I'm an error"));
    });
});
