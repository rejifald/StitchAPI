// Direct unit tests for the pure retry helpers in src/resilience.ts. resilience.spec.ts exercises
// retry/Retry-After through the ENGINE; the formula and the header parser themselves are never
// asserted directly. These pin them:
//   backoffDelay   — fixed (constant), expo (2^(attempt-2), clamped at attempt 1), the backoff.max cap,
//                    and expo-jitter (the default) staying within [0, computed) and under backoff.max.
//   parseRetryAfter— nullish/empty → undefined, delta-seconds → ms (whitespace tolerated), an
//                    HTTP-date → ms-until-then against the clock, a past date clamped to 0, and an
//                    unparseable value → undefined.
import { backoffDelay, parseRetryAfter } from '../src/resilience';
import { manualClock } from '../src/test-clock';
import type { RetryOptions } from '../src/types';

describe('backoffDelay', () => {
    test('fixed backoff is constant regardless of attempt', () => {
        const o: RetryOptions = { backoff: { curve: 'fixed', base: 50 } };
        expect(backoffDelay(2, o)).toBe(50);
        expect(backoffDelay(7, o)).toBe(50);
    });

    test('expo backoff doubles from attempt 2 (base * 2^(attempt-2))', () => {
        const o: RetryOptions = { backoff: { curve: 'expo', base: 100 } };
        expect(backoffDelay(1, o)).toBe(100); // exp clamped to 0
        expect(backoffDelay(2, o)).toBe(100); // 100 * 2^0
        expect(backoffDelay(3, o)).toBe(200); // 100 * 2^1
        expect(backoffDelay(4, o)).toBe(400); // 100 * 2^2
    });

    test('expo backoff is capped at backoff.max', () => {
        const o: RetryOptions = {
            backoff: { curve: 'expo', base: 100, max: 1000 },
        };
        expect(backoffDelay(20, o)).toBe(1000);
    });

    test('backoff.base/backoff.max accept duration strings (P17 widening)', () => {
        const o: RetryOptions = {
            backoff: { curve: 'expo', base: '1s', max: '3s' },
        };
        expect(backoffDelay(2, o)).toBe(1000); // '1s' → 1000ms
        expect(backoffDelay(4, o)).toBe(3000); // 4000 clamped to '3s'
    });

    test('expo-jitter (the default) stays within [0, computed) and under backoff.max', () => {
        for (let i = 0; i < 100; i++) {
            const d = backoffDelay(3); // default backoff.base 100 → computed 200
            expect(d).toBeGreaterThanOrEqual(0);
            expect(d).toBeLessThan(200);
        }
        const capped: RetryOptions = { backoff: { base: 100, max: 500 } };
        for (let i = 0; i < 100; i++) {
            // attempt 10 → computed 25_600; jitter is large but the cap holds.
            expect(backoffDelay(10, capped)).toBeLessThanOrEqual(500);
        }
    });
});

describe('parseRetryAfter', () => {
    test('nullish / empty → undefined', () => {
        expect(parseRetryAfter(undefined)).toBeUndefined();
        expect(parseRetryAfter('')).toBeUndefined();
        expect(parseRetryAfter('   ')).toBeUndefined();
    });

    test('delta-seconds → milliseconds (whitespace tolerated)', () => {
        expect(parseRetryAfter('120')).toBe(120_000);
        expect(parseRetryAfter('  120  ')).toBe(120_000);
        expect(parseRetryAfter('0')).toBe(0);
    });

    test('an HTTP-date → ms until then, measured against the clock', () => {
        const base = 1_700_000_000_000; // a round-second epoch (HTTP-date has 1s resolution)
        const header = new Date(base + 10_000).toUTCString();
        expect(parseRetryAfter(header, manualClock(base))).toBe(10_000);
    });

    test('a past HTTP-date clamps to 0', () => {
        const base = 1_700_000_000_000;
        const header = new Date(base - 5_000).toUTCString();
        expect(parseRetryAfter(header, manualClock(base))).toBe(0);
    });

    test('an unparseable value → undefined', () => {
        expect(parseRetryAfter('not-a-date')).toBeUndefined();
    });
});
