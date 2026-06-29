import { loggerSink, stitch } from '../src';
import type { LoggerLike, StitchEvent } from '../src';
import { startMockServer } from './support/mock-server';
import type { MockServer } from './support/mock-server';

// loggerSink bridges the event stream to any host logger, mapping each StitchEvent
// to a level and NEVER logging the request/response payload (metadata only). These
// tests drive it two ways: through a real stitch run (start/result/error) and by
// synthesizing events directly (drift/delta), the latter to pin the payload-free
// guarantee and the never-log-delta rule without a streaming surface.

// A sentinel only ever present in response bodies / streamed chunks. If it shows up
// in ANY logged message, the sink leaked a payload.
const SECRET_BODY = 'sk-PAYLOAD-LEAK-DO-NOT-LOG';

// A fake LoggerLike that records every call as { level, message }. The four methods
// are exactly the LoggerLike surface, so this doubles as a type-level conformance check.
function fakeLogger(): {
    logger: LoggerLike;
    entries: { level: string; message: string }[];
} {
    const entries: { level: string; message: string }[] = [];
    const push = (level: string) => (message: string) =>
        entries.push({ level, message });
    return {
        entries,
        logger: {
            error: push('error'),
            warn: push('warn'),
            info: push('info'),
            debug: push('debug'),
        },
    };
}

const levelsFor = (
    entries: { level: string; message: string }[],
    needle: string,
): string[] =>
    entries.filter((e) => e.message.includes(needle)).map((e) => e.level);

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

// ---------------------------------------------------------------------------
// Real stitch runs: the lifecycle event → level mapping.
// ---------------------------------------------------------------------------

test('a successful call logs result at info and start at debug', async () => {
    const { logger, entries } = fakeLogger();
    server.route('GET', '/ping', { body: { token: SECRET_BODY } });
    const ping = stitch({
        name: 'ping',
        baseUrl: server.url,
        path: '/ping',
        trace: loggerSink(logger),
    });

    await expect(ping()).resolves.toEqual({ token: SECRET_BODY });

    // start → debug, result → info, done → debug.
    expect(levelsFor(entries, 'ping GET')).toEqual(['debug']);
    expect(levelsFor(entries, 'ping 200 ok')).toEqual(['info']);
    expect(levelsFor(entries, 'ping done in')).toEqual(['debug']);

    // PAYLOAD-FREE: the response body's sentinel must never appear in any message.
    for (const { message } of entries)
        expect(message).not.toContain(SECRET_BODY);
});

test('an erroring call logs at error', async () => {
    const { logger, entries } = fakeLogger();
    // A 500 with no retry budget surfaces as an `error` event.
    server.route('POST', '/boom', {
        statuses: [500],
        body: { detail: SECRET_BODY },
    });
    const boom = stitch({
        name: 'boom',
        method: 'POST',
        baseUrl: server.url,
        path: '/boom',
        trace: loggerSink(logger),
    });

    await expect(boom()).rejects.toBeInstanceOf(Error);

    // The error event is logged at `error`, and names the stitch.
    const errorLines = entries.filter((e) => e.level === 'error');
    expect(errorLines.length).toBeGreaterThanOrEqual(1);
    expect(errorLines.some((e) => e.message.startsWith('boom '))).toBe(true);

    // PAYLOAD-FREE even on the error path (the 500 body carried the sentinel).
    for (const { message } of entries)
        expect(message).not.toContain(SECRET_BODY);
});

// ---------------------------------------------------------------------------
// Synthesized events: drift level, delta-never-logged, overrides.
// ---------------------------------------------------------------------------

test("a drift event logs at the finding's own level", () => {
    const { logger, entries } = fakeLogger();
    const sink = loggerSink(logger);
    const ctx = { name: 'users' };

    // An error-level finding → error; a warn-level finding → warn; info → info.
    sink.handle(
        {
            type: 'drift',
            finding: { level: 'error', path: 'id', change: 'invalid' },
            at: 0,
        },
        ctx,
    );
    sink.handle(
        {
            type: 'drift',
            finding: { level: 'warn', path: 'name', change: 'coerced' },
            at: 0,
        },
        ctx,
    );
    sink.handle(
        {
            type: 'drift',
            finding: { level: 'info', path: 'extra', change: 'undeclared' },
            at: 0,
        },
        ctx,
    );

    expect(entries.map((e) => e.level)).toEqual(['error', 'warn', 'info']);
    // The drift line carries the path/change metadata, not any value.
    expect(entries[0]?.message).toContain('drift[error] id invalid');
});

test('a delta event is never logged', () => {
    const { logger, entries } = fakeLogger();
    const sink = loggerSink(logger);

    // A streamed chunk is raw response data — even carrying the sentinel, it is dropped.
    const delta: StitchEvent = { type: 'delta', chunk: SECRET_BODY, at: 0 };
    sink.handle(delta, { name: 'stream' });

    // Nothing logged at all, and certainly no payload.
    expect(entries).toEqual([]);
});

test('opts.levels overrides the default per event type', () => {
    const { logger, entries } = fakeLogger();
    // Route `result` to debug instead of its default info.
    const sink = loggerSink(logger, { levels: { result: 'debug' } });

    const result: StitchEvent = {
        type: 'result',
        value: { token: SECRET_BODY },
        status: 200,
        attempts: 1,
        at: 0,
    };
    sink.handle(result, { name: 'ping' });

    expect(levelsFor(entries, 'ping 200 ok')).toEqual(['debug']);
    // Even when logged, a result NEVER carries its value.
    for (const { message } of entries)
        expect(message).not.toContain(SECRET_BODY);
});

test('opts.levels can override the drift level too', () => {
    const { logger, entries } = fakeLogger();
    // Pin every drift to warn, regardless of the finding's own level.
    const sink = loggerSink(logger, { levels: { drift: 'warn' } });

    sink.handle(
        {
            type: 'drift',
            finding: { level: 'error', path: 'id', change: 'invalid' },
            at: 0,
        },
        { name: 'users' },
    );

    expect(entries.map((e) => e.level)).toEqual(['warn']);
});

// ---------------------------------------------------------------------------
// opts.level resolver + opts.format — the per-instance hooks @stitchapi/nest
// delegates through (a conditional level rule the per-type map can't express,
// and a different message house style), kept generic and tested here in core.
// ---------------------------------------------------------------------------

test('opts.level resolves per instance and takes precedence over levels', () => {
    const { logger, entries } = fakeLogger();
    // A `retry`/`circuit` progress is surfaced at warn; a routine throttle defers
    // (undefined) to `levels` — which the per-type map alone could never split.
    const sink = loggerSink(logger, {
        levels: { progress: 'debug' },
        level: (event) =>
            event.type === 'progress' &&
            (event.phase === 'retry' || event.phase === 'circuit')
                ? 'warn'
                : undefined,
    });

    sink.handle(
        { type: 'progress', phase: 'retry', attempt: 2, at: 0 },
        { name: 'x' },
    );
    sink.handle(
        { type: 'progress', phase: 'throttled', attempt: 1, at: 0 },
        { name: 'x' },
    );

    expect(levelsFor(entries, 'retry#2')).toEqual(['warn']); // resolver wins
    expect(levelsFor(entries, 'throttled#1')).toEqual(['debug']); // deferred to levels
});

test('opts.level returning null drops the event', () => {
    const { logger, entries } = fakeLogger();
    // Drop the happy-path lifecycle (start/result/done); keep everything else.
    const sink = loggerSink(logger, {
        level: (event) =>
            event.type === 'start' ||
            event.type === 'result' ||
            event.type === 'done'
                ? null
                : undefined,
    });

    sink.handle(
        {
            type: 'start',
            name: 'x',
            method: 'GET',
            url: 'https://h/p',
            input: {},
            at: 0,
        },
        { name: 'x' },
    );
    sink.handle(
        { type: 'result', value: 1, status: 200, attempts: 1, at: 0 },
        { name: 'x' },
    );
    sink.handle(
        {
            type: 'error',
            name: 'x',
            message: 'boom',
            status: 500,
            attempts: 1,
            at: 0,
        },
        { name: 'x' },
    );

    // start + result dropped by the resolver; only the error survives.
    expect(entries.map((e) => e.level)).toEqual(['error']);
});

test('opts.format overrides the one-liner; null skips the event', () => {
    const { logger, entries } = fakeLogger();
    const sink = loggerSink(logger, {
        format: (event, ctx) =>
            event.type === 'start' ? `custom ${ctx.name}` : null,
    });

    sink.handle(
        {
            type: 'start',
            name: 'x',
            method: 'GET',
            url: 'https://h/p',
            input: {},
            at: 0,
        },
        { name: 'x' },
    );
    // a non-start event → format returns null → nothing logged for it
    sink.handle(
        { type: 'done', ok: true, elapsed: 5, attempts: 1, at: 0 },
        { name: 'x' },
    );

    // The custom line is logged at the unchanged default level (start → debug).
    expect(entries).toEqual([{ level: 'debug', message: 'custom x' }]);
});

test('a delta event is dropped before opts.level/opts.format ever run', () => {
    const { logger, entries } = fakeLogger();
    let sawDelta = false;
    const note = () => {
        sawDelta = true;
        return undefined;
    };
    const sink = loggerSink(logger, {
        level: note,
        format: () => {
            sawDelta = true;
            return 'should-never-log';
        },
    });

    sink.handle({ type: 'delta', chunk: SECRET_BODY, at: 0 }, { name: 's' });

    expect(entries).toEqual([]); // never logged
    expect(sawDelta).toBe(false); // neither hook was invoked
});
