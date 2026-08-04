// The public API surface of the package (src/index.ts). smoke.spec.ts exercises `stitch` end-to-end
// but nothing pins the EXPORT surface itself, so an accidental removal/rename of a public symbol
// would slip past the test suite (only attw/build catches it, late). This guards the contract: the
// documented value exports are present and of the expected kind.
import * as api from '../src';
import * as authApi from '../src/auth';
import type { AdapterResponse } from '../src/types';

// Every documented function/guard export (systemClock is an object; the error classes are below).
const FUNCTIONS = [
    'stitch',
    'drift',
    'graphql',
    'seam',
    'fetchAdapter',
    'axiosAdapter',
    'xhrAdapter',
    'createTrace',
    'consoleSink',
    'fileSink',
    'multiplex',
    'loggerSink',
    'otlpSink',
    'otlpHttpExporter',
    'toOtlpJson',
    'memoryStore',
    'validate',
    'compile',
    'isStitch',
    'isSeam',
    // The verdict (ADR 0022 Decision 2), public because a surface author must compose it: an
    // `interpret` hook REPLACES the default rather than layering on it, so a surface with its own
    // body rules needs this to keep the caller's `verdict` config working. The one composition
    // point — its narrower and wider siblings are pinned ABSENT below.
    'verdictOf',
] as const;

// The other two scopes of the same decision, pinned ABSENT from the root. `classifyStatus` (the
// status alone) answers the engine's transport-health question and has no surface-author use;
// `httpInterpret` is the http surface's own hook, reachable as `httpSurface.interpret`. Three names
// on the barrel for one decision invites composing the wrong one — which is precisely the mistake
// that put a flag-failed `200` through the circuit's transport-failure path.
const INTERNAL_VERDICT_SCOPES = ['classifyStatus', 'httpInterpret'] as const;

// The auth surface moved to its own subpath (ADR 0021). Pinned in BOTH directions: present on
// `stitchapi/auth`, and ABSENT from the root — a re-export there would quietly put oauth2 and
// cookieSession back on every consumer's `import { stitch }` path, which is the point of the split.
const AUTH_FUNCTIONS = [
    'bearer',
    'apiKey',
    'basic',
    'cookieSession',
    'oauth2',
    'env',
    'optionalEnv',
    'secretsFile',
    'secretFrom',
] as const;

describe('public API surface (src/index.ts)', () => {
    test.each(FUNCTIONS)('exports %s as a function', (name) => {
        expect(typeof (api as Record<string, unknown>)[name]).toBe('function');
    });

    test.each(INTERNAL_VERDICT_SCOPES)(
        'does NOT export %s — one composition point, not three',
        (name) => {
            expect(name in (api as Record<string, unknown>)).toBe(false);
        },
    );

    test('httpInterpret stays reachable as the http surface’s own hook', () => {
        expect(typeof api.httpSurface.interpret).toBe('function');
    });

    test.each(AUTH_FUNCTIONS)('does NOT re-export %s from the root', (name) => {
        expect(name in (api as Record<string, unknown>)).toBe(false);
    });

    test('exports the built-in surfaces with their stable ids', () => {
        expect(api.httpSurface.id).toBe('http');
        expect(api.graphqlSurface.id).toBe('graphql');
    });

    test('exports systemClock with the Clock shape', () => {
        expect(typeof api.systemClock.now).toBe('function');
        expect(typeof api.systemClock.sleep).toBe('function');
        expect(typeof api.systemClock.setTimer).toBe('function');
        expect(typeof api.systemClock.clearTimer).toBe('function');
    });

    test('exports the error classes (both extend Error)', () => {
        const response: AdapterResponse = {
            status: 429,
            headers: {},
            body: {},
        };
        const rate = new api.RateLimitError({ status: 429, response });
        expect(rate).toBeInstanceOf(Error);
        expect(rate.status).toBe(429);
        expect(new api.StitchError('x')).toBeInstanceOf(Error);
    });
});

describe('public API surface (src/auth.ts → stitchapi/auth)', () => {
    test.each(AUTH_FUNCTIONS)('exports %s as a function', (name) => {
        expect(typeof (authApi as Record<string, unknown>)[name]).toBe(
            'function',
        );
    });

    // The subpath carries the auth surface and nothing else — no accidental re-export of the
    // engine, which would defeat the split from the other direction.
    test('exports exactly the auth surface, nothing more', () => {
        expect(Object.keys(authApi).sort()).toEqual([...AUTH_FUNCTIONS].sort());
    });
});
