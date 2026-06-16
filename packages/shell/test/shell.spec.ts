// @stitchapi/shell — the security model is the load-bearing part, so the suite proves it
// structurally: argv arrives as literal arguments (no shell interprets metacharacters), the env is
// fail-closed (no process.env leak), a non-zero exit is a StitchError, and the resilience chain
// (timeout) wraps the subprocess. The node binary itself is the controlled subprocess.
import { shell } from '../src/index';

const NODE = process.execPath; // an absolute path — no PATH needed to resolve it

test('runs a static command; stdout is the result (text mode)', async () => {
    const echo = shell({ command: NODE });
    await expect(
        echo({ body: ['-e', 'process.stdout.write("hello")'] }),
    ).resolves.toBe('hello');
});

test('decode: "json" parses stdout', async () => {
    const j = shell<{ a: number }>({ command: NODE, decode: 'json' });
    await expect(
        j({ body: ['-e', 'process.stdout.write(JSON.stringify({a:1}))'] }),
    ).resolves.toEqual({ a: 1 });
});

test('argv elements are literal — shell metacharacters are inert (there is no shell)', async () => {
    const dump = shell<string[]>({ command: NODE, decode: 'json' });
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
        const dumpEnv = shell<Record<string, string>>({
            command: NODE,
            decode: 'json',
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
        decode: 'json',
        env: { FOO: 'bar' },
    });
    const out = await dumpEnv({
        body: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
    });
    expect(out['FOO']).toBe('bar');
});

test('a non-zero exit surfaces as a StitchError carrying the exit code + stderr', async () => {
    const fail = shell({ command: NODE });
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
    const x = shell({ command: NODE });
    await expect(
        x({ body: { not: 'an array' } as unknown as string[] }),
    ).rejects.toThrow(/string\[\]/);
});

test('the resilience chain wraps the subprocess — a per-attempt timeout aborts it', async () => {
    const slow = shell({ command: NODE, timeout: { perAttempt: 50 } });
    await expect(
        slow({ body: ['-e', 'setTimeout(() => {}, 5000)'] }),
    ).rejects.toBeTruthy();
});

test('a spawn failure (missing binary) rejects as a transport error — NOT a 500 exit response', async () => {
    // ENOENT carries a STRING `code`, so `runCommand` rejects (transport error) rather than
    // resolving to a status-500 "response" the way a non-zero EXIT (numeric code) does — the
    // resilience chain then sees a real transport failure (retryable/abortable), not a result.
    const missing = shell({ command: '/no/such/binary-xyz-stitchapi' });
    await expect(missing({ body: [] })).rejects.toThrow(/ENOENT/);
});
