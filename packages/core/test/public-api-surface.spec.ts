// The public API surface of the package (src/index.ts). smoke.spec.ts exercises `stitch` end-to-end
// but nothing pins the EXPORT surface itself, so an accidental removal/rename of a public symbol
// would slip past the test suite (only attw/build catches it, late). This guards the contract: the
// documented value exports are present and of the expected kind.
import * as api from '../src';
import type { AdapterResponse } from '../src/types';

// Every documented function/guard export (systemClock is an object; the error classes are below).
const FUNCTIONS = [
    'stitch',
    'drift',
    'graphql',
    'seam',
    // NOTE: bearer/apiKey/basic/cookieSession/oauth2 are deliberately NOT here — they are
    // subpath-only (`stitchapi/auth`), pinned by auth-subpath.spec.ts. The binding resolvers below
    // DO stay on the root: they are not auth-specific.
    'env',
    'optionalEnv',
    'secretsFile',
    'secretFrom',
    'fetchAdapter',
    'axiosAdapter',
    'xhrAdapter',
    'createTrace',
    'consoleSink',
    'fileSink',
    'multiplex',
    'loggerSink',
    'otlpTrace',
    'otlpHttpExporter',
    'toOtlpJson',
    'memoryStore',
    'validate',
    'compile',
    'isStitch',
    'isSeam',
] as const;

describe('public API surface (src/index.ts)', () => {
    test.each(FUNCTIONS)('exports %s as a function', (name) => {
        expect(typeof (api as Record<string, unknown>)[name]).toBe('function');
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
