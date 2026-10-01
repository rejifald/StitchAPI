// #890: a transport writes the URL it called into its OWN error message — `Failed to parse URL from
// http://host:99999/v1?api_key=…`, `request to https://host/v1?api_key=… failed` — and with
// `apiKey({ in: 'query' })` that URL carries the credential. #866 scrubbed the text at the MCP
// boundary; the maintainer's decision on #890 is to scrub ONCE, where the engine turns the throw
// into the error event (and so into `StitchError.message`), so every surface reading that message —
// MCP, `@stitchapi/vercel-ai`, `serve`, the trace sinks, OTLP, pino / sentry — gets the scrubbed text
// without having to remember to.
//
// These specs drive core only. The per-surface proofs (the MCP tool result, the vercel-ai tool
// failure the model reads) live with those surfaces; this is the root-cause guard behind them.
import { StitchError, stitch } from '../src';
import type { StitchEvent, TraceSink } from '../src';
import { apiKey } from '../src/auth';
import { otlp } from '../src/otlp';
import type { OtelSpan, SpanExporter } from '../src/otlp';
import { serve } from '../src/serve';
import type { Surface } from '../src/surface';
import { fileSink } from '../src/trace';

import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env['STITCH_TRACE_FILE'] = join(
    tmpdir(),
    `stitch-transport-scrub-${process.pid}.jsonl`,
);

const KEY = 'ak_live_qry_8899aabbccddeeff';

// A trace sink that keeps every event it is handed, raw — which is what a custom sink receives.
function capture(): { events: StitchEvent[]; sink: TraceSink } {
    const events: StitchEvent[] = [];
    return { events, sink: { handle: (e) => void events.push(e) } };
}

// The #866 reproduction, on the DEFAULT fetch adapter and zero lines of user code: a port the URL
// parser rejects makes the transport quote the whole request URL, key included.
const unparseable = (trace?: TraceSink) =>
    stitch({
        url: 'http://api.vendor.test:99999/v1/metrics',
        auth: apiKey({ in: 'query', secret: KEY }),
        retry: { attempts: 2, backoff: { curve: 'fixed', base: 1 } },
        ...(trace ? { trace } : {}),
    });

// The node-fetch shape: a routine DNS failure on a URL the parser ACCEPTS, quoted by the adapter.
// A vendor-spelled param name is caught because `apiKey` registers its `name` with the scrubber.
const dnsFailure = (trace?: TraceSink) =>
    stitch({
        url: 'https://api.vendor.test/v1/metrics?page=2',
        auth: apiKey({ in: 'query', name: 'vk', secret: KEY }),
        retry: { attempts: 2, backoff: { curve: 'fixed', base: 1 } },
        adapter: (request) =>
            Promise.reject(
                new Error(
                    `request to ${request.url} failed, reason: getaddrinfo ENOTFOUND api.vendor.test`,
                ),
            ),
        ...(trace ? { trace } : {}),
    });

describe('StitchError.message carries no URL credential after a transport throw (#890)', () => {
    test('awaited: apiKey({ in: "query" }) + the default adapter on a URL the parser rejects', async () => {
        const err = await unparseable()().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(StitchError);
        const { message } = err as StitchError;
        expect(message).toContain('Failed to parse URL'); // still a useful message…
        expect(message).toContain('api.vendor.test:99999/v1/metrics');
        expect(message).toContain('api_key=REDACTED'); // …that names the parameter, not its value
        expect(message).not.toContain(KEY);
    });

    test('awaited: a parseable URL in an adapter error, under a vendor-spelled param name', async () => {
        const err = (await dnsFailure()().catch((e: unknown) => e)) as Error;
        expect(err.message).toContain('getaddrinfo ENOTFOUND');
        expect(err.message).toContain('page=2'); // a benign param survives for diagnosis
        expect(err.message).toContain('vk=REDACTED');
        expect(err.message).not.toContain(KEY);
    });

    test('.safe() hands back the same scrubbed message', async () => {
        const { ok, error } = await unparseable()().safe();
        expect(ok).toBe(false);
        expect(error?.message).toContain('api_key=REDACTED');
        expect(error?.message).not.toContain(KEY);
    });

    test('.stream(): the error event the stream yields is scrubbed', async () => {
        const messages: string[] = [];
        for await (const ev of dnsFailure().stream()) {
            if (ev.type === 'error') messages.push(ev.message);
        }
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('vk=REDACTED');
        expect(messages[0]).not.toContain(KEY);
    });

    test('a user-info password in the quoted URL is stripped; a non-Error throw is still reported', async () => {
        const leaky = stitch({
            url: 'https://x.test/a',
            adapter: () =>
                Promise.reject(
                    new Error(
                        'upstream https://svc:hunter2@db.internal.test/q?access_token=tkn failed',
                    ),
                ),
        });
        const thrower = stitch({
            url: 'https://x.test/b',
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
            adapter: () => Promise.reject('plain string thrown'),
        });
        const err = (await leaky().catch((e: unknown) => e)) as Error;
        expect(err.message).toContain('db.internal.test');
        expect(err.message).not.toContain('hunter2');
        expect(err.message).not.toContain('tkn');
        const plain = (await thrower().catch((e: unknown) => e)) as Error;
        expect(plain.message).toBe('plain string thrown');
        // A bring-your-own adapter may throw a bag whose `message` is not a string: still reported.
        const bag = stitch({
            url: 'https://x.test/c',
            adapter: () =>
                // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
                Promise.reject({ message: 42 }),
        });
        expect(((await bag().catch((e: unknown) => e)) as Error).message).toBe(
            '42',
        );
    });
});

describe('every consumer of the message reads the scrubbed text (#890)', () => {
    test('a custom trace sink sees a scrubbed `error` event and a scrubbed retry `progress` detail', async () => {
        const { events, sink } = capture();
        await dnsFailure(sink)().catch(() => undefined);
        const error = events.find((e) => e.type === 'error');
        const retry = events.find(
            (e) => e.type === 'progress' && e.phase === 'retry',
        );
        expect(error).toBeDefined();
        expect(retry).toBeDefined(); // attempts: 2 ⇒ one retry, whose detail quotes the same message
        for (const ev of [error, retry]) {
            const text = JSON.stringify(ev);
            expect(text).toContain('vk=REDACTED');
            expect(text).not.toContain(KEY);
        }
    });

    test('OTLP: the span status message is scrubbed', async () => {
        const spans: OtelSpan[] = [];
        const exporter: SpanExporter = {
            export(batch) {
                spans.push(...batch);
            },
        };
        await dnsFailure(otlp.sink({ exporter }))().catch(() => undefined);
        const failed = spans.find((s) => s.status.code === 'ERROR');
        expect(failed?.status.message).toContain('vk=REDACTED');
        expect(JSON.stringify(spans)).not.toContain(KEY);
    });

    test('`stitch serve`: the JSON error body and the SSE error frame are scrubbed', async () => {
        const handle = await serve({ metrics: dnsFailure() }, { port: 0 });
        try {
            for (const accept of ['application/json', 'text/event-stream']) {
                const res = await fetch(`${handle.url}/stitch/metrics`, {
                    method: 'POST',
                    headers: { accept },
                    body: '{}',
                });
                const body = await res.text();
                expect(body).toContain('vk=REDACTED');
                expect(body).not.toContain(KEY);
            }
        } finally {
            await handle.close();
        }
    });

    // The built-in sinks (file / console / logger) redact the `start` URL through `scrubUrl`; the
    // error text is the other place the URL shows up in a log.
    test('the JSONL file sink writes no key for the failure', async () => {
        const file = join(
            tmpdir(),
            `stitch-scrub-${process.pid}-${Date.now()}.jsonl`,
        );
        await dnsFailure(fileSink(file))().catch(() => undefined);
        expect(existsSync(file)).toBe(true);
        const written = readFileSync(file, 'utf8');
        expect(written).toContain('vk=REDACTED');
        expect(written).not.toContain(KEY);
    });
});

describe('the foreign error is left alone, so `cause` stays the raw original (#890)', () => {
    // The decision: the engine scrubs the MESSAGE it mints and never mutates the throw it caught.
    // `cause` is for a caller who deliberately wants the transport's own error (its `.code`, its
    // undici nesting) — and therefore also its raw message. Documented residual: user code that logs
    // `err.cause` (or `console.error(err)`, which prints the cause chain) sees what the transport wrote.
    test('cause is the same object, unmodified', async () => {
        const transportError = new Error(
            `request to https://api.vendor.test/v1?vk=${KEY} failed`,
        );
        const metrics = stitch({
            url: 'https://api.vendor.test/v1',
            auth: apiKey({ in: 'query', name: 'vk', secret: KEY }),
            adapter: () => Promise.reject(transportError),
        });
        const err = (await metrics().catch((e: unknown) => e)) as StitchError;
        expect(err.message).not.toContain(KEY);
        expect(err.cause).toBe(transportError);
        expect(transportError.message).toContain(KEY);
    });
});

// A surface's verdict is the other free text the engine writes onto an error event: graphql's
// "200 with `errors`" quotes the upstream's own message, and an upstream can echo a URL.
describe('a surface verdict that quotes a URL is scrubbed too', () => {
    const echo = 'bad token for https://svc:hunter2@db.test/q?access_token=tkn';
    const surface = (retry: boolean): Surface => ({
        id: 'echo',
        interpret: () =>
            retry
                ? { ok: false, retry: true, message: echo }
                : { ok: false, message: echo },
    });
    const call = (kind: Surface, trace?: TraceSink) =>
        stitch({
            url: 'https://x.test/a',
            kind,
            retry: { attempts: 2, backoff: { curve: 'fixed', base: 1 } },
            adapter: () =>
                Promise.resolve({ status: 200, headers: {}, body: {} }),
            ...(trace ? { trace } : {}),
        });

    test('the failure message and the error event carry no credential', async () => {
        const { events, sink } = capture();
        const err = (await call(surface(false), sink)().catch(
            (e: unknown) => e,
        )) as Error;
        expect(err.message).toContain('db.test');
        expect(err.message).toContain('access_token=REDACTED');
        expect(err.message).not.toMatch(/hunter2|tkn/);
        const event = events.find((e) => e.type === 'error');
        expect(JSON.stringify(event)).not.toMatch(/hunter2|tkn/);
    });

    test('the `interpret:` retry detail does too', async () => {
        const { events, sink } = capture();
        await call(surface(true), sink)().catch(() => undefined);
        const retry = events.find(
            (e) => e.type === 'progress' && e.phase === 'retry',
        );
        expect(retry).toBeDefined();
        expect(JSON.stringify(retry)).toContain('access_token=REDACTED');
        expect(JSON.stringify(retry)).not.toMatch(/hunter2|tkn/);
    });

    test('`stitch serve` returns the scrubbed text', async () => {
        const handle = await serve({ echo: call(surface(false)) }, { port: 0 });
        try {
            const res = await fetch(`${handle.url}/stitch/echo`, {
                method: 'POST',
                body: '{}',
            });
            const body = await res.text();
            expect(body).toContain('access_token=REDACTED');
            expect(body).not.toMatch(/hunter2|tkn/);
        } finally {
            await handle.close();
        }
    });
});

// `throw undefined` / `throw null` have no properties to read: the engine used to dereference one
// while building the error event, so the failure became a TypeError out of the generator and
// `.stream()` rejected instead of yielding its `error` + `done` events.
describe('a nullish throw is reported like any other failure', () => {
    const nullish = (value: unknown, trace?: TraceSink) =>
        stitch({
            url: 'https://x.test/a',
            retry: { attempts: 2, backoff: { curve: 'fixed', base: 1 } },
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
            adapter: () => Promise.reject(value),
            ...(trace ? { trace } : {}),
        });

    test.each([undefined, null])('throw %s: awaited', async (value) => {
        const err = await nullish(value)().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(StitchError);
        expect((err as StitchError).message).toBe(String(value));
        expect((err as StitchError).attempts).toBe(2);
    });

    test.each([undefined, null])('throw %s: .safe()', async (value) => {
        const { ok, error } = await nullish(value)().safe();
        expect(ok).toBe(false);
        expect(error?.message).toBe(String(value));
    });

    test.each([undefined, null])(
        'throw %s: .stream() ends with error and done events',
        async (value) => {
            const types: string[] = [];
            for await (const ev of nullish(value).stream()) types.push(ev.type);
            expect(types).toContain('error');
            expect(types.at(-1)).toBe('done');
        },
    );
});
