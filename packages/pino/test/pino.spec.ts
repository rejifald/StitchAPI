import {
    type PinoLoggerLike,
    type PinoSinkOptions,
    pinoSink,
} from '../src/index';

import type { StitchEvent, TraceContext } from 'stitchapi';
import { describe, expect, it } from 'vitest';

// A fake pino logger that records every call as { level, obj, msg }. Each level method
// accepts pino's structured shape (obj, msg?) — the only shape this sink ever calls.
interface Call {
    level: 'error' | 'warn' | 'info' | 'debug' | 'trace';
    obj: object | undefined;
    msg: string | undefined;
}

function fakeLogger(): PinoLoggerLike & { calls: Call[] } {
    const calls: Call[] = [];
    const make =
        (level: Call['level']) =>
        (a: object | string, b?: string): void => {
            if (typeof a === 'string')
                calls.push({ level, obj: undefined, msg: a });
            else calls.push({ level, obj: a, msg: b });
        };
    return {
        calls,
        error: make('error'),
        warn: make('warn'),
        info: make('info'),
        debug: make('debug'),
        trace: make('trace'),
    };
}

const ctx: TraceContext = { name: 'getUser' };

// Drive one event through the sink and return the recorded calls.
function run(event: StitchEvent, options?: PinoSinkOptions): Call[] {
    const logger = fakeLogger();
    pinoSink(logger, options).handle(event, ctx);
    return logger.calls;
}

// Concatenate every logged argument (message + every value in the structured obj) of a
// call into one string — the surface a secret could leak through.
function loggedText(call: Call): string {
    const objText = call.obj ? JSON.stringify(call.obj) : '';
    return `${call.msg ?? ''} ${objText}`;
}

describe('pinoSink — event → level mapping', () => {
    it('maps `error` to error', () => {
        const calls = run({
            type: 'error',
            name: 'getUser',
            message: 'boom',
            status: 500,
            attempts: 3,
            at: 0,
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.level).toBe('error');
        expect(calls[0]!.obj).toMatchObject({
            stitch: 'getUser',
            message: 'boom',
            status: 500,
            attempts: 3,
        });
    });

    it('maps `drift` to the finding level (error / warn / debug)', () => {
        const at = (level: 'error' | 'warn' | 'info'): StitchEvent => ({
            type: 'drift',
            finding: { level, path: 'data.id', change: 'invalid' },
            at: 0,
        });
        expect(run(at('error'))[0]!.level).toBe('error');
        expect(run(at('warn'))[0]!.level).toBe('warn');
        // info-level drift is pinned to debug
        expect(run(at('info'))[0]!.level).toBe('debug');
    });

    it('maps `progress` to warn for retry/circuit, debug otherwise', () => {
        const phase = (p: string): StitchEvent =>
            ({
                type: 'progress',
                phase: p,
                attempt: 1,
                at: 0,
            }) as StitchEvent;
        expect(run(phase('retry'))[0]!.level).toBe('warn');
        expect(run(phase('circuit'))[0]!.level).toBe('warn');
        expect(run(phase('throttled'))[0]!.level).toBe('debug');
        expect(run(phase('paginate'))[0]!.level).toBe('debug');
        expect(run(phase('cache'))[0]!.level).toBe('debug');
    });

    it('maps lifecycle events: start→debug, result→info, done→debug', () => {
        const start = run({
            type: 'start',
            name: 'getUser',
            method: 'GET',
            url: 'https://api.example.com/users/1',
            input: {},
            at: 0,
        });
        expect(start[0]!.level).toBe('debug');

        const result = run({
            type: 'result',
            value: { id: 1 },
            status: 200,
            attempts: 1,
            at: 0,
        });
        expect(result[0]!.level).toBe('info');

        const done = run({
            type: 'done',
            ok: true,
            elapsed: 12,
            attempts: 1,
            at: 0,
        });
        expect(done[0]!.level).toBe('debug');
    });

    it('drops `info` announcements', () => {
        expect(
            run({ type: 'info', topic: 'auth', detail: 'env:TOKEN', at: 0 }),
        ).toHaveLength(0);
    });

    it('NEVER logs a `delta` chunk', () => {
        const calls = run({
            type: 'delta',
            chunk: { secret: 'streaming-body-data' },
            at: 0,
        });
        expect(calls).toHaveLength(0);
    });

    it('logs in pino structured form: an object plus a short message', () => {
        const calls = run({
            type: 'result',
            value: { id: 1 },
            status: 200,
            attempts: 1,
            at: 0,
        });
        expect(calls[0]!.obj).toBeTypeOf('object');
        expect(calls[0]!.msg).toBeTypeOf('string');
        expect(calls[0]!.obj).toMatchObject({ stitch: 'getUser', status: 200 });
    });
});

describe('pinoSink — lifecycle gating', () => {
    it('lifecycle:false suppresses start / result / done', () => {
        const opts: PinoSinkOptions = { lifecycle: false };
        expect(
            run(
                {
                    type: 'start',
                    name: 'getUser',
                    method: 'GET',
                    url: 'https://api.example.com/users/1',
                    input: {},
                    at: 0,
                },
                opts,
            ),
        ).toHaveLength(0);
        expect(
            run(
                {
                    type: 'result',
                    value: { id: 1 },
                    status: 200,
                    attempts: 1,
                    at: 0,
                },
                opts,
            ),
        ).toHaveLength(0);
        expect(
            run(
                { type: 'done', ok: true, elapsed: 12, attempts: 1, at: 0 },
                opts,
            ),
        ).toHaveLength(0);
    });

    it('lifecycle:false still logs errors and drift', () => {
        const opts: PinoSinkOptions = { lifecycle: false };
        expect(
            run(
                {
                    type: 'error',
                    name: 'getUser',
                    message: 'boom',
                    attempts: 1,
                    at: 0,
                },
                opts,
            ),
        ).toHaveLength(1);
        expect(
            run(
                {
                    type: 'drift',
                    finding: {
                        level: 'warn',
                        path: 'data.id',
                        change: 'invalid',
                    },
                    at: 0,
                },
                opts,
            ),
        ).toHaveLength(1);
    });
});

describe('pinoSink — URL redaction', () => {
    it('strips the query string from a `start` URL (both message and obj)', () => {
        const calls = run({
            type: 'start',
            name: 'getUser',
            method: 'GET',
            url: 'https://api.example.com/users?api_key=SECRET123&page=2',
            input: {},
            at: 0,
        });
        const text = loggedText(calls[0]!);
        expect(text).not.toContain('SECRET123');
        expect(text).not.toContain('api_key');
        expect(text).not.toContain('page=2');
        expect(text).toContain('https://api.example.com/users');
        // the obj's url field is the redacted form
        expect((calls[0]!.obj as { url: string }).url).toBe(
            'https://api.example.com/users?…',
        );
    });
});

describe('pinoSink — secret safety', () => {
    it('never logs an `input.headers.authorization` secret', () => {
        const calls = run({
            type: 'start',
            name: 'getUser',
            method: 'GET',
            url: 'https://api.example.com/users/1',
            input: {
                headers: {
                    authorization: 'Bearer super-secret-token-xyz',
                    cookie: 'session=topsecret',
                },
                body: { password: 'hunter2' },
            },
            at: 0,
        });
        expect(calls).toHaveLength(1);
        const text = loggedText(calls[0]!);
        expect(text).not.toContain('super-secret-token-xyz');
        expect(text).not.toContain('Bearer');
        expect(text).not.toContain('topsecret');
        expect(text).not.toContain('hunter2');
        // and the raw input object is never attached to the record
        expect(JSON.stringify(calls[0]!.obj)).not.toContain('headers');
    });

    it('never logs the `result.value` response body', () => {
        const calls = run({
            type: 'result',
            value: { ssn: '123-45-6789', token: 'leak-me' },
            status: 200,
            attempts: 1,
            at: 0,
        });
        const text = loggedText(calls[0]!);
        expect(text).not.toContain('123-45-6789');
        expect(text).not.toContain('leak-me');
    });
});
