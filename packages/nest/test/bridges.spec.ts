// Unit tests for @stitchapi/nest's three bridges (`bridges.ts`), which no spec
// touched: `loggerSink` (StitchEvent → Nest log level, delegating to core), the
// `fromConfig` ConfigService-backed secret resolver, and `borrowStore` (a store
// wrapper that deliberately omits `close`). Pure — no Nest app, no network: we
// drive recording doubles directly.
import { borrowStore, fromConfig, loggerSink } from '../src';
import type { ConfigServiceLike, LoggerLike } from '../src';

import type { StitchEvent, StitchStore, TraceContext } from 'stitchapi';
import { describe, expect, test } from 'vitest';

// --- loggerSink ------------------------------------------------------------

type RecordedLevel = 'log' | 'warn' | 'error' | 'debug' | 'verbose';

// A recording Nest-logger double. `partial` omits debug/verbose to prove the
// sink guards those optional methods.
function recorder(partial = false): {
    logger: LoggerLike;
    calls: Array<{ level: RecordedLevel; message: string }>;
} {
    const calls: Array<{ level: RecordedLevel; message: string }> = [];
    const push =
        (level: RecordedLevel) =>
        (m: string): void => {
            calls.push({ level, message: m });
        };
    const logger: LoggerLike = partial
        ? { log: push('log'), warn: push('warn'), error: push('error') }
        : {
              log: push('log'),
              warn: push('warn'),
              error: push('error'),
              debug: push('debug'),
              verbose: push('verbose'),
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

describe('loggerSink — level mapping', () => {
    test('maps each event type to a Nest level (result → verbose, lifecycle → debug)', () => {
        const { logger, calls } = recorder();
        const sink = loggerSink(logger);

        const events: StitchEvent[] = [
            startEvent('https://api.test/u'),
            { type: 'progress', phase: 'retry', attempt: 2, at: 0 },
            { type: 'progress', phase: 'throttled', attempt: 1, at: 0 },
            {
                type: 'result',
                value: { id: 1 },
                status: 200,
                attempts: 1,
                at: 0,
            },
            {
                type: 'error',
                name: 'StitchError',
                message: 'boom',
                status: 502,
                attempts: 3,
                at: 0,
            },
            { type: 'done', ok: true, ms: 5, attempts: 1, at: 0 },
        ];
        for (const e of events) sink.handle(e, ctx);

        // Core `info` routes to Nest `verbose` (where `result` lands); the rest of
        // the happy-path lifecycle sits at `debug`; a flaky progress → `warn`.
        expect(calls.map((c) => c.level)).toEqual([
            'debug',
            'warn',
            'debug',
            'verbose',
            'error',
            'debug',
        ]);
    });

    test('drift follows its finding level, pinning info-drift to debug', () => {
        const { logger, calls } = recorder();
        const sink = loggerSink(logger);
        const drift = (level: 'error' | 'warn' | 'info'): StitchEvent => ({
            type: 'drift',
            finding: { level, path: 'data.id', change: 'type-changed' },
            at: 0,
        });

        sink.handle(drift('error'), ctx);
        sink.handle(drift('warn'), ctx);
        sink.handle(drift('info'), ctx);

        expect(calls.map((c) => c.level)).toEqual(['error', 'warn', 'debug']);
    });

    test('delta chunks and info announcements are never logged', () => {
        const { logger, calls } = recorder();
        const sink = loggerSink(logger);

        sink.handle({ type: 'info', topic: 'auth', detail: 'x', at: 0 }, ctx);
        sink.handle({ type: 'delta', chunk: 'raw-data', at: 0 }, ctx);

        expect(calls).toEqual([]);
    });

    test('lifecycle:false drops start/result/done but keeps errors and retries', () => {
        const { logger, calls } = recorder();
        const sink = loggerSink(logger, { lifecycle: false });

        sink.handle(startEvent('https://api.test/u'), ctx);
        sink.handle(
            { type: 'result', value: 1, status: 200, attempts: 1, at: 0 },
            ctx,
        );
        sink.handle({ type: 'done', ok: true, ms: 1, attempts: 1, at: 0 }, ctx);
        sink.handle(
            { type: 'error', name: 'E', message: 'x', attempts: 1, at: 0 },
            ctx,
        );
        sink.handle(
            { type: 'progress', phase: 'retry', attempt: 2, at: 0 },
            ctx,
        );

        expect(calls.map((c) => c.level)).toEqual(['error', 'warn']);
    });

    test('a partial logger (no debug/verbose) does not throw — those events are skipped', () => {
        const { logger, calls } = recorder(true);
        const sink = loggerSink(logger);

        sink.handle(startEvent('https://api.test/u'), ctx); // debug → no-op
        sink.handle(
            { type: 'result', value: 1, status: 200, attempts: 1, at: 0 },
            ctx,
        ); // verbose → no-op
        sink.handle(
            { type: 'error', name: 'E', message: 'x', attempts: 1, at: 0 },
            ctx,
        ); // error → recorded

        expect(calls.map((c) => c.level)).toEqual(['error']);
    });
});

describe('loggerSink — messages & security', () => {
    test('uses the trace-context name in the message', () => {
        const { logger, calls } = recorder();
        const sink = loggerSink(logger);

        sink.handle(
            { type: 'result', value: 1, status: 201, attempts: 2, at: 0 },
            { name: 'createOrder' },
        );

        expect(calls[0]?.message).toBe('← createOrder 201 (2 attempt(s))');
    });

    test('strips the URL query and logs only metadata — never raw input/value/delta', () => {
        const { logger, calls } = recorder();
        const sink = loggerSink(logger);

        sink.handle(
            startEvent('https://api.test/login?api_key=SECRET', {
                headers: { authorization: 'Bearer TOKEN' },
                body: { password: 'hunter2' },
            }),
            ctx,
        );
        sink.handle(
            {
                type: 'result',
                value: { password: 'hunter2', ssn: '123-45-6789' },
                status: 200,
                attempts: 1,
                at: 0,
            },
            ctx,
        );
        sink.handle({ type: 'delta', chunk: 'SENSITIVE-CHUNK', at: 0 }, ctx);

        const all = calls.map((c) => c.message).join('\n');
        expect(all).toContain('https://api.test/login?…');
        expect(all).not.toContain('SECRET');
        expect(all).not.toContain('api_key');
        expect(all).not.toContain('TOKEN');
        expect(all).not.toContain('hunter2');
        expect(all).not.toContain('123-45-6789');
        expect(all).not.toContain('SENSITIVE-CHUNK');
    });
});

// --- fromConfig ------------------------------------------------------------

function fakeConfig(map: Record<string, string>): {
    config: ConfigServiceLike;
    keys: string[];
} {
    const keys: string[] = [];
    const config: ConfigServiceLike = {
        getOrThrow<T = string>(key: string): T {
            keys.push(key);
            if (!(key in map)) {
                throw new Error(`Configuration key "${key}" does not exist`);
            }
            return map[key] as T;
        },
    };
    return { config, keys };
}

describe('fromConfig', () => {
    test('resolves lazily at call time, then returns the value', () => {
        const { config, keys } = fakeConfig({ API_TOKEN: 'tok' });
        const thunk = fromConfig(config)('API_TOKEN');

        // The thunk holds the key but has not touched the config yet — the secret
        // never lands on __config or in a trace.
        expect(keys).toEqual([]);
        expect(thunk()).toBe('tok');
        expect(keys).toEqual(['API_TOKEN']);
    });

    test('propagates a missing-key error from getOrThrow', () => {
        const { config } = fakeConfig({});
        const resolve = fromConfig(config)('MISSING');
        expect(() => resolve()).toThrow(/Configuration key "MISSING"/);
    });

    test('rejects an empty value so a blank credential can never ride along', () => {
        const { config } = fakeConfig({ BLANK: '' });
        const resolve = fromConfig(config)('BLANK');
        expect(() => resolve()).toThrow(/missing secret BLANK/);
    });
});

// --- borrowStore -----------------------------------------------------------

describe('borrowStore', () => {
    test('delegates get/set/incr but omits close, so a seam cannot dispose the app store', async () => {
        const seen: string[] = [];
        let closed = false;
        const store: StitchStore = {
            get: async (k) => {
                seen.push(`get:${k}`);
                return 'v';
            },
            set: async (k, v, ttl) => {
                seen.push(`set:${k}=${String(v)}@${String(ttl)}`);
            },
            incr: async (k, ttl) => {
                seen.push(`incr:${k}@${ttl}`);
                return 7;
            },
            close: async () => {
                closed = true;
            },
        };

        const borrowed = borrowStore(store);

        // The borrowed wrapper exposes no close (ADR 0006 Decision 8).
        expect(borrowed.close).toBeUndefined();

        expect(await borrowed.get('a')).toBe('v');
        await borrowed.set('b', 'x', 1000);
        expect(await borrowed.incr('c', 2000)).toBe(7);

        expect(seen).toEqual(['get:a', 'set:b=x@1000', 'incr:c@2000']);
        expect(closed).toBe(false);
    });
});
