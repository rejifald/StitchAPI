// Second half of the #873 class guard (`no-secret-in-safe-outputs.spec.ts` is the first): the SHAPES
// the first suite's single fixture does not reach, found in review of the fix —
//
//   - an endpoint that is not an absolute URL (a relative `path`/`url`, a protocol-relative
//     `//user:pw@host`, the `stitch('https://…')` string form) and one that is an RFC 6570 template;
//   - the display NAME a nameless string-form stitch derives from its URL (every trace record, hook,
//     console line and `stitch run` line carries it);
//   - the cache id `seam.invalidate(stitch)` derives from the RAW config, which scrubbing must not
//     move;
//   - the `message` a `StitchError` serialises, which a transport error fills with the whole URL;
//   - header names the five-name denylist missed (`api-key`, `Ocp-Apim-Subscription-Key`, …);
//   - the file sink's payload walk: a `Date` must survive it, a token COUNT or flag must not be
//     redacted, a `code` / `key` / `auth` field is data in a payload but a credential in a query.
import {
    StitchError,
    fileSink,
    memoryStore,
    multiplex,
    seam,
    secrets,
    stitch,
} from '../src';
import type { Adapter, Stitch, StitchEvent, TraceSink } from '../src';
import { paramNamesOf, runStitch } from '../src/cli';
import { toMermaid } from '../src/diagram';
import { createMcpServer } from '../src/mcp';
import type { JsonRpcMessage } from '../src/mcp';
import { redactEventForTransport } from '../src/trace';
import { redactSecretsDeep } from '../src/util';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';

const SECRET = {
    query: 'qsecret873b',
    userinfo: 'upass873b',
    header: 'hsecret873b',
    body: 'bsecret873b',
} as const;

const dir = mkdtempSync(join(tmpdir(), 'stitch-873-shapes-'));
afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});

const ok =
    (body: unknown = { ok: true }): Adapter =>
    async (req) => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body,
        url: req.url,
    });

// The slice of a JSONL record these tests read.
interface TraceRecord {
    type: string;
    url?: string;
    data?: unknown;
    input?: {
        headers?: Record<string, unknown>;
        query?: Record<string, unknown>;
        body?: unknown;
    };
}

// The JSONL records a file sink wrote, one parsed object per line.
const records = (file: string): TraceRecord[] =>
    readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as TraceRecord);

async function describeStitch(s: Stitch<unknown, never>): Promise<string> {
    const server = createMcpServer({ s });
    const res = (await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'describe_stitch', arguments: { name: 's' } },
    })) as JsonRpcMessage & { result: { content: { text: string }[] } };
    return res.result.content.map((c) => c.text).join('\n');
}

describe('endpoint shapes: every form of a literal secret is scrubbed from the config echo', () => {
    const SHAPES: {
        name: string;
        build: () => Stitch<unknown, never>;
        call: boolean;
    }[] = [
        {
            name: 'baseUrl + templated relative path with a query',
            build: () =>
                stitch({
                    baseUrl: 'https://h.test',
                    path: `/a/{id}?page=2&api_key=${SECRET.query}`,
                    adapter: ok(),
                }),
            call: true,
        },
        {
            name: 'relative url',
            build: () =>
                stitch({
                    url: `/a/{id}?page=2&api_key=${SECRET.query}`,
                    adapter: ok(),
                }),
            call: true,
        },
        {
            name: 'protocol-relative url with userinfo',
            build: () =>
                stitch({
                    url: `//svc:${SECRET.userinfo}@h.test/a/{id}?api_key=${SECRET.query}`,
                    adapter: ok(),
                }),
            call: true,
        },
        {
            name: 'string form',
            build: () =>
                stitch(
                    `https://svc:${SECRET.userinfo}@h.test/a/{id}?page=2&api_key=${SECRET.query}`,
                ),
            call: false,
        },
    ];

    test.each(SHAPES)(
        '$name: __config, diagram, MCP describe_stitch and report() carry none',
        async ({ build, call }) => {
            const s = build();
            const outputs = [
                JSON.stringify(s.__config),
                toMermaid({ s }).diagram,
                await describeStitch(s),
            ];
            if (call)
                outputs.push(
                    JSON.stringify(
                        await (s as unknown as Stitch).report({
                            params: { id: '1' },
                        }),
                    ),
                );
            for (const out of outputs) {
                expect(out.length).toBeGreaterThan(0);
                expect(out).not.toContain(SECRET.query);
                expect(out).not.toContain(SECRET.userinfo);
            }
            // …while what is not secret stays: the template slot, the benign query pair.
            expect(JSON.stringify(s.__config)).toContain('{id}');
            expect(JSON.stringify(s.__config)).toContain('api_key=REDACTED');
        },
    );

    test('the engine still SENDS the real endpoint (the scrub is output-only)', async () => {
        const sent: string[] = [];
        const s = stitch({
            baseUrl: 'https://h.test',
            path: `/a?api_key=${SECRET.query}`,
            adapter: async (req) => {
                sent.push(req.url);
                return { status: 200, headers: {}, body: {}, url: req.url };
            },
        });
        await s();
        expect(sent).toEqual([`https://h.test/a?api_key=${SECRET.query}`]);
    });

    // The engine's own "not absolute" error quotes the endpoint it refused: a relative URL, a
    // protocol-relative one with userinfo, one whose password holds a raw `/` (base64). A scan
    // anchored on `://` leaked every one of them. (A URL nested in a benign param reaches this
    // message percent-encoded — the engine re-encodes the query — which `scrubUrl` does not decode.)
    test.each([
        ['relative', `/v1?api_key=${SECRET.query}`],
        [
            'protocol-relative with userinfo',
            `//svc:${SECRET.userinfo}@h.test/v1?token=${SECRET.query}`,
        ],
        [
            'a password with a raw slash',
            `//svc:${SECRET.userinfo.slice(0, 3)}/${SECRET.userinfo.slice(3)}@h.test/v1`,
        ],
    ])(
        'the %s config error quotes the endpoint scrubbed',
        async (_name, url) => {
            const s = stitch({ url }); // default transport: a non-absolute URL is refused
            const out = await s.safe();
            expect(out.ok).toBe(false);
            const message = out.error?.message ?? '';
            expect(message).toContain('is not absolute');
            expect(message).not.toContain(SECRET.query);
            const json = JSON.stringify(out.error);
            expect(json).not.toContain(SECRET.query);
            expect(json).not.toContain(SECRET.userinfo.slice(0, 3));
        },
    );
});

describe('RFC 6570 templates survive the scrub', () => {
    test('a `{?page,token}` query expression is left alone and its params are still routed', () => {
        const s = stitch({
            url: 'https://h.test/a{?page,token}',
            adapter: ok(),
        });
        expect(s.__config.url).toBe('https://h.test/a{?page,token}');
        expect(paramNamesOf(s)).toEqual(['page', 'token']);
    });

    test('a lone `{?api_key}` gets no stray `=REDACTED`', () => {
        const s = stitch({ url: 'https://h.test/a{?api_key}', adapter: ok() });
        expect(s.__config.url).toBe('https://h.test/a{?api_key}');
        expect(paramNamesOf(s)).toEqual(['api_key']);
    });

    test('a templated credential keeps its slot: `?api_key={apiKey}` reads as written', () => {
        const s = stitch({
            url: 'https://h.test/a?api_key={apiKey}&page={page}',
            adapter: ok(),
        });
        expect(s.__config.url).toBe(
            'https://h.test/a?api_key={apiKey}&page={page}',
        );
        expect(paramNamesOf(s)).toEqual(['apiKey', 'page']);
    });

    test('a percent-encoded brace is not a template: no phantom param appears', () => {
        const s = stitch({ url: 'https://h.test/a%7Bb%7D', adapter: ok() });
        expect(s.__config.url).toBe('https://h.test/a%7Bb%7D');
        expect(paramNamesOf(s)).toEqual([]);
    });

    test('a templated userinfo is a param slot, not a literal credential', () => {
        const s = stitch({
            url: 'https://{user}:{pass}@h.test/a',
            adapter: ok(),
        });
        expect(paramNamesOf(s)).toEqual(['user', 'pass']);
    });
});

describe('seam.invalidate(stitch) targets the id the engine used, not the scrubbed display path', () => {
    test('a member whose path carries a secret is actually evicted', async () => {
        let calls = 0;
        const api = seam({
            store: memoryStore(),
            trace: false,
            adapter: async (req) => {
                calls += 1;
                return {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                    body: { n: calls },
                    url: req.url,
                };
            },
        });
        const member = api.stitch({
            path: `https://h.test/x?api_key=${SECRET.query}`,
            cache: { ttl: '60s', tenancy: 'app' },
        });
        const other = api.stitch({
            path: 'https://h.test/y',
            cache: { ttl: '60s', tenancy: 'app' },
        });
        await member();
        await member();
        await other();
        expect(calls).toBe(2); // member served from cache the second time
        expect(member.__config.path).not.toContain(SECRET.query);

        await api.invalidate(member);
        await member(); // evicted: goes to the origin again
        await other(); // untouched
        expect(calls).toBe(3);
    });
});

describe('the display name of a nameless stitch is scrubbed everywhere it surfaces', () => {
    const URL_WITH_SECRET = `https://svc:${SECRET.userinfo}@h.test/x?page=1&api_key=${SECRET.query}`;

    test('trace ctx name, event names, hook names, the JSONL file and `stitch run` carry no secret', async () => {
        const names: string[] = [];
        // A custom sink is handed the RAW events (its job to scrub the url), so only NAMES are read.
        const eventNames: string[] = [];
        const sink: TraceSink = {
            handle(ev, ctx) {
                names.push(ctx.name);
                if (ev.type === 'start') eventNames.push(ev.name);
            },
        };
        const hookNames: string[] = [];
        const file = join(dir, 'name.jsonl');
        const s = stitch({
            path: URL_WITH_SECRET, // what `stitch('https://…')` stores — no `name`
            adapter: ok(),
            trace: multiplex(sink, fileSink(file)),
            hooks: { onRequest: ({ name }) => void hookNames.push(name) },
        });
        await s();
        const lines: string[] = [];
        await runStitch({ s }, 's', [], (l) => lines.push(l));

        const out = [
            names.join('\n'),
            eventNames.join('\n'),
            hookNames.join('\n'),
            readFileSync(file, 'utf8'),
            lines.join('\n'),
        ].join('\n');
        expect(names.length).toBeGreaterThan(0);
        expect(eventNames.length).toBeGreaterThan(0);
        expect(hookNames.length).toBeGreaterThan(0);
        expect(out).not.toContain(SECRET.query);
        expect(out).not.toContain(SECRET.userinfo);
        // The name is still useful: the host and the benign query survive.
        expect(names[0]).toBe('https://h.test/x?page=1&api_key=REDACTED');
    });

    test('the construction-time console.warn does not quote the secret either', () => {
        const warn = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => undefined);
        try {
            stitch({
                path: URL_WITH_SECRET,
                idempotency: true, // idempotency on a GET: the warning names the stitch
                adapter: ok(),
            });
            expect(warn).toHaveBeenCalled();
            const text = warn.mock.calls.flat().join('\n');
            expect(text).not.toContain(SECRET.query);
            expect(text).not.toContain(SECRET.userinfo);
        } finally {
            warn.mockRestore();
        }
    });
});

describe('StitchError.toJSON scrubs URLs quoted in the message', () => {
    const MESSAGES = [
        `Failed to parse URL from http://svc:${SECRET.userinfo}@h.test:99999/v1?page=1&api_key=${SECRET.query}`,
        `connect ECONNREFUSED https://h.test/v1?access_token=${SECRET.query}`,
        `request to //svc:${SECRET.userinfo}@h.test/v1 failed (see https://h.test/v1?sig=${SECRET.query}.)`,
    ];

    test.each(MESSAGES)('%s', (message) => {
        const err = new StitchError(message, { attempts: 1 });
        const json = JSON.stringify(err);
        expect(json).not.toContain(SECRET.query);
        expect(json).not.toContain(SECRET.userinfo);
        expect(JSON.parse(json).message).toContain('h.test'); // still readable
        expect(err.message).toBe(message); // the live message is untouched
    });

    test('through a real failing call: the transport error a custom adapter throws', async () => {
        const s = stitch({
            name: 'transport',
            url: 'https://h.test/v1',
            adapter: async () => {
                throw new Error(MESSAGES[0]);
            },
        });
        const out = await s.safe();
        expect(out.ok).toBe(false);
        const json = JSON.stringify(out.error);
        expect(json).not.toContain(SECRET.query);
        expect(json).not.toContain(SECRET.userinfo);
        expect(JSON.stringify(await s.report())).not.toContain(SECRET.query);
    });

    test('text with no URL is returned as written', () => {
        const err = new StitchError('socket hang up');
        expect(err.toJSON().message).toBe('socket hang up');
    });
});

describe('header names the five-name denylist missed', () => {
    // Azure OpenAI, Azure API Management, RapidAPI, Google, and a session id — none on the old list.
    const VENDOR_HEADERS = [
        'api-key',
        'Ocp-Apim-Subscription-Key',
        'X-RapidAPI-Key',
        'x-goog-api-key',
        'x-session-id',
    ];
    const BENIGN = { 'accept-language': 'en', 'x-request-id': 'rid-1' };
    const secretHeaders = Object.fromEntries(
        VENDOR_HEADERS.map((h) => [h, SECRET.header]),
    );

    test('a literal config header is `[REDACTED]` on __config and report().config', async () => {
        const s = stitch({
            name: 'vendor',
            url: 'https://h.test/v',
            headers: { ...secretHeaders, ...BENIGN },
            adapter: ok(),
        });
        const expected = {
            ...Object.fromEntries(VENDOR_HEADERS.map((h) => [h, '[REDACTED]'])),
            ...BENIGN,
        };
        expect(s.__config.headers).toEqual(expected);
        expect((await s.report()).config.headers).toEqual(expected);
        expect(JSON.stringify(s.__config)).not.toContain(SECRET.header);
    });

    test('a call-time header is redacted in the JSONL file, the SSE/`run` frame and `stitch run`', async () => {
        const file = join(dir, 'vendor.jsonl');
        const s = stitch({
            name: 'vendor',
            url: 'https://h.test/v',
            adapter: ok(),
            trace: fileSink(file),
        });
        const headers = { ...secretHeaders, ...BENIGN };
        await s({ headers });

        const start = records(file).find((r) => r.type === 'start')!;
        expect(start.input?.headers).toEqual({
            ...Object.fromEntries(VENDOR_HEADERS.map((h) => [h, '[REDACTED]'])),
            ...BENIGN,
        });

        const frame = redactEventForTransport({
            type: 'start',
            name: 'vendor',
            method: 'GET',
            url: 'https://h.test/v',
            input: { headers },
            at: 0,
        });
        expect(JSON.stringify(frame)).not.toContain(SECRET.header);
        expect(JSON.stringify(frame)).toContain('rid-1');

        const lines: string[] = [];
        await runStitch(
            { vendor: s },
            'vendor',
            VENDOR_HEADERS.flatMap((h) => [`--headers.${h}`, SECRET.header]),
            (l) => lines.push(l),
        );
        expect(lines.join('\n')).not.toContain(SECRET.header);
    });

    test('a name registered with secrets.register is covered when it is registered BEFORE the stitch is built', () => {
        // `__config` is a snapshot taken when the stitch is built (a lazy read would cost core
        // bytes), so the documented ordering is: register first. The sinks read the registry live.
        secrets.register('x-acme-early-873');
        const early = stitch({
            url: 'https://h.test/v',
            headers: { 'x-acme-early-873': SECRET.header },
            adapter: ok(),
        });
        expect(early.__config.headers).toEqual({
            'x-acme-early-873': '[REDACTED]',
        });

        const late = stitch({
            url: 'https://h.test/v',
            headers: { 'x-acme-late-873': SECRET.header },
            adapter: ok(),
        });
        secrets.register('x-acme-late-873');
        expect(late.__config.headers).toEqual({
            'x-acme-late-873': SECRET.header, // the snapshot predates the registration
        });
    });
});

describe('the file sink payload walk', () => {
    // A response body full of the shapes `isSecretKey`'s stems and exact names over-match.
    const BODY = {
        usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
        max_tokens: 1000,
        tokens: 5,
        signature_valid: true,
        code: 'E_NOT_FOUND',
        key: 'cache-key-1',
        auth: 'basic',
        password: '',
        access_token: SECRET.body,
        credentials: { user: 'svc', password: SECRET.body },
        items: [{ refresh_token: SECRET.body, id: 7 }],
        at: new Date('2026-09-30T10:00:00.000Z'),
    };

    async function run(data: unknown = BODY): Promise<TraceRecord[]> {
        const file = join(
            dir,
            `payload-${Math.random().toString(36).slice(2)}.jsonl`,
        );
        const s = stitch({
            name: 'payload',
            url: 'https://h.test/p',
            adapter: ok(data),
            trace: fileSink(file),
        });
        const since = new Date('2026-09-01T00:00:00.000Z');
        await s({
            query: { since, code: 'oauth-code-873', key: 'k873', auth: 'a873' },
            body: { max_tokens: 5, key: 'a-field', password: SECRET.body },
        });
        return records(file);
    }

    test('counts and flags are kept, strings under a secret-named key are not', async () => {
        const result = (await run()).find((r) => r.type === 'result')!;
        expect(result.data).toEqual({
            usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
            max_tokens: 1000,
            tokens: 5,
            signature_valid: true,
            code: 'E_NOT_FOUND', // data in a payload…
            key: 'cache-key-1',
            auth: 'basic',
            password: '', // an empty value holds no secret
            access_token: '[REDACTED]',
            credentials: { user: '[REDACTED]', password: '[REDACTED]' }, // everything beneath a secret name
            items: [{ refresh_token: '[REDACTED]', id: 7 }],
            at: '2026-09-30T10:00:00.000Z', // a Date is its ISO string, not `{}`
        });
        expect(JSON.stringify(result)).not.toContain(SECRET.body);
    });

    // A secret-NAMED key taints everything beneath it: every non-empty string, whatever its own key
    // and however deep, an array element included. These five reached disk in the clear when only a
    // string directly under the key was redacted.
    test.each([
        [
            'an array of strings',
            { api_keys: ['A1'] },
            { api_keys: ['[REDACTED]'] },
        ],
        ['a plural token list', { tokens: ['T1'] }, { tokens: ['[REDACTED]'] }],
        [
            'refresh tokens',
            { refresh_tokens: ['R1'] },
            { refresh_tokens: ['[REDACTED]'] },
        ],
        [
            'a bag whose own keys are innocuous',
            { credentials: { pass: 'P1', key: 'K1' } },
            { credentials: { pass: '[REDACTED]', key: '[REDACTED]' } },
        ],
        [
            'an array of bags',
            { apiKeys: [{ key: 'sk-live-abc123' }] },
            { apiKeys: [{ key: '[REDACTED]' }] },
        ],
        [
            'a deep tree',
            { secrets: { a: { b: ['x', { c: 'y', n: 3 }] } } },
            {
                secrets: {
                    a: { b: ['[REDACTED]', { c: '[REDACTED]', n: 3 }] },
                },
            },
        ],
    ])(
        '%s under a secret-named key is redacted',
        async (_name, data, expected) => {
            const result = (await run(data)).find((r) => r.type === 'result')!;
            expect(result.data).toEqual(expected);
        },
    );

    test('counts, flags, null and empty strings beneath a secret-named key stay readable', async () => {
        const result = (
            await run({
                tokens: [1, 2],
                credentials: { ttl: 30, ok: true, none: null, blank: '' },
                api_keys: [],
            })
        ).find((r) => r.type === 'result')!;
        expect(result.data).toEqual({
            tokens: [1, 2],
            credentials: { ttl: 30, ok: true, none: null, blank: '' },
            api_keys: [],
        });
    });

    test('a query keeps `code` / `key` / `auth` as credentials and a Date as its ISO string', async () => {
        const start = (await run()).find((r) => r.type === 'start')!;
        expect(start.input?.query).toEqual({
            since: '2026-09-01T00:00:00.000Z',
            code: '[REDACTED]', // …but a credential in a URL query
            key: '[REDACTED]',
            auth: '[REDACTED]',
        });
        expect(start.url).toContain('code=REDACTED');
        expect(start.url).toContain('key=REDACTED');
        // The request body is a payload: `key` is a field there, `password` a secret.
        expect(start.input?.body).toEqual({
            max_tokens: 5,
            key: 'a-field',
            password: '[REDACTED]',
        });
    });

    test('the SSE / `stitch run` frame and secrets.redact keep a Date too', () => {
        const when = new Date('2026-09-30T10:00:00.000Z');
        const frame = redactEventForTransport({
            type: 'start',
            name: 'n',
            method: 'GET',
            url: 'https://h.test/p',
            input: { query: { since: when, api_key: SECRET.query } },
            at: 0,
        });
        const query = (frame as Extract<StitchEvent, { type: 'start' }>).input
            .query;
        expect(query?.['since']).toBe(when);
        expect(query?.['api_key']).toBe('[REDACTED]');
        expect(redactSecretsDeep({ at: when, token: 'x' })).toEqual({
            at: when,
            token: 'REDACTED',
        });
    });
});
