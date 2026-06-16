// The REQUIRED secret resolvers: `env` (an environment variable) and `secretFrom` (an arbitrary
// injected source). Both resolve at call time and throw on a missing OR empty value — a blank
// credential is never silently sent. (The optional, never-throwing path is `optionalEnv`, covered
// in optional-env.spec.ts.) The thunks are exercised directly here — no engine, no network.
import { env, secretFrom } from '../src';

describe('env() (required)', () => {
    test('resolves the variable when set', () => {
        process.env['MY_TOKEN'] = 'sekret-value';
        try {
            expect(env('MY_TOKEN')()).toBe('sekret-value');
        } finally {
            delete process.env['MY_TOKEN'];
        }
    });

    test('throws when the variable is unset', () => {
        delete process.env['MY_TOKEN'];
        expect(() => env('MY_TOKEN')()).toThrow(/missing env var MY_TOKEN/);
    });

    test("throws when the variable is set but empty ('')", () => {
        const saved = process.env['MY_TOKEN'];
        process.env['MY_TOKEN'] = '';
        try {
            expect(() => env('MY_TOKEN')()).toThrow(/missing env var MY_TOKEN/);
        } finally {
            if (saved === undefined) delete process.env['MY_TOKEN'];
            else process.env['MY_TOKEN'] = saved;
        }
    });
});

describe('secretFrom() (required)', () => {
    test('resolves via a function source `(name) => value`', () => {
        const source = (name: string): string | undefined =>
            name === 'GITHUB_TOKEN' ? 'fn-secret' : undefined;
        expect(secretFrom(source, 'GITHUB_TOKEN')()).toBe('fn-secret');
    });

    test('resolves via an object source `{ get(name) }`', () => {
        const source = {
            get(name: string): string | undefined {
                return name === 'GITHUB_TOKEN' ? 'obj-secret' : undefined;
            },
        };
        expect(secretFrom(source, 'GITHUB_TOKEN')()).toBe('obj-secret');
    });

    test('throws when the source returns undefined', () => {
        expect(() => secretFrom(() => undefined, 'MISSING')()).toThrow(
            /missing secret MISSING/,
        );
        expect(() => secretFrom({ get: () => undefined }, 'MISSING')()).toThrow(
            /missing secret MISSING/,
        );
    });

    test("throws when the source returns empty ('')", () => {
        expect(() => secretFrom(() => '', 'BLANK')()).toThrow(
            /missing secret BLANK/,
        );
        expect(() => secretFrom({ get: () => '' }, 'BLANK')()).toThrow(
            /missing secret BLANK/,
        );
    });
});
