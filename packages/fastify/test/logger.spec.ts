// Unit tests for the @stitchapi/fastify logger sink (`fastifyLoggerSink`). The
// behavioural `fastify.spec.ts` only ever passes `logger: false`, so the sink's
// own logic was untested: the StitchEvent → Pino-level mapping, the metadata-only
// one-liners, the `lifecycle` gate, and — most importantly — the SECURITY
// guarantees the module documents (the URL query is scrubbed; the raw input,
// result value, and delta chunk are NEVER logged). Pure: no Fastify, no network,
// we drive a recording logger double directly.
import { fastifyLoggerSink } from '../src';
import type { FastifyLoggerLike } from '../src';

import type { StitchEvent, TraceContext } from 'stitchapi';
import { describe, expect, test } from 'vitest';

type Level = 'error' | 'warn' | 'info' | 'debug';

// A recording logger double — satisfies FastifyLoggerLike and captures every call
// with its level, so a test asserts both the level rule and the message text.
function recorder(): {
    logger: FastifyLoggerLike;
    calls: { level: Level; message: string }[];
} {
    const calls: { level: Level; message: string }[] = [];
    const logger: FastifyLoggerLike = {
        error: (m) => calls.push({ level: 'error', message: m }),
        warn: (m) => calls.push({ level: 'warn', message: m }),
        info: (m) => calls.push({ level: 'info', message: m }),
        debug: (m) => calls.push({ level: 'debug', message: m }),
    };
    return { logger, calls };
}

const ctx: TraceContext = { name: 'getUser' };

const startEvent = (url: string, input = {}): StitchEvent => ({
    type: 'start',
    name: 'getUser',
    method: 'GET',
    url,
    input,
    at: 0,
});

describe('fastifyLoggerSink — level mapping', () => {
    test('maps each event type to its Pino level', () => {
        const { logger, calls } = recorder();
        const sink = fastifyLoggerSink(logger);

        const events: StitchEvent[] = [
            startEvent('https://api.test/u'),
            { type: 'progress', phase: 'retry', attempt: 2, at: 0 },
            { type: 'progress', phase: 'circuit', attempt: 1, at: 0 },
            { type: 'progress', phase: 'throttled', attempt: 1, at: 0 },
            {
                type: 'result',
                data: { id: 1 },
                status: 200,
                attempts: 1,
                at: 0,
            },
            {
                type: 'error',
                name: 'StitchHttpError',
                message: 'boom',
                status: 502,
                attempts: 3,
                at: 0,
            },
            { type: 'done', ok: true, elapsed: 12, attempts: 1, at: 0 },
        ];
        for (const e of events) sink.handle(e, ctx);

        // A flaky progress (retry/circuit) → warn; a routine throttle → debug; the
        // happy-path lifecycle (start/result/done) → debug/info/debug.
        expect(calls.map((c) => c.level)).toEqual([
            'debug',
            'warn',
            'warn',
            'debug',
            'info',
            'error',
            'debug',
        ]);
    });

    test('drift follows its finding level', () => {
        const { logger, calls } = recorder();
        const sink = fastifyLoggerSink(logger);
        const drift = (level: 'error' | 'warn' | 'info'): StitchEvent => ({
            type: 'drift',
            finding: { level, path: 'data.id', change: 'coerced' },
            at: 0,
        });

        sink.handle(drift('error'), ctx);
        sink.handle(drift('warn'), ctx);
        sink.handle(drift('info'), ctx);

        expect(calls.map((c) => c.level)).toEqual(['error', 'warn', 'debug']);
    });

    test('info announcements and delta chunks are never logged', () => {
        const { logger, calls } = recorder();
        const sink = fastifyLoggerSink(logger);

        sink.handle(
            { type: 'info', topic: 'auth', detail: 'refresh', at: 0 },
            ctx,
        );
        sink.handle({ type: 'delta', chunk: 'raw-response-data', at: 0 }, ctx);

        expect(calls).toEqual([]);
    });

    test('lifecycle:false drops start/result/done but keeps errors, retries, and drift', () => {
        const { logger, calls } = recorder();
        const sink = fastifyLoggerSink(logger, { lifecycle: false });

        sink.handle(startEvent('https://api.test/u'), ctx);
        sink.handle(
            { type: 'result', data: 1, status: 200, attempts: 1, at: 0 },
            ctx,
        );
        sink.handle(
            { type: 'done', ok: true, elapsed: 1, attempts: 1, at: 0 },
            ctx,
        );
        sink.handle(
            {
                type: 'error',
                name: 'E',
                message: 'x',
                attempts: 1,
                at: 0,
            },
            ctx,
        );
        sink.handle(
            { type: 'progress', phase: 'retry', attempt: 2, at: 0 },
            ctx,
        );

        expect(calls.map((c) => c.level)).toEqual(['error', 'warn']);
    });
});

describe('fastifyLoggerSink — messages', () => {
    test('uses the trace-context name, not the event name', () => {
        const { logger, calls } = recorder();
        const sink = fastifyLoggerSink(logger);

        sink.handle(
            { type: 'result', data: 1, status: 201, attempts: 2, at: 0 },
            { name: 'createOrder' },
        );

        expect(calls[0]?.message).toBe('← createOrder 201 (2 attempt(s))');
    });
});

describe('fastifyLoggerSink — security', () => {
    test('strips the URL query string (it can carry secrets like ?api_key=…)', () => {
        const { logger, calls } = recorder();
        const sink = fastifyLoggerSink(logger);

        sink.handle(
            startEvent('https://api.test/users?api_key=SECRET&id=1'),
            ctx,
        );

        expect(calls).toHaveLength(1);
        expect(calls[0]?.message).toBe(
            '→ getUser GET https://api.test/users?…',
        );
        expect(calls[0]?.message).not.toContain('SECRET');
        expect(calls[0]?.message).not.toContain('api_key');
    });

    test('logs only metadata — never the raw input, result value, or delta chunk', () => {
        const { logger, calls } = recorder();
        const sink = fastifyLoggerSink(logger);

        // A `start` carries the un-redacted input (a custom sink sees raw events);
        // a `result` carries the raw value; a `delta` carries raw response data.
        sink.handle(
            startEvent('https://api.test/login', {
                headers: { authorization: 'Bearer TOKEN' },
                body: { password: 'hunter2' },
            }),
            ctx,
        );
        sink.handle(
            {
                type: 'result',
                data: { password: 'hunter2', ssn: '123-45-6789' },
                status: 200,
                attempts: 1,
                at: 0,
            },
            ctx,
        );
        sink.handle({ type: 'delta', chunk: 'SENSITIVE-CHUNK', at: 0 }, ctx);

        const all = calls.map((c) => c.message).join('\n');
        expect(all).not.toContain('TOKEN');
        expect(all).not.toContain('authorization');
        expect(all).not.toContain('hunter2');
        expect(all).not.toContain('123-45-6789');
        expect(all).not.toContain('SENSITIVE-CHUNK');
    });
});
