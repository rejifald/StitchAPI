// Pins docs/GAP-AUDIT.md §1.8: keychain() was a plaintext-JSON spike — renamed to secretsFile()
// (the deprecated `keychain` alias has since been removed entirely).
import { secretsFile, stitch } from '../../src';
import { basic } from '../../src/auth';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-secrets-file-${process.pid}.jsonl`,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp secrets file under a temp HOME and return the temp HOME path. */
function makeTempHome(secrets: Record<string, string>): string {
    const home = join(tmpdir(), `stitch-home-${process.pid}-${Date.now()}`);
    const dir = join(home, '.stitch');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'secrets.json'), JSON.stringify(secrets), 'utf8');
    return home;
}

// ---------------------------------------------------------------------------
// Env snapshot / restore
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
    savedEnv = {
        HOME: process.env['HOME'],
        MY_SECRET: process.env['MY_SECRET'],
        MY_FALLBACK: process.env['MY_FALLBACK'],
    };
});

afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) {
            Reflect.deleteProperty(process.env, k);
        } else {
            process.env[k] = v;
        }
    }
});

// ---------------------------------------------------------------------------
// §1.8-A  secretsFile() is exported
// ---------------------------------------------------------------------------

test('secretsFile is exported from the package (not undefined)', () => {
    expect(secretsFile).toBeDefined();
    expect(typeof secretsFile).toBe('function');
});

// ---------------------------------------------------------------------------
// §1.8-B  secretsFile() reads ~/.stitch/secrets.json
// ---------------------------------------------------------------------------

test('secretsFile() reads a value from ~/.stitch/secrets.json via HOME', () => {
    const home = makeTempHome({ MY_SECRET: 'from-file' });
    process.env['HOME'] = home;
    Reflect.deleteProperty(process.env, 'MY_SECRET');

    const resolver = secretsFile('MY_SECRET');
    expect(resolver()).toBe('from-file');

    rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §1.8-C  secretsFile() falls back to env when the file is absent
// ---------------------------------------------------------------------------

test('secretsFile() falls back to env var when secrets file is absent', () => {
    // Point HOME somewhere without a .stitch/secrets.json
    const home = join(
        tmpdir(),
        `stitch-empty-home-${process.pid}-${Date.now()}`,
    );
    mkdirSync(home, { recursive: true });
    process.env['HOME'] = home;
    process.env['MY_FALLBACK'] = 'from-env';

    const resolver = secretsFile('MY_FALLBACK');
    expect(resolver()).toBe('from-env');

    rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §1.8-E  basic() encodes user:pass as Base64 in Authorization: Basic <token>
// ---------------------------------------------------------------------------

let server: MockServer;

beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});

test('basic() sends Authorization: Basic <base64(user:pass)> header', async () => {
    server.route('GET', '/secure', { body: { ok: true } });

    const call = stitch({
        baseUrl: server.url,
        path: '/secure',
        auth: basic({ user: 'alice', pass: 's3cret' }),
    });

    await expect(call()).resolves.toEqual({ ok: true });

    const req = server.calls('/secure')[0];
    expect(req).toBeDefined();

    const expected = `Basic ${Buffer.from('alice:s3cret').toString('base64')}`;
    expect(req!.headers['authorization']).toBe(expected);
});
