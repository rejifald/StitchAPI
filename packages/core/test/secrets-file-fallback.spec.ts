// secretsFile() fallback-ladder branches (src/auth.ts) that gaps/secrets-file-rename.spec.ts leaves
// open. That suite covers "file has the key → from file" and "file absent → env". The remaining
// rungs go untested:
//   - the file EXISTS but lacks the requested key → fall back to the env var;
//   - neither the file nor the env has it → throw "missing secret";
//   - a non-string value in the file is coerced via String();
//   - malformed JSON is swallowed (try/catch) and the env var is used.
import { secretsFile } from '../src/auth';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Write raw secrets.json content under a fresh temp HOME; return [home, cleanup].
function tempHome(secretsJson: string): [string, () => void] {
    const home = join(
        tmpdir(),
        `stitch-secrets-fallback-${process.pid}-${homeSeq++}`,
    );
    mkdirSync(join(home, '.stitch'), { recursive: true });
    writeFileSync(join(home, '.stitch', 'secrets.json'), secretsJson, 'utf8');
    return [
        home,
        () => {
            rmSync(home, { recursive: true, force: true });
        },
    ];
}
let homeSeq = 0;

let saved: Record<string, string | undefined>;
beforeEach(() => {
    saved = {
        HOME: process.env['HOME'],
        MY_SECRET: process.env['MY_SECRET'],
        MY_FALLBACK: process.env['MY_FALLBACK'],
        PORT: process.env['PORT'],
    };
});
afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
    }
});

describe('secretsFile() fallback ladder', () => {
    test('a file that lacks the key falls back to the env var', () => {
        const [home, cleanup] = tempHome(JSON.stringify({ OTHER: 'x' }));
        process.env['HOME'] = home;
        process.env['MY_SECRET'] = 'from-env';
        try {
            expect(secretsFile('MY_SECRET')()).toBe('from-env');
        } finally {
            cleanup();
        }
    });

    test('throws "missing secret" when neither the file nor the env has it', () => {
        const [home, cleanup] = tempHome(JSON.stringify({ OTHER: 'x' }));
        process.env['HOME'] = home;
        Reflect.deleteProperty(process.env, 'MY_SECRET');
        try {
            expect(() => secretsFile('MY_SECRET')()).toThrow(
                /missing secret MY_SECRET/,
            );
        } finally {
            cleanup();
        }
    });

    test('coerces a non-string file value to a string', () => {
        const [home, cleanup] = tempHome('{ "PORT": 8080 }');
        process.env['HOME'] = home;
        Reflect.deleteProperty(process.env, 'PORT');
        try {
            expect(secretsFile('PORT')()).toBe('8080');
        } finally {
            cleanup();
        }
    });

    test('swallows malformed JSON and falls back to the env var', () => {
        const [home, cleanup] = tempHome('this is not json');
        process.env['HOME'] = home;
        process.env['MY_FALLBACK'] = 'from-env';
        try {
            expect(secretsFile('MY_FALLBACK')()).toBe('from-env');
        } finally {
            cleanup();
        }
    });
});
