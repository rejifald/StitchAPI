// OTLP export: an opt-in trace sink maps the event stream to OpenTelemetry CLIENT spans (OTel
// HTTP semconv attributes) and hands them to a SpanExporter. Tested with a STUB exporter that
// captures spans in memory — no running collector, no network.
import { otlpTrace, stitch } from '../src';
import type { OtelSpan, SpanExporter, StitchEvent } from '../src';
import { exportsFromEnv, multiplex } from '../src/trace';
import { scrubUrl } from '../src/util';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-otlp-${process.pid}.jsonl`,
);

// A stub exporter: captures exported spans in memory (no collector, no network).
function stubExporter(): { exporter: SpanExporter; spans: OtelSpan[] } {
    const spans: OtelSpan[] = [];
    return {
        spans,
        exporter: {
            export(batch) {
                spans.push(...batch);
            },
        },
    };
}

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

test('maps a successful call to one CLIENT span with OTel HTTP semconv attributes', () => {
    const { exporter, spans } = stubExporter();
    const sink = otlpTrace({ exporter });
    const name = 'getThing';
    const events: StitchEvent[] = [
        {
            type: 'start',
            name,
            method: 'GET',
            url: 'http://api.example.com/x',
            input: {},
            at: 1000,
        },
        {
            type: 'progress',
            phase: 'retry',
            attempt: 1,
            detail: '503',
            at: 1010,
        },
        { type: 'result', data: {}, status: 200, attempts: 2, at: 1050 },
        { type: 'done', ok: true, elapsed: 50, attempts: 2, at: 1050 },
    ];
    for (const ev of events) sink.handle(ev, { name });

    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.kind).toBe('CLIENT');
    expect(span.attributes['http.request.method']).toBe('GET');
    expect(span.attributes['url.full']).toBe('http://api.example.com/x');
    expect(span.attributes['server.address']).toBe('api.example.com');
    expect(span.attributes['http.response.status_code']).toBe(200);
    expect(span.status.code).toBe('OK');
    expect(span.events.some((e) => e.name === 'retry')).toBe(true);
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
});

test('maps an error to an ERROR span with error.type and status_code', () => {
    const { exporter, spans } = stubExporter();
    const sink = otlpTrace({ exporter });
    const name = 'createThing';
    const events: StitchEvent[] = [
        {
            type: 'start',
            name,
            method: 'POST',
            url: 'http://api.example.com/x',
            input: {},
            at: 1000,
        },
        {
            type: 'error',
            name,
            message: 'HTTP 500',
            status: 500,
            attempts: 1,
            at: 1020,
        },
        { type: 'done', ok: false, elapsed: 20, attempts: 1, at: 1020 },
    ];
    for (const ev of events) sink.handle(ev, { name });

    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe('ERROR');
    expect(spans[0]!.status.message).toBe('HTTP 500');
    expect(spans[0]!.attributes['http.response.status_code']).toBe(500);
    expect(spans[0]!.attributes['error.type']).toBe('500');
});

test('end-to-end: a real stitch call exports one span to the stub exporter', async () => {
    const { exporter, spans } = stubExporter();
    const sink = otlpTrace({ exporter });
    server.route('GET', '/ping', { body: { ok: true } });
    const ping = stitch({ name: 'ping', baseUrl: server.url, path: '/ping' });

    // Tap the public event stream and feed it through the OTLP sink (as the trace tee would).
    for await (const ev of ping.stream()) sink.handle(ev, { name: 'ping' });

    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes['http.request.method']).toBe('GET');
    expect(String(spans[0]!.attributes['url.full'])).toContain('/ping');
    expect(spans[0]!.attributes['http.response.status_code']).toBe(200);
    expect(spans[0]!.status.code).toBe('OK');
});

test('STITCH_EXPORT parses to a list and multiplex fans out to every sink', () => {
    expect(exportsFromEnv('otlp')).toEqual(['otlp']);
    expect(exportsFromEnv(' Console , OTLP ')).toEqual(['console', 'otlp']);
    expect(exportsFromEnv(undefined)).toEqual([]);

    const seenA: string[] = [];
    const seenB: string[] = [];
    const into = (sink: string[]) => ({
        handle: (e: StitchEvent) => sink.push(e.type),
    });
    const mux = multiplex(into(seenA), into(seenB));
    mux.handle(
        { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
        { name: 'x' },
    );
    expect(seenA).toEqual(['done']);
    expect(seenB).toEqual(['done']);
});

// url.full is OTLP's only secret-bearing attribute (it never exports headers or
// bodies), so it must be scrubbed before a span leaves for a collector.
test('url.full strips userinfo and redacts secret query params before export', () => {
    const { exporter, spans } = stubExporter();
    const sink = otlpTrace({ exporter });
    const name = 'fetchThing';
    const events: StitchEvent[] = [
        {
            type: 'start',
            name,
            method: 'GET',
            url: 'https://user:pass@api.example.com/data?access_token=sk-otlp-leak&page=2',
            input: {},
            at: 1000,
        },
        { type: 'result', data: {}, status: 200, attempts: 1, at: 1050 },
        { type: 'done', ok: true, elapsed: 50, attempts: 1, at: 1050 },
    ];
    for (const ev of events) sink.handle(ev, { name });

    const full = String(spans[0]!.attributes['url.full']);
    expect(full).not.toContain('sk-otlp-leak');
    expect(full).not.toContain('user:pass');
    expect(full).toContain('access_token=REDACTED');
    expect(full).toContain('page=2'); // benign params survive
    expect(spans[0]!.attributes['server.address']).toBe('api.example.com');
});

test('scrubUrl: clean URLs pass through, credentials are redacted', () => {
    // Nothing to scrub → returned byte-for-byte (a clean URL is never reformatted).
    expect(scrubUrl('http://api.example.com/x')).toBe(
        'http://api.example.com/x',
    );
    expect(scrubUrl('https://api.example.com/x?page=2&sort=name')).toBe(
        'https://api.example.com/x?page=2&sort=name',
    );

    // Userinfo is stripped.
    expect(scrubUrl('https://u:p@h.example.com/x')).toBe(
        'https://h.example.com/x',
    );

    // Secret keys — exact-match and substring-stem — are redacted; benign survive.
    for (const key of [
        'api_key',
        'access_token',
        'X-Amz-Signature',
        'sig',
        'password',
    ]) {
        const out = scrubUrl(`https://h.example.com/x?${key}=shh&page=2`);
        expect(out).not.toContain('shh');
        expect(out).toContain(`${key}=REDACTED`);
        expect(out).toContain('page=2');
    }

    // Non-absolute / unparseable strings are returned unchanged.
    expect(scrubUrl('/relative/path?token=abc')).toBe(
        '/relative/path?token=abc',
    );
});
