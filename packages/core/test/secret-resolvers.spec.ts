// The REQUIRED secret resolvers: `env` (an environment variable) and `credential.from` (an
// arbitrary injected source). Both resolve at call time and throw on a missing OR empty value — a
// blank credential is never silently sent. (The optional, never-throwing path is `env.optional`,
// covered in optional-env.spec.ts.) The thunks are exercised directly here — no engine, no network.
import { credential, env } from '../src/auth';

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

describe('credential.from() (required)', () => {
    test('resolves via a function source `(name) => value`', () => {
        const source = (name: string): string | undefined =>
            name === 'GITHUB_TOKEN' ? 'fn-secret' : undefined;
        expect(credential.from(source, 'GITHUB_TOKEN')()).toBe('fn-secret');
    });

    test('resolves via an object source `{ get(name) }`', () => {
        const source = {
            get(name: string): string | undefined {
                return name === 'GITHUB_TOKEN' ? 'obj-secret' : undefined;
            },
        };
        expect(credential.from(source, 'GITHUB_TOKEN')()).toBe('obj-secret');
    });

    test('throws when the source returns undefined', () => {
        expect(() => credential.from(() => undefined, 'MISSING')()).toThrow(
            /missing secret MISSING/,
        );
        expect(() =>
            credential.from({ get: () => undefined }, 'MISSING')(),
        ).toThrow(/missing secret MISSING/);
    });

    test("throws when the source returns empty ('')", () => {
        expect(() => credential.from(() => '', 'BLANK')()).toThrow(
            /missing secret BLANK/,
        );
        expect(() => credential.from({ get: () => '' }, 'BLANK')()).toThrow(
            /missing secret BLANK/,
        );
    });
});
