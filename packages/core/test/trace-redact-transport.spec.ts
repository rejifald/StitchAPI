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

    test('deep-redacts secret-named fields in the echoed request body and GraphQL variables, keeping benign ones', () => {
        // A `start` frame echoes the caller's request input verbatim. On the unauthenticated
        // `serve` SSE stream a credential-bearing body (OAuth password grant) or GraphQL variable
        // must not ride the wire in the clear — headers/query redaction alone left this gap.
        const out = asStart(
            redactEventForTransport(
                startEvent({
                    input: {
                        body: {
                            grant_type: 'password',
                            password: 'hunter2',
                            client_secret: 's3cr3t',
                            keep: 'ok',
                        },
                        variables: { password: 'hunter2', user: 'alice' },
                    },
                }),
            ),
        );
        const body = out.input.body as Record<string, unknown>;
        expect(body['password']).toBe('REDACTED'); // secret body field scrubbed
        expect(body['client_secret']).toBe('REDACTED'); // `secret` stem caught
        expect(body['keep']).toBe('ok'); // benign body field preserved
        expect(body['grant_type']).toBe('password'); // benign field whose *value* is "password" kept
        expect(out.input.variables!['password']).toBe('REDACTED'); // secret GraphQL variable scrubbed
        expect(out.input.variables!['user']).toBe('alice'); // benign variable preserved
        // Belt-and-braces: the serialized event carries neither plaintext secret anywhere.
        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain('hunter2');
        expect(serialized).not.toContain('s3cr3t');
    });

    test('does not add a `body`/`variables` key when the caller sent none', () => {
        const out = asStart(redactEventForTransport(startEvent({ input: {} })));
        expect('body' in out.input).toBe(false);
        expect('variables' in out.input).toBe(false);
    });

    test('does not mutate the original event', () => {
        const orig = startEvent({
            input: {
                headers: { authorization: 'Bearer tok' },
                body: { password: 'hunter2' },
                variables: { token: 'v-tok' },
            },
        });
        redactEventForTransport(orig);
        expect(orig.input.headers!['authorization']).toBe('Bearer tok');
        expect((orig.input.body as Record<string, unknown>)['password']).toBe(
            'hunter2',
        ); // engine keeps the real body
        expect(orig.input.variables!['token']).toBe('v-tok'); // and the real variables
    });
});
