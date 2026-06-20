// Direct tests for redactEventForTransport (src/trace.ts) — the scrubber the `stitch serve` SSE
// stream (unauthenticated, possibly fronted) runs over every event before it leaves the process.
// No spec exercises it directly, yet it is the security boundary for that transport. It must:
//   - pass NON-start events through untouched (a delta/result payload the consumer asked for);
//   - on a `start` event, redact secret request headers (case-insensitive) and secret query params,
//     and scrub the URL (userinfo + secret query values) — while keeping benign headers/params;
//   - never mutate the original event (the engine keeps the real values).
import { redactEventForTransport } from '../src/trace';
import type { StitchEvent } from '../src/types';

type StartEvent = Extract<StitchEvent, { type: 'start' }>;

const startEvent = (over: Partial<StartEvent> = {}): StartEvent => ({
    type: 'start',
    name: 'getThing',
    method: 'GET',
    url: 'https://api.test/x',
    input: {},
    at: 1,
    ...over,
});

const asStart = (ev: StitchEvent): StartEvent => {
    if (ev.type !== 'start') throw new Error('expected a start event');
    return ev;
};

describe('redactEventForTransport', () => {
    test('passes a non-start event through unchanged (payload preserved)', () => {
        const delta: StitchEvent = {
            type: 'delta',
            chunk: { keep: 'this' },
            at: 1,
        };
        expect(redactEventForTransport(delta)).toBe(delta); // same reference
    });

    test('redacts secret request headers case-insensitively, keeping benign ones', () => {
        const out = asStart(
            redactEventForTransport(
                startEvent({
                    input: {
                        headers: {
                            Authorization: 'Bearer tok',
                            Cookie: 'sid=1',
                            'X-Trace': '1',
                        },
                    },
                }),
            ),
        );
        expect(out.input.headers!['Authorization']).toBe('[REDACTED]');
        expect(out.input.headers!['Cookie']).toBe('[REDACTED]');
        expect(out.input.headers!['X-Trace']).toBe('1'); // benign header kept
    });

    test('redacts secret query params, keeping benign ones', () => {
        const out = asStart(
            redactEventForTransport(
                startEvent({
                    input: {
                        query: {
                            api_key: 'sekret',
                            access_token: 'tok',
                            page: '2',
                        },
                    },
                }),
            ),
        );
        expect(out.input.query!['api_key']).toBe('[REDACTED]');
        expect(out.input.query!['access_token']).toBe('[REDACTED]');
        expect(out.input.query!['page']).toBe('2');
    });

    test('scrubs the URL: userinfo and secret query values, keeping benign params', () => {
        const out = asStart(
            redactEventForTransport(
                startEvent({
                    url: 'https://user:pass@api.test/x?api_key=sekret&page=2',
                }),
            ),
        );
        expect(out.url).not.toContain('user:pass');
        expect(out.url).not.toContain('sekret');
        expect(out.url).toContain('page=2');
        expect(out.url).toContain('REDACTED'); // scrubUrl's redaction marker
    });

    test('handles a start event with no headers/query (still scrubs the URL)', () => {
        const out = asStart(
            redactEventForTransport(
                startEvent({ input: {}, url: 'https://user:pass@api.test/x' }),
            ),
        );
        expect(out.url).toBe('https://api.test/x');
        expect(out.input.headers).toBeUndefined();
    });

    test('does not mutate the original event', () => {
        const orig = startEvent({
            input: { headers: { authorization: 'Bearer tok' } },
        });
        redactEventForTransport(orig);
        expect(orig.input.headers!['authorization']).toBe('Bearer tok');
    });
});
