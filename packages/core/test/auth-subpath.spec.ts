// `stitchapi/auth` holds the five strategy factories. They are subpath-ONLY: the root barrel does
// not re-export them, so a consumer that never authenticates never pays for the oauth2 token dance
// or the cookieSession jar — including the consumers tree-shaking cannot help (a CJS
// `require('stitchapi')`, or a bundler that gives up on a re-export barrel).
//
// public-api-surface.spec.ts pins what the ROOT exports; this pins the other half of that contract.
import * as root from '../src';
import * as auth from '../src/auth';

describe('stitchapi/auth subpath', () => {
    test('exports all five strategy factories', () => {
        for (const name of [
            'bearer',
            'apiKey',
            'basic',
            'oauth2',
            'cookieSession',
        ]) {
            expect(typeof (auth as Record<string, unknown>)[name]).toBe(
                'function',
            );
        }
    });

    test('the root barrel does NOT re-export them (that is the point of the subpath)', () => {
        for (const name of [
            'bearer',
            'apiKey',
            'basic',
            'oauth2',
            'cookieSession',
        ]) {
            expect(name in root).toBe(false);
        }
    });

    test('`AuthStrategy` stays reachable from the root, so BYO strategies need no subpath', () => {
        // A hand-written strategy is just an object with `apply` — it must typecheck against the
        // root-exported interface and be accepted by `stitch` with no import from this subpath.
        const byo: import('../src').AuthStrategy = {
            name: 'byo',
            apply(req) {
                req.headers['x-byo'] = '1';
            },
        };
        expect(typeof byo.apply).toBe('function');
    });

    test('a strategy from the subpath is the same shape the root type describes', async () => {
        const strategy: import('../src').AuthStrategy = auth.bearer(
            () => 'tok',
        );
        const req = { headers: {} as Record<string, string>, url: 'https://x' };
        await strategy.apply(req as never, {} as never);
        expect(req.headers['authorization']).toBe('Bearer tok');
    });

    test('bindings are NOT duplicated here — the subpath re-exports no resolver', () => {
        // `env`/`secretsFile`/… belong to `stitchapi/bindings` and stay on the root too. If they
        // reappeared here the two surfaces could drift, which is what the bindings split prevents.
        for (const name of ['env', 'optionalEnv', 'secretsFile', 'secretFrom'])
            expect(name in auth).toBe(false);
    });
});
