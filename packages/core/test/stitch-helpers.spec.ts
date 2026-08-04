// Two pure helpers in src/stitch.ts that no spec exercises directly (compose is covered by
// composition.spec et al.): resolveTrace and the security-critical redactConfig.
//   resolveTrace — false → a no-op sink; 'console' → the console sink; a sink object → returned by
//                  reference; undefined → the ambient default. All are TraceSinks.
//   redactConfig — produces the public __config: it STRIPS the live store/auth/adapter/clock handles,
//                  re-derives `authScheme` from the live auth (never trusting an externally-set one),
//                  and normalises the live Surface `kind` to its id string; the rest survives.
import { systemClock } from '../src';
import { redactConfig, resolveTrace } from '../src/stitch';
import { httpSurface } from '../src/surface';
import type { ResolvedStitchConfig, TraceSink } from '../src/types';

// `kind` is required on a resolved config (ADR 0022 Decision 2), so a hand-built fixture carries the
// default surface unless a case overrides it — the cast keeps the rest of the shape loose.
const asResolved = (o: Record<string, unknown>): ResolvedStitchConfig => ({
    kind: httpSurface,
    ...o,
});

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
                    increment: () => 1,
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

    test('omits authScheme when there is no auth, and always emits the surface id', () => {
        // `kind` is no longer optional on a resolved config: `compose` selects `httpSurface` when
        // it is omitted (ADR 0022 Decision 2), so redaction always has an id to project.
        const redacted = redactConfig(
            asResolved({
                baseUrl: 'https://api.test',
                path: '/y',
                kind: httpSurface,
            }),
        );
        expect('authScheme' in redacted).toBe(false);
        expect(redacted.kind).toBe('http');
    });
});
