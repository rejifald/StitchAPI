import { fileSink, stitch } from '../src';
import type { TraceSink } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// This spec deliberately does NOT set STITCH_TRACE_FILE at module load — it proves the
// default is *off*. Each test manipulates the STITCH_TRACE_* env vars itself and restores
// them afterwards, so test ordering never leaks a sink from one case into the next.

let server: MockServer;
beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});

const TRACE_ENV = [
    'STITCH_TRACE_FILE',
    'STITCH_TRACE_CONSOLE',
    'STITCH_EXPORT',
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
    server.reset();
    saved = Object.fromEntries(TRACE_ENV.map((k) => [k, process.env[k]]));
    for (const k of TRACE_ENV) Reflect.deleteProperty(process.env, k);
});
afterEach(() => {
    for (const k of TRACE_ENV) {
        const prev = saved[k];
        if (prev === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = prev;
    }
});

const tmpFile = (prefix: string) =>
    join(mkdtempSync(join(tmpdir(), prefix)), 'trace.jsonl');

// Run a stitch under a sandboxed $HOME so the would-be default JSONL path
// (`$HOME/.stitch/runs/proto.jsonl`) lives in a temp dir we can assert on.
async function withSandboxHome<T>(
    fn: (home: string) => Promise<T>,
): Promise<T> {
    const home = mkdtempSync(join(tmpdir(), 'stitch-home-'));
    const prev = process.env['HOME'];
    process.env['HOME'] = home;
    try {
        return await fn(home);
    } finally {
        if (prev === undefined) delete process.env['HOME'];
        else process.env['HOME'] = prev;
    }
}

const defaultJsonl = (home: string) => join(home, '.stitch/runs/proto.jsonl');

// ---------------------------------------------------------------------------
// NO SIDE EFFECTS BY DEFAULT — tracing is off until you opt in.
// ---------------------------------------------------------------------------

test('off by default: a plain stitch writes no trace file and prints nothing', async () => {
    await withSandboxHome(async (home) => {
        const stderr = vi
            .spyOn(process.stderr, 'write')
            .mockImplementation(() => true);
        try {
            server.route('GET', '/ping', { body: { ok: true } });
            const ping = stitch({
                name: 'ping',
                baseUrl: server.url,
                path: '/ping',
            });
            await expect(ping()).resolves.toEqual({ ok: true });

            expect(existsSync(defaultJsonl(home))).toBe(false);
            const wroteTrace = stderr.mock.calls.some((c) =>
                String(c[0]).includes('ping'),
            );
            expect(wroteTrace).toBe(false);
        } finally {
            stderr.mockRestore();
        }
    });
});

test("trace: 'console' streams a line per event to stderr and writes no file", async () => {
    await withSandboxHome(async (home) => {
        const stderr = vi
            .spyOn(process.stderr, 'write')
            .mockImplementation(() => true);
        try {
            server.route('GET', '/ping', { body: { ok: true } });
            const ping = stitch({
                name: 'ping',
                baseUrl: server.url,
                path: '/ping',
                trace: 'console',
            });
            await expect(ping()).resolves.toEqual({ ok: true });

            const out = stderr.mock.calls.map((c) => String(c[0])).join('');
            expect(out).toContain('ping');
            // console-only: nothing lands on disk.
            expect(existsSync(defaultJsonl(home))).toBe(false);
        } finally {
            stderr.mockRestore();
        }
    });
});

test('fileSink(path) appends JSONL to the given path', async () => {
    const file = tmpFile('stitch-fs-');
    server.route('GET', '/ping', { body: { ok: true } });
    const ping = stitch({
        name: 'ping',
        baseUrl: server.url,
        path: '/ping',
        trace: fileSink(file),
    });
    await expect(ping()).resolves.toEqual({ ok: true });

    expect(existsSync(file)).toBe(true);
    const types = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '')
        .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain('start');
    expect(types).toContain('result');
    expect(types).toContain('done');
});

test('trace: false forces tracing off even when STITCH_TRACE_FILE is set', async () => {
    const file = tmpFile('stitch-off-');
    process.env['STITCH_TRACE_FILE'] = file;
    server.route('GET', '/ping', { body: { ok: true } });
    const ping = stitch({
        name: 'ping',
        baseUrl: server.url,
        path: '/ping',
        trace: false,
    });
    await expect(ping()).resolves.toEqual({ ok: true });
    expect(existsSync(file)).toBe(false);
});

test('a custom TraceSink receives the lifecycle events', async () => {
    const seen: string[] = [];
    const sink: TraceSink = {
        handle: (ev) => {
            seen.push(ev.type);
        },
    };
    server.route('GET', '/ping', { body: { ok: true } });
    const ping = stitch({
        name: 'ping',
        baseUrl: server.url,
        path: '/ping',
        trace: sink,
    });
    await expect(ping()).resolves.toEqual({ ok: true });
    expect(seen).toContain('start');
    expect(seen).toContain('result');
    expect(seen).toContain('done');
});

test('STITCH_TRACE_FILE opts the env-driven sink in when no trace config is set', async () => {
    const file = tmpFile('stitch-env-');
    process.env['STITCH_TRACE_FILE'] = file;
    server.route('GET', '/ping', { body: { ok: true } });
    const ping = stitch({ name: 'ping', baseUrl: server.url, path: '/ping' });
    await expect(ping()).resolves.toEqual({ ok: true });
    expect(existsSync(file)).toBe(true);
});
