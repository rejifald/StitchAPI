// @stitchapi/sentry behaviour, driven with hand-built StitchEvents against a mock
// Sentry SDK (the structural SentryLike). No engine, no real Sentry.
import { sentrySink } from '../src';
import type {
    SentryBreadcrumb,
    SentryCaptureContext,
    SentryLevel,
    SentryLike,
} from '../src';

import type { StitchEvent, TraceContext } from 'stitchapi';
import { describe, expect, test } from 'vitest';

function mockSentry() {
    const breadcrumbs: SentryBreadcrumb[] = [];
    const captures: {
        message: string;
        context: SentryCaptureContext | SentryLevel | undefined;
    }[] = [];
    const sentry: SentryLike = {
        addBreadcrumb: (b) => breadcrumbs.push(b),
        captureMessage: (message, context) => {
            captures.push({ message, context });
            return 'event-id';
        },
    };
    return { sentry, breadcrumbs, captures };
}

const ctx: TraceContext = { name: 'getUser', runId: 'run-1' };

const ev = {
    start: {
        type: 'start',
        name: 'getUser',
        method: 'GET',
        url: 'https://api.example.com/users?api_key=SUPERSECRET',
        input: {} as never,
        at: 0,
    },
    progressRetry: { type: 'progress', phase: 'retry', attempt: 1, at: 0 },
    progressThrottle: {
        type: 'progress',
        phase: 'throttled',
        attempt: 1,
        waitedMs: 50,
        at: 0,
    },
    driftError: {
        type: 'drift',
        finding: { path: '$.user.name', level: 'error', change: 'invalid' },
        at: 0,
    },
    result: {
        type: 'result',
        value: { secret: 'X' },
        status: 200,
        attempts: 1,
        at: 0,
    },
    error: {
        type: 'error',
        name: 'StitchError',
        message: 'boom',
        status: 500,
        attempts: 2,
        at: 0,
    },
    delta: { type: 'delta', chunk: 'SUPERSECRET-TOKEN', at: 0 },
    info: { type: 'info', topic: 'auth', detail: 'bearer', at: 0 },
} satisfies Record<string, StitchEvent>;

describe('sentrySink', () => {
    test('captures an error event as a message with stitch context, plus a breadcrumb', () => {
        const { sentry, breadcrumbs, captures } = mockSentry();
        sentrySink(sentry).handle(ev.error, ctx);

        expect(captures).toHaveLength(1);
        expect(captures[0]!.message).toBe('getUser: StitchError — boom');
        expect(captures[0]!.context).toMatchObject({
            level: 'error',
            tags: { stitch: 'getUser', status: 500 },
            extra: { attempts: 2, runId: 'run-1' },
        });
        // The error is also breadcrumbed so it shows in the trail of any later issue.
        expect(breadcrumbs).toHaveLength(1);
        expect(breadcrumbs[0]!.level).toBe('error');
    });

    test('retry → warning breadcrumb; routine wait → debug breadcrumb', () => {
        const { sentry, breadcrumbs } = mockSentry();
        const sink = sentrySink(sentry);
        sink.handle(ev.progressRetry, ctx);
        sink.handle(ev.progressThrottle, ctx);
        expect(breadcrumbs.map((b) => b.level)).toEqual(['warning', 'debug']);
        expect(breadcrumbs[1]!.data).toMatchObject({
            phase: 'throttled',
            waitedMs: 50,
        });
    });

    test('lifecycle is off by default, on when enabled', () => {
        const off = mockSentry();
        sentrySink(off.sentry).handle(ev.start, ctx);
        sentrySink(off.sentry).handle(ev.result, ctx);
        expect(off.breadcrumbs).toHaveLength(0);

        const on = mockSentry();
        sentrySink(on.sentry, { lifecycle: true }).handle(ev.start, ctx);
        expect(on.breadcrumbs).toHaveLength(1);
    });

    test('error-level drift is breadcrumbed; captured only with captureDrift', () => {
        const a = mockSentry();
        sentrySink(a.sentry).handle(ev.driftError, ctx);
        expect(a.breadcrumbs).toHaveLength(1);
        expect(a.breadcrumbs[0]).toMatchObject({
            category: 'stitch.drift',
            level: 'error',
        });
        expect(a.captures).toHaveLength(0);

        const b = mockSentry();
        sentrySink(b.sentry, { captureDrift: true }).handle(ev.driftError, ctx);
        expect(b.captures).toHaveLength(1);
    });

    test('captureErrors:false still breadcrumbs the error but does not capture it as an issue', () => {
        const { sentry, breadcrumbs, captures } = mockSentry();
        sentrySink(sentry, { captureErrors: false }).handle(ev.error, ctx);

        // The error trail is preserved, but the framework owns the issue.
        expect(captures).toHaveLength(0);
        expect(breadcrumbs).toHaveLength(1);
        expect(breadcrumbs[0]!.level).toBe('error');
    });

    test('captureDrift only captures an error-level finding — a warn-level drift is breadcrumbed only', () => {
        const driftWarn: StitchEvent = {
            type: 'drift',
            finding: {
                path: '$.user.age',
                level: 'warn',
                change: 'coerced',
            },
            at: 0,
        };
        const { sentry, breadcrumbs, captures } = mockSentry();
        sentrySink(sentry, { captureDrift: true }).handle(driftWarn, ctx);

        // captureDrift is gated on an error-level finding; a warn drift only crumbs.
        expect(captures).toHaveLength(0);
        expect(breadcrumbs).toHaveLength(1);
        expect(breadcrumbs[0]).toMatchObject({
            category: 'stitch.drift',
            level: 'warning',
        });
    });

    test('delta and info events are never sent (raw data / announcements)', () => {
        const { sentry, breadcrumbs, captures } = mockSentry();
        const sink = sentrySink(sentry);
        sink.handle(ev.delta, ctx);
        sink.handle(ev.info, ctx);
        expect(breadcrumbs).toHaveLength(0);
        expect(captures).toHaveLength(0);
    });

    test('metadata only: no secret query, no input/value/chunk reaches Sentry', () => {
        const { sentry, breadcrumbs, captures } = mockSentry();
        const sink = sentrySink(sentry, { lifecycle: true });
        for (const e of Object.values(ev)) sink.handle(e, ctx);

        const dump = JSON.stringify({ breadcrumbs, captures });
        expect(dump).not.toContain('SUPERSECRET'); // query value + delta chunk
        expect(dump).not.toContain('api_key=');
        expect(dump).toContain('?…'); // the start URL is present but query-stripped
    });
});
