// Pins issue #147: apiKey({ in: 'query' }) — query-param placement for an API key, with
// header placement staying the backward-compatible default. Covers: append onto a URL with no
// query AND one that already has a query string, call-time resolution (the thunk is read per
// call, not at construction), URL-encoding, and trace redaction of the configured param name.
import { fileSink, stitch } from '../../src';
import { apiKey } from '../../src/auth';
import { scrubUrl } from '../../src/util';
import { startMockServer } from '../support/mock-server';
import type { MockServer } from '../support/mock-server';

import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Quiet default — each redaction test overrides STITCH_TRACE_FILE before constructing its stitch.
process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-apikey-query-${process.pid}.jsonl`,
);

let server: MockServer;
const cleanupPaths: string[] = [];

beforeAll(async () => {
    server = await startMockServer();
});
afterAll(async () => {
    await server.close();
});
beforeEach(() => {
    server.reset();
});
afterEach(() => {
    for (const p of cleanupPaths.splice(0)) rmSync(p, { force: true });
});

describe("issue #147 — apiKey({ in: 'query' }) placement", () => {
    // ── A. Append onto a URL with NO existing query ─────────────────────────
    test('appends ?api_key=<value> to a query-less URL, server sees it', async () => {
        server.route('GET', '/q-none', { body: { ok: true } });
        const call = stitch({
            baseUrl: server.url,
            path: '/q-none',
            auth: apiKey({ in: 'query', secret: 'sk-123' }),
        });
        await expect(call()).resolves.toEqual({ ok: true });
        // The default param name is 'api_key'.
        expect(server.calls('/q-none')[0]?.query['api_key']).toBe('sk-123');
    });

    // ── B. Append onto a URL that ALREADY carries a query ───────────────────
    // The `?page=2` predefined query must survive; the key is added with `&`, not a second `?`.
    // Both params arriving at the server proves the join was `&` — a stray second `?` would have
    // folded the key into `page`'s value and `token` would be absent.
    test('appends with & onto an existing query, both params reach the server', async () => {
        server.route('GET', '/q-some', { body: { ok: true } });
        const call = stitch({
            baseUrl: server.url,
            path: '/q-some?page=2',
            auth: apiKey({ in: 'query', name: 'token', secret: 'sk-abc' }),
        });
        await expect(call()).resolves.toEqual({ ok: true });
        const q = server.calls('/q-some')[0]?.query ?? {};
        expect(q['page']).toBe('2');
        expect(q['token']).toBe('sk-abc');
    });

    // ── C. Call-time resolution: the thunk is read per call, not at construction ─
    test('resolves the Secret thunk on every call (not once at construction)', async () => {
        server.route('GET', '/q-thunk', { body: { ok: true } });
        let n = 0;
        const value = (): string => `key-${++n}`;
        const call = stitch({
            baseUrl: server.url,
            path: '/q-thunk',
            auth: apiKey({ in: 'query', secret: value }),
        });
        // Constructing the stitch must NOT have resolved the thunk yet.
        expect(n).toBe(0);
        await call();
        await call();
        const calls = server.calls('/q-thunk');
        expect(calls[0]?.query['api_key']).toBe('key-1');
        expect(calls[1]?.query['api_key']).toBe('key-2');
    });

    // ── D. URL-encoding: a key with reserved characters is percent-encoded ──
    // Auth runs on the cloned request inside the attempt loop (after the `start` event), so the
    // encoded key is observed on the wire — exactly where it matters — via the mock server, which
    // decodes the percent-encoding back to the original value.
    test('URL-encodes a value containing reserved characters', async () => {
        server.route('GET', '/q-enc', { body: { ok: true } });
        const raw = 'a b&c=d/e+f';
        const call = stitch({
            baseUrl: server.url,
            path: '/q-enc',
            auth: apiKey({ in: 'query', secret: raw }),
        });
        await expect(call()).resolves.toEqual({ ok: true });
        // The server decodes the percent-encoded value back to the exact original — so each
        // reserved char (space, &, =, /, +) round-tripped through a single param, not split into
        // extra params or mangled. A raw `&`/`=` would have spawned spurious params instead.
        const q = server.calls('/q-enc')[0]?.query ?? {};
        expect(q['api_key']).toBe(raw);
        expect(Object.keys(q)).toEqual(['api_key']);
    });

    // ── E. Trace redaction: the configured param name is registered with the scrubber ─
    // The engine emits `start` with the PRE-auth URL (auth mutates only the cloned request inside
    // the attempt loop), so a query key never even reaches the `start.url` — but registering the
    // configured `name` with the scrubber is defense-in-depth for any sink that sees a post-auth
    // URL or the structured `input.query`. Assert both: the secret value never lands in the trace
    // file, AND the registered name IS redacted when a URL carrying it passes through `scrubUrl`.
    test('registers the configured query key with the URL scrubber, secret never traced', async () => {
        const traceFile = join(
            tmpdir(),
            `stitch-apikey-query-redact-${process.pid}.jsonl`,
        );
        rmSync(traceFile, { force: true });
        cleanupPaths.push(traceFile);

        server.route('GET', '/q-redact', { body: { ok: true } });
        // A vendor spelling the built-in stems would NOT catch on their own — so a redaction here
        // can only come from the construction-time registration.
        const call = stitch({
            name: 'q-redact',
            baseUrl: server.url,
            path: '/q-redact',
            auth: apiKey({
                in: 'query',
                name: 'appkeyparam',
                secret: 'sk-leak',
            }),
            trace: fileSink(traceFile),
        });
        await expect(call()).resolves.toEqual({ ok: true });

        // The secret value never lands anywhere in the trace file.
        const jsonl = readFileSync(traceFile, 'utf8');
        expect(jsonl).not.toContain('sk-leak');

        // And the configured name is now a redactable secret key: a URL carrying it (the shape an
        // OTLP `url.full` or a post-auth `start.url` would have) is scrubbed to REDACTED, while a
        // benign param survives.
        const scrubbed = scrubUrl(
            'https://api.example.com/x?appkeyparam=sk-leak&page=2',
        );
        expect(scrubbed).toContain('appkeyparam=REDACTED');
        expect(scrubbed).not.toContain('sk-leak');
        expect(scrubbed).toContain('page=2');
    });

    // ── F. Default placement is unchanged header behavior ───────────────────
    test('default (in omitted) writes the x-api-key header, no query param', async () => {
        server.route('GET', '/hdr', { body: { ok: true } });
        const call = stitch({
            baseUrl: server.url,
            path: '/hdr',
            auth: apiKey({ secret: 'sk-hdr' }),
        });
        await expect(call()).resolves.toEqual({ ok: true });
        const c = server.calls('/hdr')[0];
        expect(c?.headers['x-api-key']).toBe('sk-hdr');
        expect(c?.query['api_key']).toBeUndefined();
    });
});
