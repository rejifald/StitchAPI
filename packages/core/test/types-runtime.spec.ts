// The three runtime exports of src/types.ts: the isStitch / isSeam guards and the StitchError class.
// They're used pervasively but barely asserted head-on (isStitch has a single positive check;
// isSeam and the StitchError constructor have none). These pin their contracts:
//   isStitch    — true only for a callable carrying __stitch === true (a non-function with the flag,
//                 a plain function, and non-values are all false);
//   isSeam      — true only for a non-null object carrying __seam === true (a function with the flag,
//                 null, and primitives are all false);
//   StitchError — name 'StitchError', attempts defaults to 0, status/body/url/cause carried.
//   isStitchError — true for StitchError, every subclass, and an error from a SECOND copy of the
//                 module (the dual-package hazard); false for a look-alike that only borrows the name.
import { RateLimitError, seam, stitch } from '../src';
import { StitchError, isSeam, isStitch, isStitchError } from '../src/types';

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

describe('isStitchError', () => {
    const rateLimited = (): RateLimitError =>
        new RateLimitError({
            status: 429,
            retryAfter: 1000,
            response: { status: 429, headers: {}, body: { error: 'slow' } },
        });

    test('true for StitchError and for a subclass whose `name` is its own', () => {
        expect(isStitchError(new StitchError('boom'))).toBe(true);
        const rl = rateLimited();
        // The case the hosts' old `name === 'StitchError'` check missed (#867).
        expect(rl.name).toBe('RateLimitError');
        expect(isStitchError(rl)).toBe(true);
        class TimeoutLike extends StitchError {
            constructor() {
                super('timed out');
                this.name = 'TimeoutLike';
            }
        }
        expect(isStitchError(new TimeoutLike())).toBe(true);
    });

    test('true for an error raised by a second copy of the module (dual-package hazard)', async () => {
        // A fresh module registry stands in for the CJS build beside the ESM one: its classes
        // are distinct, so `instanceof` fails in both directions while the brand still matches.
        vi.resetModules();
        const copy = await import('../src/types');
        const copyResilience = await import('../src/resilience');
        expect(copy.StitchError).not.toBe(StitchError);

        const foreign = new copy.StitchError('from the other copy');
        expect(foreign instanceof StitchError).toBe(false);
        expect(isStitchError(foreign)).toBe(true);
        expect(copy.isStitchError(new StitchError('from this copy'))).toBe(
            true,
        );

        const foreignRl = new copyResilience.RateLimitError({
            status: 429,
            response: { status: 429, headers: {}, body: null },
        });
        expect(foreignRl instanceof StitchError).toBe(false);
        expect(isStitchError(foreignRl)).toBe(true);
    });

    test('false for a look-alike that only borrows the name, a copy, and non-errors', () => {
        expect(
            isStitchError(
                Object.assign(new Error('x'), { name: 'StitchError' }),
            ),
        ).toBe(false);
        expect(isStitchError(new Error('plain'))).toBe(false);
        // The brand is non-enumerable: a spread or a JSON round-trip does not carry it.
        const err = new StitchError('boom', { status: 502 });
        expect(isStitchError(Object.assign({}, err))).toBe(false);
        expect(isStitchError(JSON.parse(JSON.stringify(err)))).toBe(false);
        for (const v of [null, undefined, 0, 'StitchError', {}])
            expect(isStitchError(v)).toBe(false);
    });
});
