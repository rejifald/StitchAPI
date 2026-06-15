// Pins docs/GAP-AUDIT.md §2.3: safe-by-default tracing — an off switch (config +
// env), default header redaction, body/result truncation with opt-in full capture,
// and URL credential-scrubbing in the JSONL `start` record.
import { fileSink, stitch } from '../../src';
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

// Read the JSONL trace back as parsed records (skipping blank/partial lines).
function readRecords(file: string): Record<string, unknown>[] {
    return readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// A body whose JSON encoding comfortably exceeds the 2048-char default cap.
const BIG = 'x'.repeat(5000);

// (d) Default truncation: a request body / response value larger than the cap is
// replaced with a compact `{ truncated, bytes, preview }` marker — the multi-KB
// payload never lands on disk in full.
test('JSONL truncates request body and response value past the default cap', async () => {
    const traceFile = join(tmpdir(), `stitch-trace-trunc-${process.pid}.jsonl`);
    rmSync(traceFile, { force: true });
    cleanupPaths.push(traceFile);
    process.env['STITCH_TRACE_FILE'] = traceFile;

    server.route('POST', '/big', { body: { blob: BIG } });
    const call = stitch({
        name: 'big',
        method: 'POST',
        baseUrl: server.url,
        path: '/big',
    });
    await expect(call({ body: { blob: BIG } })).resolves.toEqual({ blob: BIG });

    const records = readRecords(traceFile);
    const start = records.find((r) => r['type'] === 'start')!;
    const result = records.find((r) => r['type'] === 'result')!;

    const reqBody = (start['input'] as { body: Record<string, unknown> }).body;
    expect(reqBody['truncated']).toBe(true);
    expect(reqBody['bytes']).toBeGreaterThanOrEqual(2048);
    expect((reqBody['preview'] as string).length).toBeLessThanOrEqual(2048);

    const value = result['value'] as Record<string, unknown>;
    expect(value['truncated']).toBe(true);
    expect(value['blob']).toBeUndefined(); // the original shape is gone

    // The full 5000-char payload is nowhere on disk — only a ≤2048-char preview.
    expect(readFileSync(traceFile, 'utf8')).not.toContain(BIG);
});

// (e) Opt-in full capture (env): STITCH_TRACE_MAX_BODY=full disables truncation,
// restoring the pre-1.0 behaviour of persisting the whole body.
test('STITCH_TRACE_MAX_BODY=full captures the whole body (no truncation)', async () => {
    const traceFile = join(tmpdir(), `stitch-trace-full-${process.pid}.jsonl`);
    rmSync(traceFile, { force: true });
    cleanupPaths.push(traceFile);
    process.env['STITCH_TRACE_FILE'] = traceFile;
    process.env['STITCH_TRACE_MAX_BODY'] = 'full';

    server.route('GET', '/full', { body: { blob: BIG } });
    const call = stitch({ name: 'full', baseUrl: server.url, path: '/full' });
    await expect(call()).resolves.toEqual({ blob: BIG });

    const result = readRecords(traceFile).find((r) => r['type'] === 'result')!;
    expect((result['value'] as { blob: string }).blob).toBe(BIG);
});

// (f) Opt-in full capture (code): fileSink(path, { maxBodyBytes: false }) is the
// in-code equivalent of the env switch.
test('fileSink({ maxBodyBytes: false }) captures the whole body', async () => {
    const traceFile = join(tmpdir(), `stitch-trace-cap-${process.pid}.jsonl`);
    rmSync(traceFile, { force: true });
    cleanupPaths.push(traceFile);

    server.route('GET', '/cap', { body: { blob: BIG } });
    const call = stitch({
        name: 'cap',
        baseUrl: server.url,
        path: '/cap',
        trace: fileSink(traceFile, { maxBodyBytes: false }),
    });
    await expect(call()).resolves.toEqual({ blob: BIG });

    const result = readRecords(traceFile).find((r) => r['type'] === 'result')!;
    expect((result['value'] as { blob: string }).blob).toBe(BIG);
});

// (g) URL credential-scrub: a secret-bearing query param is REDACTED in the
// `start` record's resolved URL, while benign params survive.
test('JSONL start.url redacts secret query params, keeps benign ones', async () => {
    const traceFile = join(tmpdir(), `stitch-trace-url-${process.pid}.jsonl`);
    rmSync(traceFile, { force: true });
    cleanupPaths.push(traceFile);
    process.env['STITCH_TRACE_FILE'] = traceFile;

    server.route('GET', '/scrub', { body: { ok: true } });
    const call = stitch({ name: 'scrub', baseUrl: server.url, path: '/scrub' });
    await expect(
        call({ query: { api_key: 'sk-url-leak', page: '2' } }),
    ).resolves.toEqual({ ok: true });

    const start = readRecords(traceFile).find((r) => r['type'] === 'start')!;
    const url = start['url'] as string;
    expect(url).not.toContain('sk-url-leak');
    expect(url).toContain('api_key=REDACTED');
    expect(url).toContain('page=2');
    expect(readFileSync(traceFile, 'utf8')).not.toContain('sk-url-leak');
});
