// @stitchapi/shell — the security model is the load-bearing part, so the suite proves it
// structurally: argv arrives as literal arguments (no shell interprets metacharacters), the env is
// fail-closed (no process.env leak), a non-zero exit is a StitchError, and the resilience chain
// (timeout) wraps the subprocess. The node binary itself is the controlled subprocess.
import { shell } from '../src/index';

import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

const NODE = process.execPath; // an absolute path — no PATH needed to resolve it

test('runs a static command; stdout is the result (text mode)', async () => {
    const echo = shell(NODE);
    await expect(
        echo({ body: ['-e', 'process.stdout.write("hello")'] }),
    ).resolves.toBe('hello');
});

test('the envelope form shell({ command }) is the same surface', async () => {
    const echo = shell({ command: NODE });
    await expect(
        echo({ body: ['-e', 'process.stdout.write("hello")'] }),
    ).resolves.toBe('hello');
});

test('responseType: "json" parses stdout', async () => {
    const j = shell<{ a: number }>(NODE, { responseType: 'json' });
    await expect(
        j({ body: ['-e', 'process.stdout.write(JSON.stringify({a:1}))'] }),
    ).resolves.toEqual({ a: 1 });
});

test('argv elements are literal — shell metacharacters are inert (there is no shell)', async () => {
    const dump = shell<string[]>(NODE, { responseType: 'json' });
    const evil = '; rm -rf / `whoami` $HOME && echo pwned';
    const out = await dump({
        body: [
            '-e',
            'process.stdout.write(JSON.stringify(process.argv))',
            evil,
        ],
    });
    // The whole metacharacter blob arrives as ONE intact argv element — never split, expanded, or
    // interpreted. Injection is impossible by construction, not by escaping.
    expect(out).toContain(evil);
    expect(out.filter((a) => a === evil)).toHaveLength(1);
});

test('fail-closed env: process.env does NOT leak into the subprocess', async () => {
    process.env['SHELL_SECRET_LEAK'] = 'nope';
    try {
        const dumpEnv = shell<Record<string, string>>(NODE, {
            responseType: 'json',
        });
        const out = await dumpEnv({
            body: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
        });
        expect(out['SHELL_SECRET_LEAK']).toBeUndefined();
    } finally {
        delete process.env['SHELL_SECRET_LEAK'];
    }
});

test('explicit env IS passed to the subprocess', async () => {
    const dumpEnv = shell<Record<string, string>>({
        command: NODE,
        responseType: 'json',
        env: { FOO: 'bar' },
    });
    const out = await dumpEnv({
        body: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
    });
    expect(out['FOO']).toBe('bar');
});

test('a non-zero exit surfaces as a StitchError carrying the exit code + stderr', async () => {
    const fail = shell(NODE);
    await expect(
        fail({
            body: ['-e', 'process.stderr.write("boom"); process.exit(3)'],
        }),
    ).rejects.toMatchObject({
        status: 500,
        body: { exitCode: 3, stderr: 'boom' },
    });
});

test('arguments must be a string[] — a non-array body is rejected', async () => {
    const x = shell(NODE);
    await expect(
        x({ body: { not: 'an array' } as unknown as string[] }),
    ).rejects.toThrow(/string\[\]/);
});

test('the resilience chain wraps the subprocess — a per-attempt timeout aborts it', async () => {
    const slow = shell(NODE, { timeout: { perAttempt: 50 } });
    await expect(
        slow({ body: ['-e', 'setTimeout(() => {}, 5000)'] }),
    ).rejects.toBeTruthy();
});

test('a spawn failure (missing binary) rejects as a transport error — NOT a 500 exit response', async () => {
    // ENOENT carries a STRING `code`, so `runCommand` rejects (transport error) rather than
    // resolving to a status-500 "response" the way a non-zero EXIT (numeric code) does — the
    // resilience chain then sees a real transport failure (retryable/abortable), not a result.
    const missing = shell('/no/such/binary-xyz-stitchapi');
    await expect(missing({ body: [] })).rejects.toThrow(/ENOENT/);
});

test('cwd sets the subprocess working directory', async () => {
    const dir = realpathSync(tmpdir());
    const pwd = shell(NODE, { cwd: dir });
    const out = await pwd({
        body: ['-e', 'process.stdout.write(process.cwd())'],
    });
    // realpath both sides so a symlinked temp dir (/var → /private/var) compares equal.
    expect(realpathSync(out)).toBe(dir);
});

test('responseType: "json" falls back to the raw text when stdout is not valid JSON', async () => {
    const j = shell<unknown>(NODE, { responseType: 'json' });
    await expect(
        j({ body: ['-e', 'process.stdout.write("not json")'] }),
    ).resolves.toBe('not json');
});

test('exceeding maxBufferBytes rejects as a transport error (not a 500 response)', async () => {
    const tiny = shell(NODE, { maxBufferBytes: 4 });
    await expect(
        tiny({ body: ['-e', 'process.stdout.write("x".repeat(100))'] }),
    ).rejects.toThrow(/maxBuffer/i);
});

test('maxBufferBytes also takes a size token, and the token really caps at runtime', async () => {
    // A widened TYPE is not a widened runtime, so this asserts the bound, not the signature.
    // `'1kb'` must resolve to 1024 bytes: 4 KB of stdout is over a parsed `'1kb'` but far under
    // the 10 MiB default, so a rejection here can ONLY mean the token was honoured (an ignored
    // token would fall back to the default and resolve).
    const tiny = shell(NODE, { maxBufferBytes: '1kb' });
    await expect(
        tiny({ body: ['-e', 'process.stdout.write("x".repeat(4096))'] }),
    ).rejects.toThrow(/maxBuffer/i);

    // Under the parsed cap, the same surface still works.
    await expect(
        tiny({ body: ['-e', 'process.stdout.write("x".repeat(100))'] }),
    ).resolves.toBe('x'.repeat(100));
});

test('an unparseable size token lands on the default cap, not on 0/NaN', async () => {
    // `parseBytes('one gigabyte')` → undefined → the 10 MiB default. A `NaN`/`0` cap would
    // reject even this two-byte write; resolving proves the fallback is the real default.
    const bad = shell(NODE, { maxBufferBytes: 'one gigabyte' });
    await expect(
        bad({ body: ['-e', 'process.stdout.write("ok")'] }),
    ).resolves.toBe('ok');
});

test('old spellings are DELETED and the empty options bag is rejected (compile-time)', () => {
    // @ts-expect-error — `decode` was renamed to `responseType` (no alias)
    void shell({ command: NODE, decode: 'json' });
    // @ts-expect-error — `maxBuffer` was renamed to `maxBufferBytes` (no alias)
    void shell({ command: NODE, maxBuffer: 4 });
    // @ts-expect-error — responseType is narrowed to 'json' | 'text' for a subprocess
    void shell(NODE, { responseType: 'blob' });
    // @ts-expect-error — `{}` is not a valid options bag (CONTRACT.md P20): omit it instead
    void shell(NODE, {});
    expect(true).toBe(true);
});
