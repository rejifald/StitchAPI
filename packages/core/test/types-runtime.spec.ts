// The three runtime exports of src/types.ts: the isStitch / isSeam guards and the StitchError class.
// They're used pervasively but barely asserted head-on (isStitch has a single positive check;
// isSeam and the StitchError constructor have none). These pin their contracts:
//   isStitch    — true only for a callable carrying __stitch === true (a non-function with the flag,
//                 a plain function, and non-values are all false);
//   isSeam      — true only for a non-null object carrying __seam === true (a function with the flag,
//                 null, and primitives are all false);
//   StitchError — name 'StitchError', attempts defaults to 0, status/body/url/cause carried.
import { seam, stitch } from '../src';
import { StitchError, isSeam, isStitch } from '../src/types';

describe('isStitch', () => {
    test('true for a real stitch (callable with __stitch)', () => {
        expect(isStitch(stitch('https://api.test/x'))).toBe(true);
    });

    test('false for a non-callable carrying the flag, a plain function, and non-values', () => {
        expect(isStitch({ __stitch: true })).toBe(false); // must be callable
        expect(isStitch(() => undefined)).toBe(false); // no flag
        expect(isStitch(null)).toBe(false);
        expect(isStitch(undefined)).toBe(false);
        expect(isStitch('x')).toBe(false);
    });
});

describe('isSeam', () => {
    test('true for a real seam (object with __seam)', () => {
        expect(isSeam(seam({}))).toBe(true);
    });

    test('false for an object without the flag, a flagged function, null, and primitives', () => {
        expect(isSeam({})).toBe(false);
        expect(isSeam(Object.assign(() => undefined, { __seam: true }))).toBe(
            false,
        ); // seams are objects, not functions
        expect(isSeam(null)).toBe(false);
        expect(isSeam(42)).toBe(false);
    });
});

describe('StitchError', () => {
    test('defaults: name, attempts 0, no status/body/url', () => {
        const err = new StitchError('boom');
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('StitchError');
        expect(err.message).toBe('boom');
        expect(err.attempts).toBe(0);
        expect(err.status).toBeUndefined();
        expect(err.body).toBeUndefined();
        expect(err.url).toBeUndefined();
    });

    test('carries status / attempts / body / url and the error cause', () => {
        const cause = new Error('root');
        const err = new StitchError('failed', {
            status: 503,
            attempts: 3,
            body: { error: 'busy' },
            url: 'https://api.test/x',
            cause,
        });
        expect(err.status).toBe(503);
        expect(err.attempts).toBe(3);
        expect(err.body).toEqual({ error: 'busy' });
        expect(err.url).toBe('https://api.test/x');
        expect(err.cause).toBe(cause);
    });
});
