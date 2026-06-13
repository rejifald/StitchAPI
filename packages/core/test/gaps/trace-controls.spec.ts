// Pins docs/GAP-AUDIT.md §2.3: Tracing needs an off switch and default secret redaction
import { stitch } from '../../src';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Quiet default: getTrace() reads STITCH_TRACE_FILE per stitch construction, so each
// test below overrides this BEFORE creating its stitch. The top-level default keeps
// any stray write away from $HOME/.stitch/runs/proto.jsonl.
process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-trace-controls-${process.pid}.jsonl`,
);

let server: MockServer;
let envSnapshot: NodeJS.ProcessEnv;
// Files a test may create (temp traces, or the buggy literal '0'/'false' files);
// removed in afterEach so a red run leaves no junk in the repo.
const cleanupPaths: string[] = [];

beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    envSnapshot = { ...process.env };
    server.reset();
});
afterEach(() => {
    for (const p of cleanupPaths.splice(0)) rmSync(p, { force: true });
    for (const key of Object.keys(process.env)) {
        // Reflect.deleteProperty (vs `delete process.env[key]`) keeps the
        // dynamic-key removal lint-clean while preserving the same env restore.
        if (!(key in envSnapshot)) Reflect.deleteProperty(process.env, key);
    }
    Object.assign(process.env, envSnapshot);
});

// (a) Config off switch: `trace: false` disables ALL built-in sinks, even when the
// environment points file tracing at a path. The stitch-local switch must win.
test('trace: false disables built-in sinks even with STITCH_TRACE_FILE set', async () => {
    const traceFile = join(tmpdir(), `stitch-trace-off-${process.pid}.jsonl`);
    rmSync(traceFile, { force: true });
    cleanupPaths.push(traceFile);
    process.env['STITCH_TRACE_FILE'] = traceFile;

    server.route('GET', '/off', { body: { ok: true } });
    const off = stitch({
        name: 'off',
        baseUrl: server.url,
        path: '/off',
        trace: false,
    });
    await expect(off()).resolves.toEqual({ ok: true });

    // Off means off: the file either never appears or stays empty.
    const written = existsSync(traceFile)
        ? readFileSync(traceFile, 'utf8')
        : '';
    expect(written).toBe('');
});

// (b) Env off switch: STITCH_TRACE_FILE='0' / 'false' mean "disable file tracing",
// not "append JSONL to a file literally named 0/false in the working directory".
test("STITCH_TRACE_FILE='0' and 'false' disable file tracing (no literal file)", async () => {
    server.route('GET', '/env-off', { body: { ok: true } });

    for (const value of ['0', 'false']) {
        const literalPath = resolve(process.cwd(), value);
        rmSync(literalPath, { force: true });
        cleanupPaths.push(literalPath);
        process.env['STITCH_TRACE_FILE'] = value;

        const call = stitch({
            name: `env-off-${value}`,
            baseUrl: server.url,
            path: '/env-off',
        });
        await expect(call()).resolves.toEqual({ ok: true });

        // Nothing may be written to a file named after the switch value.
        const written = existsSync(literalPath)
            ? readFileSync(literalPath, 'utf8')
            : null;
        expect(written).toBeNull();
    }
});

// (c) Default redaction: secret-bearing headers (authorization, x-api-key) must never
// reach the JSONL trace verbatim — they are replaced with '[REDACTED]' by default.
test('JSONL trace redacts authorization and x-api-key header values by default', async () => {
    const traceFile = join(
        tmpdir(),
        `stitch-trace-redact-${process.pid}.jsonl`,
    );
    rmSync(traceFile, { force: true });
    cleanupPaths.push(traceFile);
    process.env['STITCH_TRACE_FILE'] = traceFile;

    server.route('GET', '/secrets', { body: { ok: true } });
    const call = stitch({
        name: 'secrets',
        baseUrl: server.url,
        path: '/secrets',
    });
    await expect(
        call({
            headers: {
                authorization: 'Bearer supersecret123',
                'x-api-key': 'sk-redact-me',
            },
        }),
    ).resolves.toEqual({ ok: true });

    expect(existsSync(traceFile)).toBe(true);
    const jsonl = readFileSync(traceFile, 'utf8');
    expect(jsonl).not.toContain('supersecret123');
    expect(jsonl).not.toContain('sk-redact-me');
    expect(jsonl).toContain('[REDACTED]');
});
