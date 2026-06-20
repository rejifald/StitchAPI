// Two pure helpers in src/stitch.ts that no spec exercises directly (compose is covered by
// composition.spec et al.): resolveTrace and the security-critical redactConfig.
//   resolveTrace — false → a no-op sink; 'console' → the console sink; a sink object → returned by
//                  reference; undefined → the ambient default. All are TraceSinks.
//   redactConfig — produces the public __config: it STRIPS the live store/auth/adapter/clock handles,
//                  re-derives `authScheme` from the live auth (never trusting an externally-set one),
//                  and normalises the live Surface `kind` to its id string; the rest survives.
import { systemClock } from '../src';
import { redactConfig, resolveTrace } from '../src/stitch';
import type { ResolvedStitchConfig, TraceSink } from '../src/types';

const asResolved = (o: Record<string, unknown>): ResolvedStitchConfig => o;

describe('resolveTrace', () => {
    test('returns a provided sink by reference', () => {
        const sink: TraceSink = { handle: () => undefined };
        expect(resolveTrace(sink)).toBe(sink);
    });

    test('false yields a distinct no-op sink', () => {
        const sink: TraceSink = { handle: () => undefined };
        const t = resolveTrace(false);
        expect(typeof t.handle).toBe('function');
        expect(t).not.toBe(sink);
    });

    test("'console' and undefined each yield a TraceSink", () => {
        expect(typeof resolveTrace('console').handle).toBe('function');
        expect(typeof resolveTrace(undefined).handle).toBe('function');
    });
});

describe('redactConfig', () => {
    test('strips live handles, re-derives authScheme, and normalises kind to its id', () => {
        const redacted = redactConfig(
            asResolved({
                baseUrl: 'https://api.test',
                path: '/x',
                method: 'GET',
                store: {
                    get: () => undefined,
                    set: () => undefined,
                    incr: () => 1,
                },
                adapter: () => Promise.resolve({}),
                clock: systemClock,
                auth: { scheme: { type: 'http', scheme: 'bearer' } },
                authScheme: { type: 'apiKey' }, // externally set — must be overwritten, not trusted
                kind: { id: 'graphql' }, // a live Surface
            }),
        );
        // live, secret-bearing handles are gone
        expect('store' in redacted).toBe(false);
        expect('auth' in redacted).toBe(false);
        expect('adapter' in redacted).toBe(false);
        expect('clock' in redacted).toBe(false);
        // authScheme re-derived from the live auth (NOT the externally-set value)
        expect(redacted.authScheme).toEqual({ type: 'http', scheme: 'bearer' });
        // the live Surface is normalised to its id string
        expect(redacted.kind).toBe('graphql');
        // the rest survives
        expect(redacted.baseUrl).toBe('https://api.test');
        expect(redacted.path).toBe('/x');
    });

    test('omits authScheme and kind when there is no auth / no surface', () => {
        const redacted = redactConfig(
            asResolved({ baseUrl: 'https://api.test', path: '/y' }),
        );
        expect('authScheme' in redacted).toBe(false);
        expect('kind' in redacted).toBe(false);
    });
});
